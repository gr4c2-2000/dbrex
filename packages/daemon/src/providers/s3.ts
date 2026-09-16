/**
 * S3 / object-store provider.
 *
 * One connection, two mechanisms that share nothing but credentials:
 *
 * 1. Browsing is plain HTTPS through the AWS SDK — `ListObjectsV2` with a `/`
 *    delimiter, one level per expand. It needs no native module, so the sidebar
 *    works the moment the connection is added.
 * 2. Querying is DuckDB's `httpfs` pointed at the same endpoint. DuckDB is 70 MB
 *    of native binding, so it is resolved lazily on the first query (see
 *    `./duckdb`) and a session that only browses never loads it.
 *
 * What the old adapter claimed and this one does not: cancellation. DuckDB's
 * node-api runs a statement to completion with no cooperative interrupt, and
 * racing the promise against an abort only stops *us* waiting — the query keeps
 * burning the bucket's egress either way. That is `cancel: 'none'` here, and
 * `streams: false`, because `run()` hands back a materialised result.
 */

import * as fs from 'node:fs';
import * as https from 'node:https';
import * as os from 'node:os';
import { ListBucketsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import {
  DbRexError,
  Options,
  capabilities,
  configDirFor,
  isAbortError,
  messageOf,
  type BrowseNode,
  type Capabilities,
  type Chunk,
  type Column,
  type ConnectionSpec,
  type Diagnostic,
  type Endpoint,
  type ErrorCode,
  type FieldSpec,
  type Provider,
  type ProviderIo,
  type QueryOptions,
  type QueryStats,
  type Session,
} from '@dbrex/core';
import { loadDuckDB, type DuckDBConnectionLike } from './duckdb';

/** Rows per chunk; see the same constant in the MySQL and ClickHouse providers. */
const CHUNK_ROWS = 500;

/** Fail a listing fast instead of hanging the tree on an unreachable endpoint. */
const CONNECT_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Setup SQL. Pure, because this is where the secret is spelled out and the one
// place a mistake would be invisible until a live bucket rejected us.
// ---------------------------------------------------------------------------

export interface S3Settings {
  readonly region: string;
  /** Host or host:port, no scheme. Undefined means real AWS S3. */
  readonly endpoint: string | undefined;
  readonly pathStyle: boolean;
  readonly useSsl: boolean;
  readonly accessKeyId: string | undefined;
  readonly secretAccessKey: string | undefined;
  /** PEM bundle for an endpoint signed by a private authority. */
  readonly caCertPath?: string | undefined;
}

/** Escape a single-quoted DuckDB string literal. */
export function quoteS3Literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The statements that point DuckDB's httpfs at this endpoint.
 *
 * Emitted as a list rather than one script so a failure names the setting that
 * failed. The secret appears here and nowhere else: it is never logged, and
 * every error message this file builds goes through `redactSecret` because
 * DuckDB's parser echoes the offending line back verbatim.
 */
export function s3SetupSql(settings: S3Settings): string[] {
  const out = ['INSTALL httpfs;', 'LOAD httpfs;'];
  // A corporate object store is usually fronted by a certificate from the
  // company's own authority, which is in nobody's default trust store. Without
  // this the connection dies at the handshake, before a single byte of S3.
  if (settings.caCertPath !== undefined && settings.useSsl) {
    out.push(`SET ca_cert_file=${quoteS3Literal(settings.caCertPath)};`);
    out.push('SET enable_server_cert_verification=true;');
  }
  out.push(`SET s3_region=${quoteS3Literal(settings.region)};`);
  if (settings.endpoint !== undefined) out.push(`SET s3_endpoint=${quoteS3Literal(settings.endpoint)};`);
  out.push(`SET s3_url_style=${quoteS3Literal(settings.pathStyle ? 'path' : 'vhost')};`);
  out.push(`SET s3_use_ssl=${settings.useSsl ? 'true' : 'false'};`);
  if (settings.accessKeyId !== undefined) {
    out.push(`SET s3_access_key_id=${quoteS3Literal(settings.accessKeyId)};`);
  }
  if (settings.secretAccessKey !== undefined) {
    out.push(`SET s3_secret_access_key=${quoteS3Literal(settings.secretAccessKey)};`);
  }
  return out;
}

/**
 * Remove the secret from text that came back from the driver.
 *
 * Both spellings have to go: the raw value, and the value as it appears inside
 * the SQL literal with its quotes doubled.
 */
export function redactSecret(message: string, secret: string | undefined): string {
  if (secret === undefined || secret.length === 0) return message;
  return message
    .split(secret.replace(/'/g, "''")).join('***')
    .split(secret).join('***');
}

// ---------------------------------------------------------------------------
// Naming files
// ---------------------------------------------------------------------------

/** Pick the DuckDB reader for a key by extension. */
/**
 * Pick the reader for a key, by extension.
 *
 * Compression is stripped first, so `events.json.gz` is json and not "some
 * unknown thing, try CSV". Guessing CSV for a binary format produces one of
 * DuckDB's least helpful errors: a complaint about UTF-8 and a suggestion to
 * set the encoding, for a file that was never text.
 */
export function duckReaderFor(key: string): string {
  const k = key.toLowerCase().replace(/\.(gz|zst|bz2|br)$/, '');
  if (k.endsWith('.parquet') || k.endsWith('.pq')) return 'read_parquet';
  if (k.endsWith('.avro')) return 'read_avro';
  if (k.endsWith('.json') || k.endsWith('.ndjson') || k.endsWith('.jsonl')) return 'read_json_auto';
  // csv / tsv / txt / unknown: let DuckDB sniff a delimited file.
  return 'read_csv_auto';
}

/**
 * Extensions worth having but not worth failing over.
 *
 * `avro` became a core extension in 2025, but a machine that cannot reach the
 * extension repository should still be able to read parquet. Loading these is
 * attempted once and the failure is logged, not raised.
 */
const OPTIONAL_EXTENSIONS: readonly string[] = ['avro'];

/** A ready-to-run DuckDB SELECT over one object. */
export function s3ReadTemplate(bucket: string, key: string): string {
  return `SELECT * FROM ${duckReaderFor(key)}(${quoteS3Literal(`s3://${bucket}/${key}`)}) LIMIT 100`;
}

/** The basename of a prefix or key, for the tree label. */
export function baseName(pathLike: string): string {
  const trimmed = pathLike.replace(/\/$/, '');
  const at = trimmed.lastIndexOf('/');
  return at >= 0 ? trimmed.slice(at + 1) : trimmed;
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i] ?? 'TB'}`;
}

/**
 * Tree path back to an S3 prefix. The tree shows basenames, so the segments the
 * client hands back are exactly the path components below the bucket.
 */
export function joinPrefix(segments: readonly string[]): string {
  return segments.length === 0 ? '' : `${segments.join('/')}/`;
}

// ---------------------------------------------------------------------------
// Listing. The S3 client is behind an interface so the pagination and the
// directory-marker rule can be driven from a test without a bucket.
// ---------------------------------------------------------------------------

export interface ObjectPage {
  readonly prefixes: readonly string[];
  readonly objects: readonly { readonly key: string; readonly size: number | undefined }[];
  readonly nextToken: string | undefined;
}

export interface ObjectLister {
  buckets(): Promise<readonly string[]>;
  objects(bucket: string, prefix: string, token: string | undefined): Promise<ObjectPage>;
}

/** The fields of a `ListObjectsV2` response this provider reads. */
export interface ListObjectsV2Like {
  readonly CommonPrefixes?: readonly { readonly Prefix?: string | undefined }[] | undefined;
  readonly Contents?: readonly { readonly Key?: string | undefined; readonly Size?: number | undefined }[] | undefined;
  readonly IsTruncated?: boolean | undefined;
  readonly NextContinuationToken?: string | undefined;
}

export function objectPageOf(response: ListObjectsV2Like): ObjectPage {
  const prefixes: string[] = [];
  for (const entry of response.CommonPrefixes ?? []) {
    if (entry.Prefix !== undefined && entry.Prefix.length > 0) prefixes.push(entry.Prefix);
  }
  const objects: { key: string; size: number | undefined }[] = [];
  for (const entry of response.Contents ?? []) {
    if (entry.Key !== undefined && entry.Key.length > 0) objects.push({ key: entry.Key, size: entry.Size });
  }
  return {
    prefixes,
    objects,
    // A truncated page without a token would loop forever; treat it as the end.
    nextToken: response.IsTruncated === true ? response.NextContinuationToken : undefined,
  };
}

/**
 * One level of a bucket: sub-prefixes as folders, then objects as files.
 *
 * Pagination is drained here rather than surfaced, because a level is a single
 * expand in the tree and the contract has no cursor.
 */
export async function listLevel(
  lister: ObjectLister,
  bucket: string,
  prefix: string,
): Promise<BrowseNode[]> {
  const nodes: BrowseNode[] = [];
  let token: string | undefined;
  do {
    const page = await lister.objects(bucket, prefix, token);
    for (const child of page.prefixes) {
      nodes.push({ kind: 'container', name: baseName(child), hasChildren: true });
    }
    for (const object of page.objects) {
      // A folder created through a console is a zero-length key equal to the
      // prefix itself. It is the level we are listing, not a file in it.
      if (object.key === prefix) continue;
      nodes.push({
        kind: 'object',
        name: baseName(object.key),
        ...(object.size === undefined ? {} : { detail: humanSize(object.size) }),
        hasChildren: false,
        insert: `s3://${bucket}/${object.key}`,
        query: s3ReadTemplate(bucket, object.key),
      });
    }
    token = page.nextToken;
  } while (token !== undefined);
  return nodes;
}

/** Buckets carry the database icon, which is what tells them apart from a folder. */
export function bucketNodes(names: readonly string[]): BrowseNode[] {
  return names.map(name => ({ kind: 'database' as const, name, hasChildren: true }));
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/**
 * DuckDB value to something JSON-safe.
 *
 * Only what DuckDB specifically needs: it returns integers as `bigint`, which
 * `JSON.stringify` throws on, and wraps LIST values as `{ items: [...] }`. The
 * result store normalises everything else.
 */
export function normalizeValue(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  }
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (typeof value === 'object') {
    const items = (value as { items?: unknown }).items;
    if (Array.isArray(items)) return items.map(normalizeValue);
    // Structs, maps and the other rich types: a stable string beats a crash.
    try {
      return String(value);
    } catch {
      return null;
    }
  }
  return value;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function stringField(e: unknown, field: 'name' | 'code'): string | undefined {
  if (!e || typeof e !== 'object') return undefined;
  const value = (e as Record<string, unknown>)[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function httpStatusOf(e: unknown): number | undefined {
  if (!e || typeof e !== 'object') return undefined;
  const metadata = (e as { $metadata?: { httpStatusCode?: unknown } }).$metadata;
  const status = metadata?.httpStatusCode;
  return typeof status === 'number' ? status : undefined;
}

/** S3 error names that mean "your key is wrong", whatever status they arrive with. */
const AUTH_NAMES = new Set([
  'AccessDenied', 'AccessDeniedException', 'InvalidAccessKeyId', 'SignatureDoesNotMatch',
  'ExpiredToken', 'ExpiredTokenException', 'InvalidClientTokenId', 'CredentialsProviderError',
]);

const NOT_FOUND_NAMES = new Set(['NoSuchBucket', 'NoSuchKey', 'NotFound']);

const NETWORK_NAMES = new Set(['NetworkingError', 'TimeoutError', 'RequestTimeout']);

const NETWORK_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH',
  'ECONNRESET', 'EPIPE', 'EAI_AGAIN', 'EPROTO',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/**
 * AWS SDK failure to taxonomy.
 *
 * The name is checked before the status because a Ceph or MinIO gateway is free
 * to answer `AccessDenied` with a 400, and "check your credentials" is still the
 * useful thing to say. An unmatched 4xx is the request itself being wrong for
 * this endpoint — wrong region, vhost addressing against a path-style gateway —
 * which is a configuration problem, not a credentials one.
 */
export function classifyS3Error(e: unknown): ErrorCode {
  if (isAbortError(e)) return 'cancelled';

  const code = stringField(e, 'code');
  if (code !== undefined && NETWORK_CODES.has(code)) return 'network';

  const name = stringField(e, 'name');
  if (name !== undefined) {
    if (AUTH_NAMES.has(name)) return 'auth';
    if (NOT_FOUND_NAMES.has(name)) return 'not_found';
    if (NETWORK_NAMES.has(name)) return 'network';
  }

  const status = httpStatusOf(e);
  if (status === undefined) return 'network';
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status >= 500) return 'network';
  return 'config';
}

const S3_HINTS: Partial<Record<ErrorCode, string>> = {
  auth: 'check the access key id in "user" and the secret source for this connection',
  network: 'check the endpoint, and whether useSsl matches what it serves',
  not_found: 'the bucket or prefix does not exist for these credentials',
  config: 'check region, pathStyle and the endpoint for this connection',
};

/**
 * A message worth reading.
 *
 * The SDK reports some gateway responses as a bare `UnknownError` with no
 * message at all, which tells a user nothing. Fold in the HTTP status, which is
 * the one fact that always exists.
 */
export function describeS3Failure(e: unknown): string {
  const message = messageOf(e);
  const name = stringField(e, 'name');
  const status = httpStatusOf(e);
  const useless = message.length === 0 || message === name || message === 'UnknownError';
  if (!useless) return message;
  return status === undefined
    ? `the server refused the request (${name ?? 'no details'})`
    : `the server answered HTTP ${status} (${name ?? 'no details'})`;
}

export function s3Error(e: unknown, connection: string): DbRexError {
  if (DbRexError.is(e)) return e;
  const code = classifyS3Error(e);
  const native = stringField(e, 'name') ?? stringField(e, 'code');
  const hint = S3_HINTS[code];
  return new DbRexError(code, describeS3Failure(e), {
    connection,
    ...(native === undefined ? {} : { nativeCode: native }),
    ...(hint === undefined ? {} : { hint }),
    retryable: code === 'network',
  }, e);
}

/**
 * DuckDB failure to taxonomy.
 *
 * Everything DuckDB rejects is the user's SQL unless the message says httpfs
 * could not fetch the object, in which case the HTTP status is the real story
 * and reporting it as a syntax problem sends the user hunting in the wrong file.
 */
const DUCKDB_PATTERNS: readonly (readonly [RegExp, ErrorCode])[] = [
  [/HTTP 40[13]|Access ?Denied|InvalidAccessKeyId|SignatureDoesNotMatch|Forbidden/i, 'auth'],
  // Deliberately not a bare "not found": a binder error about a missing column
  // says exactly that, and it is the user's SQL, not a missing object.
  [/HTTP 404|NoSuchBucket|NoSuchKey/i, 'not_found'],
  [/Connection error|Could not establish|Unable to connect|getaddrinfo|ENOTFOUND|Timeout was reached|SSL|Certificate/i, 'network'],
];

export function classifyDuckdbError(e: unknown): ErrorCode {
  if (isAbortError(e)) return 'cancelled';
  const message = messageOf(e);
  for (const [pattern, code] of DUCKDB_PATTERNS) {
    if (pattern.test(message)) return code;
  }
  return 'sql';
}

const DUCKDB_HINTS: Partial<Record<ErrorCode, string>> = {
  auth: 'the object store rejected the credentials this connection signs with',
  network: 'check the endpoint and useSsl; DuckDB reaches the bucket over httpfs',
  not_found: 'check the bucket and key in the s3:// url',
};

/**
 * Wrap a DuckDB failure.
 *
 * The driver error is deliberately not carried as `cause`: DuckDB's parser
 * errors quote the offending statement back, and one of the statements this
 * provider runs is the one holding the secret access key. The redacted message
 * is all that survives.
 */
/**
 * Explanations for engine errors that describe the symptom and not the cause.
 *
 * Each of these cost someone an afternoon once. The message the engine gives is
 * kept verbatim — it is what a search engine will match — and the explanation
 * rides alongside it.
 */
const DUCKDB_EXPLANATIONS: readonly (readonly [RegExp, string])[] = [
  [
    /Cannot allocate memory for snappy/i,
    'this usually means the Avro file holds no records: an empty snappy block '
    + 'decompresses to zero bytes and the Avro reader treats that as a failed '
    + 'allocation. It is not about memory or file size. Check with: '
    + "SELECT octet_length(content) FROM read_blob('s3://…') — a header-only file "
    + 'is a couple of hundred bytes.',
  ],
  [
    /Invalid unicode \(byte sequence mismatch\)|not utf-8 encoded/i,
    'a binary file is being read as CSV. Check the extension: DbRex picks the '
    + 'reader from it, and anything unrecognised falls back to read_csv_auto.',
  ],
  [
    /Catalog Error.*read_avro|Function with name read_avro/i,
    'the avro extension is not loaded. It installs on first use and needs to '
    + 'reach the DuckDB extension repository once.',
  ],
];

export function explainDuckdbError(message: string): string | undefined {
  for (const [pattern, explanation] of DUCKDB_EXPLANATIONS) {
    if (pattern.test(message)) return explanation;
  }
  return undefined;
}

export function duckdbError(e: unknown, connection: string, secret: string | undefined): DbRexError {
  if (DbRexError.is(e)) return e;
  const code = classifyDuckdbError(e);
  const message = redactSecret(messageOf(e), secret);
  const hint = explainDuckdbError(message) ?? DUCKDB_HINTS[code];
  return new DbRexError(code, message, {
    connection,
    ...(hint === undefined ? {} : { hint }),
    retryable: code === 'network',
  });
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const FIELDS: readonly FieldSpec[] = [
  {
    name: 'endpoint',
    type: 'string',
    description: 'Object-store endpoint as host or host:port, with no scheme; leave empty for AWS S3',
    prompt: true,
  },
  {
    name: 'region',
    type: 'string',
    description: 'Region sent with every request; most S3-compatible gateways ignore it',
    default: 'us-east-1',
    prompt: true,
  },
  {
    name: 'user',
    type: 'string',
    description: 'Access key id; the matching secret access key comes from this connection\'s secret source',
    required: true,
    substitute: true,
    prompt: true,
  },
  {
    name: 'pathStyle',
    type: 'boolean',
    description: 'Address buckets as endpoint/bucket instead of bucket.endpoint; on by default for a custom endpoint',
    prompt: true,
  },
  {
    name: 'useSsl',
    type: 'boolean',
    description: 'Talk HTTPS to the endpoint',
    default: true,
    prompt: true,
  },
  {
    name: 'caCertPath',
    type: 'string',
    description: 'PEM file for a private certificate authority, when the endpoint uses one',
    substitute: true,
    prompt: true,
  },
  {
    name: 'bucket',
    type: 'string',
    description: 'Browse inside this bucket only; needed when the key may not list all buckets',
    prompt: true,
  },
];

/** DuckDB's dialect, plus the file readers that make an object queryable. */
const KEYWORDS: readonly string[] = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'HAVING', 'ORDER BY', 'LIMIT', 'OFFSET', 'WITH', 'AS',
  'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN', 'ON', 'USING', 'UNION', 'EXCEPT',
  'INTERSECT', 'DISTINCT', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'CAST', 'TRY_CAST', 'UNNEST',
  'QUALIFY', 'OVER', 'PARTITION BY', 'WINDOW', 'VALUES', 'CREATE TABLE', 'CREATE VIEW', 'DESCRIBE',
  'SUMMARIZE', 'PIVOT', 'UNPIVOT', 'EXPLAIN', 'INSTALL', 'LOAD', 'COPY', 'EXCLUDE', 'REPLACE',
  'read_parquet', 'read_csv_auto', 'read_json_auto', 'read_ndjson_auto', 'parquet_schema', 'glob',
  'list_value', 'struct_pack', 'strftime', 'strptime', 'date_trunc', 'epoch_ms',
];

export const S3_CAPABILITIES: Capabilities = capabilities({
  limit: 'limit',
  // `run()` materialises the whole result before a single row is readable, so
  // the daemon must not be told it can spool an unbounded query safely.
  streams: false,
  // The node-api has no interrupt. Abandoning the promise leaves the query
  // running inside the driver, and there is no transport to drop either.
  cancel: 'none',
  explain: 'plan',
  browse: true,
  validate: false,
  settings: false,
  keywords: KEYWORDS,
});

interface S3Config {
  readonly connection: string;
  readonly region: string;
  readonly endpoint: string | undefined;
  readonly pathStyle: boolean;
  readonly useSsl: boolean;
  readonly accessKeyId: string;
  readonly bucket: string | undefined;
  readonly caCertPath: string | undefined;
}

/**
 * The daemon's configuration directory, which is where `dbrex install-duckdb`
 * puts its copy. Resolved from the environment rather than passed in, because
 * the provider contract has no room for daemon-owned paths and importing the
 * daemon's own `configDir` from here would close an import cycle through
 * `builtin.ts`. Only `dbrexHome` and `home` matter to `configDirFor`; the rest
 * of `SocketEnvironment` belongs to the socket path.
 */
export function daemonConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return configDirFor({
    dbrexHome: env['DBREX_HOME'],
    home: os.homedir(),
    tmpDir: os.tmpdir(),
    uid: typeof process.getuid === 'function' ? process.getuid() : 0,
  });
}

class SdkLister implements ObjectLister {
  constructor(private readonly client: S3Client) {}

  async buckets(): Promise<readonly string[]> {
    let response;
    try {
      response = await this.client.send(new ListBucketsCommand({}));
    } catch (e) {
      // Listing *all* buckets is a separate permission from reading one, and a
      // gateway key scoped to a single owner is routinely denied it while
      // working perfectly for everything below. Without this the user sees a
      // flat "access denied" and concludes their key is wrong.
      if (classifyS3Error(e) === 'auth') {
        throw new DbRexError('auth', `${describeS3Failure(e)} while listing buckets`, {
          hint: 'this key may simply not be allowed to list every bucket — '
            + 'set "bucket" on this connection to start inside one you know the name of',
          nativeCode: stringField(e, 'name') ?? 'AccessDenied',
        }, e);
      }
      throw e;
    }
    const names: string[] = [];
    for (const bucket of response.Buckets ?? []) {
      if (bucket.Name !== undefined && bucket.Name.length > 0) names.push(bucket.Name);
    }
    return names;
  }

  async objects(bucket: string, prefix: string, token: string | undefined): Promise<ObjectPage> {
    const response = await this.client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      Delimiter: '/',
      ...(token === undefined ? {} : { ContinuationToken: token }),
    }));
    return objectPageOf(response);
  }
}

type Interruption = { readonly race: Promise<never> | undefined; readonly disarm: () => void };

/**
 * Turn an abort and a deadline into a promise that rejects.
 *
 * This is all cancellation can be here: the DuckDB call keeps running: what the
 * race buys is that the caller stops waiting and learns *why*. `Promise.race`
 * subscribes to this promise immediately, so a late rejection after the query
 * wins is already handled and never surfaces as an unhandled rejection.
 */
function interruption(connection: string, options: QueryOptions): Interruption {
  const signal = options.signal;
  const timeoutMs = options.timeoutMs !== undefined && options.timeoutMs > 0 ? options.timeoutMs : undefined;
  if (signal === undefined && timeoutMs === undefined) return { race: undefined, disarm: () => {} };

  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const race = new Promise<never>((_resolve, reject) => {
    const cancel = (): void => {
      reject(new DbRexError('cancelled', 'query cancelled', { connection }));
    };
    if (signal?.aborted) {
      cancel();
      return;
    }
    if (signal !== undefined) {
      onAbort = cancel;
      signal.addEventListener('abort', onAbort, { once: true });
    }
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        reject(new DbRexError('timeout', `query exceeded ${String(timeoutMs)} ms`, {
          connection,
          hint: 'raise the timeout or narrow the query; DuckDB keeps running it either way',
        }));
      }, timeoutMs);
    }
  });

  return {
    race,
    disarm: () => {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
    },
  };
}

interface DuckResult {
  readonly columns: readonly Column[];
  readonly rows: readonly (readonly unknown[])[];
}

class S3Session implements Session {
  private duck: DuckDBConnectionLike | undefined;
  /** Two queries arriving together must not build two DuckDB instances. */
  private opening: Promise<DuckDBConnectionLike> | undefined;
  private client: S3Client | undefined;
  private lister: ObjectLister | undefined;

  constructor(
    private readonly config: S3Config,
    private secret: string,
    private readonly io: ProviderIo,
    private readonly configDir: string,
  ) {}

  async *query(sql: string, options: QueryOptions = {}): AsyncGenerator<Chunk, QueryStats, void> {
    const started = Date.now();
    const connection = await this.duckdb();
    const guard = interruption(this.config.connection, options);

    let result: DuckResult;
    try {
      const run = readAll(connection, sql);
      result = guard.race === undefined ? await run : await Promise.race([run, guard.race]);
    } catch (e) {
      throw duckdbError(e, this.config.connection, this.secret);
    } finally {
      guard.disarm();
    }

    const limit = options.rowLimit;
    const kept = limit !== undefined && result.rows.length > limit ? result.rows.slice(0, limit) : result.rows;

    // The first chunk carries the columns even when there are no rows, so a
    // zero-row result still tells the client what the shape was.
    let announced = false;
    for (let at = 0; at < kept.length || !announced; at += CHUNK_ROWS) {
      const rows = kept.slice(at, at + CHUNK_ROWS);
      yield announced ? { rows } : { columns: result.columns, rows };
      announced = true;
    }

    return {
      elapsedMs: Date.now() - started,
      truncated: kept.length < result.rows.length,
      rowsRead: kept.length,
    };
  }

  async browse(path: readonly string[]): Promise<BrowseNode[]> {
    const lister = this.objects();
    try {
      // A configured bucket roots the tree inside it, which also covers a key
      // that is allowed to read objects but not to list the account's buckets.
      const rooted = this.config.bucket;
      if (rooted !== undefined) return await listLevel(lister, rooted, joinPrefix(path));

      const [bucket, ...rest] = path;
      if (bucket === undefined) return bucketNodes(await lister.buckets());
      return await listLevel(lister, bucket, joinPrefix(rest));
    } catch (e) {
      // Drop the client so the next expand builds a fresh one rather than
      // reusing one whose credentials the endpoint just rejected.
      this.client?.destroy();
      this.client = undefined;
      this.lister = undefined;
      throw s3Error(e, this.config.connection);
    }
  }

  /** DuckDB parses on execution; there is no plan-only check to offer an editor. */
  async validate(_sql: string): Promise<Diagnostic[]> {
    return [];
  }

  async close(): Promise<void> {
    const duck = this.duck;
    this.duck = undefined;
    this.opening = undefined;
    this.secret = '';
    duck?.closeSync?.();
    this.client?.destroy();
    this.client = undefined;
    this.lister = undefined;
  }

  /** Only a query needs DuckDB, so only a query pays for finding it. */
  private duckdb(): Promise<DuckDBConnectionLike> {
    const ready = this.duck;
    if (ready !== undefined) return Promise.resolve(ready);
    const pending = this.opening ?? this.openDuckDB();
    this.opening = pending;
    return pending;
  }

  private async openDuckDB(): Promise<DuckDBConnectionLike> {
    try {
      const duckdb = await loadDuckDB({ configDir: this.configDir });
      const instance = await duckdb.DuckDBInstance.create(':memory:');
      const connection = await instance.connect();
      for (const statement of s3SetupSql({
        region: this.config.region,
        endpoint: this.config.endpoint,
        pathStyle: this.config.pathStyle,
        useSsl: this.config.useSsl,
        caCertPath: this.config.caCertPath,
        accessKeyId: this.config.accessKeyId,
        secretAccessKey: this.secret,
      })) {
        await connection.run(statement);
      }

      for (const extension of OPTIONAL_EXTENSIONS) {
        try {
          await connection.run(`INSTALL ${extension};`);
          await connection.run(`LOAD ${extension};`);
        } catch (e) {
          this.io.log('warn', `could not load the ${extension} extension`, {
            connection: this.config.connection,
            error: e instanceof Error ? e.message.split('\n')[0] : String(e),
          });
        }
      }

      this.io.log('debug', 'duckdb httpfs ready', {
        connection: this.config.connection,
        endpoint: this.config.endpoint ?? 'aws',
      });
      this.duck = connection;
      return connection;
    } catch (e) {
      // A retry must be able to try again: a half-configured connection is
      // worse than none, and the next query re-runs the whole setup.
      this.opening = undefined;
      throw duckdbError(e, this.config.connection, this.secret);
    }
  }

  private objects(): ObjectLister {
    const ready = this.lister;
    if (ready !== undefined) return ready;
    const client = new S3Client({
      region: this.config.region,
      ...(this.config.endpoint === undefined
        ? {}
        : { endpoint: `${this.config.useSsl ? 'https' : 'http'}://${this.config.endpoint}` }),
      forcePathStyle: this.config.pathStyle,
      credentials: { accessKeyId: this.config.accessKeyId, secretAccessKey: this.secret },
      // The tree is interactive: two attempts and a short connect timeout beat
      // a spinner that never resolves.
      maxAttempts: 2,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: CONNECT_TIMEOUT_MS,
        requestTimeout: REQUEST_TIMEOUT_MS,
        ...(caBundle(this.config.caCertPath) === undefined
          ? {}
          : { httpsAgent: new https.Agent({ ca: caBundle(this.config.caCertPath) }) }),
      }),
    });
    this.client = client;
    const lister = new SdkLister(client);
    this.lister = lister;
    return lister;
  }
}

/**
 * Read a certificate bundle, or undefined when there is none to read.
 *
 * An unreadable file is not fatal here: the connection then fails at the
 * handshake with the error the user actually needs to see, rather than at
 * startup with one about a path.
 */
function caBundle(caCertPath: string | undefined): Buffer | undefined {
  if (caCertPath === undefined || caCertPath.length === 0) return undefined;
  try {
    return fs.readFileSync(caCertPath);
  } catch {
    return undefined;
  }
}

/** Run one statement and read it whole. `run()` materialises anyway; see `streams`. */
async function readAll(connection: DuckDBConnectionLike, sql: string): Promise<DuckResult> {
  const result = await connection.run(sql);
  const names = result.columnNames();
  const types = result.columnTypes();
  const columns: Column[] = names.map((name, i) => ({ name, type: String(types[i] ?? 'Unknown') }));
  const rows = (await result.getRows()).map(row => row.map(normalizeValue));
  return { columns, rows };
}

export const s3Provider: Provider = {
  id: 's3',
  displayName: 'S3 / object store',
  capabilities: S3_CAPABILITIES,
  fields: FIELDS,

  async open(spec: ConnectionSpec, _endpoint: Endpoint, io: ProviderIo): Promise<Session> {
    const options = new Options(spec.options, spec.name);
    const endpoint = options.str('endpoint');
    if (endpoint !== undefined && /^[a-z][a-z0-9+.-]*:\/\//i.test(endpoint)) {
      throw new DbRexError('config', `connection "${spec.name}": endpoint must be host[:port] without a scheme`, {
        connection: spec.name,
        hint: `write "${endpoint.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')}" and use useSsl to choose http or https`,
      });
    }

    const config: S3Config = {
      connection: spec.name,
      region: options.str('region') ?? 'us-east-1',
      endpoint,
      // A custom endpoint is almost always a gateway that only understands path
      // addressing, and vhost style there fails as a DNS error nobody can read.
      pathStyle: options.bool('pathStyle') ?? endpoint !== undefined,
      useSsl: options.bool('useSsl') ?? true,
      accessKeyId: options.reqStr('user'),
      bucket: options.str('bucket'),
      caCertPath: options.str('caCertPath'),
    };

    // Both halves of the connection sign requests, so the secret is resolved
    // once here rather than prompting separately on the first browse and the
    // first query.
    const secret = await io.secret({ kind: 'password' });
    return new S3Session(config, secret, io, daemonConfigDir());
  },
};
