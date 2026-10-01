/**
 * Kafka provider.
 *
 * Built in the shape of the S3 provider, because it is the same problem: data
 * with no schema of its own, and two mechanisms that share nothing but
 * credentials.
 *
 * 1. Browsing is KafkaJS — cluster metadata for the topics, and a small sample
 *    of messages per topic to work out what the fields are. Pure JavaScript, no
 *    native module, so the sidebar works the moment the connection is added.
 * 2. Querying is DuckDB. The messages a statement needs are pulled into a
 *    DuckDB table named after the topic, and then the statement runs verbatim.
 *    `SELECT * FROM events LIMIT 100` is the whole of it, which is the point:
 *    the tree hands you a statement you can read.
 *
 * What this is not: a streaming engine. Every query reads a bounded window —
 * the last `sampleMessages` of each partition by default — and nothing is kept
 * between sessions. For a topic that has to land somewhere durable and keep up,
 * the answer is an engine built for it: RisingWave's `CREATE TABLE ... WITH
 * (connector = 'kafka')`, reachable through the postgres provider.
 *
 * Why not DuckDB's own Kafka extension: `tributary` has no build for DuckDB
 * 1.5, which is what `dbrex install-duckdb` installs, and pinning DuckDB
 * backwards for one provider would hold the object store back too. It also
 * hands back a single `message BLOB` column, so a tree of fields would have to
 * be inferred here anyway — which is the part that was actually wanted.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Kafka, logLevel, type Admin, type SASLOptions } from 'kafkajs';
import {
  DbRexError,
  Options,
  capabilities,
  configDirFor,
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
import { registerKafkaCodecs } from './kafka-codecs';

/** Rows per chunk; the same constant as every other provider. */
const CHUNK_ROWS = 500;

/** Messages read per topic when inferring its fields for the tree. */
const SAMPLE_FOR_SCHEMA = 100;

/**
 * How long a bounded read may take before it gives up.
 *
 * The reason this exists at all: a consumer that is waiting for a message that
 * will never arrive looks exactly like a hung query. Every read here knows the
 * offsets it is aiming at, so this deadline only fires when the cluster stops
 * answering — but when it fires it has to say so rather than wait forever.
 */
const READ_DEADLINE_MS = 20_000;

const CONNECT_TIMEOUT_MS = 5_000;

/**
 * Message counts for the tree: when to bother, how many at once, how long.
 *
 * Kafka has no bulk "how big is every topic" call — it is one round trip per
 * topic. On a production cluster of 515 topics that measured 89 seconds done
 * sequentially, which in a sidebar is indistinguishable from a hang.
 *
 * Parallelism helps less than it looks: at 32 at a time the same cluster
 * answered 29 counts a second, and at 64 it answered 25. The ceiling is the
 * cluster and KafkaJS's per-broker connection, not our concurrency, so 515
 * topics cost about twenty seconds however they are asked for.
 *
 * So a large cluster is listed without counts at all. A tree where some topics
 * carry a count and others do not, for no reason a reader can see, is worse
 * than one that consistently shows partitions and nothing else — and the tree
 * is what was asked for. A small cluster still gets them, because there it
 * costs a second and "0 messages" is exactly what someone is looking for.
 */
const COUNT_MAX_TOPICS = 64;
const COUNT_CONCURRENCY = 32;
const COUNT_BUDGET_MS = 8_000;

export const SASL_MECHANISMS = ['plain', 'scram-sha-256', 'scram-sha-512'] as const;
export const MESSAGE_FORMATS = ['json', 'text'] as const;
export const START_POSITIONS = ['latest', 'earliest'] as const;

const FIELDS: readonly FieldSpec[] = [
  {
    name: 'brokers',
    type: 'string',
    description: 'Bootstrap brokers, comma separated: host:9092,host2:9092',
    required: true,
    prompt: true,
  },
  { name: 'user', type: 'string', description: 'SASL username; leave empty for an unauthenticated cluster', substitute: true, prompt: true },
  {
    name: 'saslMechanism',
    type: 'string',
    description: `SASL mechanism: ${SASL_MECHANISMS.join(', ')}. Ignored without a user`,
    default: 'plain',
    prompt: true,
  },
  { name: 'ssl', type: 'boolean', description: 'Wrap the connection in TLS. SASL_SSL is this plus a user', default: false, prompt: true },
  {
    name: 'format',
    type: 'string',
    description: `How a message body is read: ${MESSAGE_FORMATS.join(', ')}. json infers the fields, text keeps one column`,
    default: 'json',
    prompt: true,
  },
  {
    name: 'startPosition',
    type: 'string',
    description: `Which end of the topic to read: ${START_POSITIONS.join(', ')}`,
    default: 'latest',
    prompt: true,
  },
  {
    name: 'sampleMessages',
    type: 'number',
    description: 'Messages pulled into the table per topic, across all partitions',
    default: 1000,
    prompt: true,
  },
];

/**
 * DuckDB's dialect, because that is what runs the statement.
 *
 * No Kafka vocabulary in here: by the time a statement is written the topic is
 * a table, and `CREATE SOURCE` is a different product's idea.
 */
const KEYWORDS: readonly string[] = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET',
  'JOIN', 'LEFT JOIN', 'INNER JOIN', 'ON', 'USING', 'AS', 'AND', 'OR', 'NOT',
  'IN', 'LIKE', 'ILIKE', 'BETWEEN', 'IS NULL', 'IS NOT NULL', 'DISTINCT',
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'WITH', 'UNION ALL', 'ASC', 'DESC', 'CAST', 'TRY_CAST', 'COALESCE',
  'EPOCH_MS', 'STRFTIME', 'DATE_TRUNC', 'UNNEST', 'LIST', 'STRUCT_PACK',
  'JSON_EXTRACT', 'JSON_EXTRACT_STRING', 'TO_JSON', 'QUALIFY', 'EXCLUDE',
  'REPLACE', 'COLUMNS', 'OVER', 'PARTITION BY', 'ROW_NUMBER',
];

export const KAFKA_CAPABILITIES: Capabilities = capabilities({
  limit: 'limit',
  // DuckDB's `run()` hands back a materialised result, and the window read out
  // of Kafka is materialised before that. Both are bounded; neither streams.
  streams: false,
  // DuckDB's node-api runs a statement to completion with no cooperative
  // interrupt, exactly as the object store provider documents.
  cancel: 'none',
  explain: 'none',
  browse: true,
  // There is no plan-only check: DuckDB parses on execution, and a topic that
  // has not been read yet has no table to resolve a name against.
  validate: false,
  settings: false,
  keywords: KEYWORDS,
});

// ---------------------------------------------------------------------------
// Pure helpers. Everything that decides what gets read, what a field is called
// and what the tree says lives here, where a test can reach it without a broker.
// ---------------------------------------------------------------------------

/** Metadata columns, prefixed so a payload field is unlikely to collide. */
export const META_COLUMNS = ['_partition', '_offset', '_timestamp', '_key'] as const;

export function parseBrokers(value: string): string[] {
  const brokers = value.split(',').map(b => b.trim()).filter(b => b.length > 0);
  if (brokers.length === 0) {
    throw new DbRexError('config', 'no brokers in "brokers"', {
      hint: 'brokers is a comma-separated list of host:port',
    });
  }
  return brokers;
}

/** Escape a double-quoted DuckDB identifier. */
export function quoteKafkaIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Escape a single-quoted DuckDB string literal. */
export function quoteKafkaLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** The statement the tree offers for a topic. */
export function kafkaReadTemplate(topic: string): string {
  return `SELECT *\nFROM ${quoteKafkaIdent(topic)}\nLIMIT 100`;
}

/**
 * Which known topics a statement refers to.
 *
 * Only after `FROM` or `JOIN`, so a topic that happens to share its name with
 * a column does not cause a pointless read. This is a heuristic and says so:
 * the alternative is a SQL parser for the sake of deciding what to prefetch,
 * and a statement naming a topic in some shape this misses fails with DuckDB's
 * own "table does not exist", which is a readable thing to fail with.
 */
export function topicsInSql(sql: string, known: readonly string[]): string[] {
  const referenced = new Set<string>();
  // Three spellings, because DuckDB accepts three: a bare word, a double-quoted
  // identifier, and a single-quoted one. A topic named `order-events` cannot be
  // written bare, so the quoted forms are the normal case here, not the exotic
  // one — missing them means the topic is never read and the statement fails
  // with "table does not exist" for a topic that plainly exists.
  const pattern = /\b(?:from|join)\s+(?:"([^"]+)"|'([^']+)'|([A-Za-z_][\w.$-]*))/gi;
  for (const match of sql.matchAll(pattern)) {
    const name = match[1] ?? match[2] ?? match[3];
    if (name !== undefined && known.includes(name)) referenced.add(name);
  }
  return [...referenced];
}

/** The offsets to read from each partition, and how many messages from each. */
export function windowFor(
  watermarks: readonly { partition: number; low: string; high: string }[],
  sample: number,
  position: 'latest' | 'earliest',
): { partition: number; from: string; through: string; quota: number }[] {
  const live = watermarks
    .map(w => ({ partition: w.partition, low: BigInt(w.low), high: BigInt(w.high) }))
    .filter(w => w.high > w.low);
  if (live.length === 0) return [];

  // Water-filling, not an equal split. Kafka partitions by key, so a topic
  // where one partition holds almost everything is the normal shape rather
  // than the pathological one. An equal split would hand back a fraction of
  // the budget and call it "the last thousand messages" — the smallest
  // partitions take what they have, and what they cannot use goes to the rest.
  const quotas = new Map<number, bigint>();
  const ascending = [...live].sort((a, b) => Number((a.high - a.low) - (b.high - b.low)));
  let budget = BigInt(Math.max(0, sample));
  let left = BigInt(ascending.length);

  for (const w of ascending) {
    const available = w.high - w.low;
    const fair = left > 0n ? budget / left : 0n;
    const take = available < fair ? available : fair;
    quotas.set(w.partition, take);
    budget -= take;
    left -= 1n;
  }

  return live
    .map(w => {
      const quota = quotas.get(w.partition) ?? 0n;
      return {
        partition: w.partition,
        // `latest` is the one worth explaining: it does not mean "wait for new
        // messages", it means the last `quota` already in the partition. A
        // debugging tool that showed the oldest thousand messages of a
        // year-old topic would be answering a question nobody asked.
        from: (position === 'latest' ? w.high - quota : w.low).toString(),
        through: (w.high - 1n).toString(),
        quota: Number(quota),
      };
    })
    .filter(w => w.quota > 0);
}

export interface KafkaRecord {
  readonly partition: number;
  readonly offset: string;
  readonly timestamp: string;
  readonly key: string | undefined;
  readonly value: string;
}

/**
 * One message as the line of NDJSON that DuckDB will read.
 *
 * `json` merges the payload's own fields at the top level, because that is what
 * makes `SELECT url FROM events` work and the whole feature is about writing
 * that. A payload field named like a metadata column wins — it is the user's
 * data, and shadowing it would be worse than losing `_offset` on that topic.
 *
 * A payload that is not a JSON object has no fields to merge, so it keeps the
 * `message` column that `text` would have given it. Mixed shapes in one topic
 * are fine: DuckDB reads the missing keys as NULL.
 */
export function envelope(record: KafkaRecord, format: 'json' | 'text'): string {
  const meta = {
    _partition: record.partition,
    _offset: Number(record.offset),
    _timestamp: new Date(Number(record.timestamp)).toISOString(),
    _key: record.key ?? null,
  };

  if (format === 'json') {
    const payload = parseJsonObject(record.value);
    if (payload !== undefined) return JSON.stringify({ ...meta, ...payload });
  }
  return JSON.stringify({ ...meta, message: record.value });
}

/**
 * Unify field names that differ only in case.
 *
 * DuckDB struct field names are case-insensitive, and `union_by_name` merges
 * every line of the window into one struct. Two producers spelling the same
 * field `isWifi` and `isWiFi` are therefore a duplicate field, and read_json
 * refuses the whole window with "Duplicate name ... in struct". Its own advice
 * is `ignore_errors = true`, which answers a different question: that silently
 * drops data, and a tool whose job is showing you your data may not do that.
 *
 * So the ambiguity is removed where it is created. The first spelling seen for a
 * given field wins and later ones are rewritten to it. A field nobody spells two
 * ways is untouched, keeping its exact case, because the first spelling seen is
 * its own. Scoped per nesting path, so `payload.id` and `meta.ID` do not drag
 * each other around.
 *
 * Where one message carries both spellings, one value has to go — the same loss
 * JSON itself takes on a repeated key — so those fields are named in the log
 * rather than quietly folded.
 */
export function foldCaseCollisions(lines: readonly string[]): { lines: string[]; unified: string[] } {
  const canonical = new Map<string, string>();
  const unified = new Set<string>();

  const walk = (value: unknown, prefix: string): unknown => {
    if (Array.isArray(value)) return value.map(v => walk(v, prefix));
    if (value === null || typeof value !== 'object') return value;

    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      const slot = `${prefix}\u001f${key.toLowerCase()}`;
      const seen = canonical.get(slot);
      let name = key;
      if (seen === undefined) {
        canonical.set(slot, key);
      } else if (seen !== key) {
        name = seen;
        unified.add(prefix.length > 0 ? `${prefix}.${seen}` : seen);
      }
      out[name] = walk(nested, prefix.length > 0 ? `${prefix}.${name}` : name);
    }
    return out;
  };

  const out = lines.map(line => {
    try {
      return JSON.stringify(walk(JSON.parse(line) as unknown, ''));
    } catch {
      // Not JSON. The `text` format writes a `message` string, which has no
      // fields to collide, and a line we cannot parse is not ours to rewrite.
      return line;
    }
  });
  return { lines: out, unified: [...unified] };
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The fields of a topic, from a sample of its messages.
 *
 * Inferred here rather than by DuckDB so that expanding a topic in the tree
 * costs nothing but the sample: the 70 MB native module is still a decision the
 * user has not had to make yet. The types are advisory — the authoritative ones
 * come back with the first query, from DuckDB itself.
 */
export function inferColumns(lines: readonly string[]): Column[] {
  const seen = new Map<string, Set<string>>();
  for (const line of lines) {
    const row = parseJsonObject(line);
    if (row === undefined) continue;
    for (const [key, value] of Object.entries(row)) {
      const kinds = seen.get(key) ?? new Set<string>();
      kinds.add(jsonKind(value));
      seen.set(key, kinds);
    }
  }
  return [...seen.entries()].map(([name, kinds]) => ({ name, type: widen(kinds) }));
}

function jsonKind(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return 'BOOLEAN';
  if (typeof value === 'number') return Number.isInteger(value) ? 'BIGINT' : 'DOUBLE';
  if (typeof value === 'string') return 'VARCHAR';
  return 'JSON';
}

/** One name for a field that arrived as several shapes. */
export function widen(kinds: ReadonlySet<string>): string {
  const real = [...kinds].filter(k => k !== 'null');
  if (real.length === 0) return 'VARCHAR';
  if (real.length === 1) return real[0]!;
  // A field that is sometimes a number and sometimes a string is read as text;
  // anything involving a nested shape is read as JSON, which is what DuckDB
  // would settle on as well.
  return real.includes('JSON') ? 'JSON' : 'VARCHAR';
}

/**
 * Run `work` over `items`, a few at a time, and stop when the budget is spent.
 *
 * Whatever finished is returned; whatever did not is simply absent. Written as
 * a plain function over an injected clock so the giving-up half can be tested,
 * which is the half that would otherwise only ever run on someone's production
 * cluster.
 */
export async function gatherWithin<T, R>(
  items: readonly T[],
  work: (item: T) => Promise<R>,
  options: { concurrency: number; budgetMs: number; now?: () => number },
): Promise<Map<T, R>> {
  const now = options.now ?? Date.now;
  const deadline = now() + options.budgetMs;
  const done = new Map<T, R>();
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < items.length && now() < deadline) {
      const item = items[next++]!;
      try {
        done.set(item, await work(item));
      } catch {
        // One topic the cluster will not answer for must not take the listing
        // down with it.
      }
    }
  };

  const workers = Math.max(1, Math.min(options.concurrency, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return done;
}

export interface TopicSummary {
  readonly name: string;
  readonly partitions: number;
  /** Messages across all partitions, from the watermarks. */
  readonly messages?: number;
}

export function topicNodes(topics: readonly TopicSummary[]): BrowseNode[] {
  return [...topics]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(topic => ({
      kind: 'table' as const,
      name: topic.name,
      detail: [
        `${topic.partitions} partition${topic.partitions === 1 ? '' : 's'}`,
        ...(topic.messages === undefined ? [] : [`${topic.messages} message${topic.messages === 1 ? '' : 's'}`]),
      ].join(', '),
      hasChildren: true,
      insert: quoteKafkaIdent(topic.name),
      query: kafkaReadTemplate(topic.name),
    }));
}

export function columnNodes(columns: readonly Column[]): BrowseNode[] {
  return columns.map(column => ({
    kind: 'column' as const,
    name: column.name,
    detail: column.type,
    hasChildren: false,
    insert: quoteKafkaIdent(column.name),
  }));
}

/** The statement that turns a window of messages into a table. */
export function materializeSql(topic: string, file: string, format: 'json' | 'text'): string {
  // `union_by_name` so partitions whose messages carry different fields widen
  // into one table instead of failing on the second file shape. `format` is
  // newline-delimited because that is how the window was written.
  const reader = `read_json(${quoteKafkaLiteral(file)}, format = 'newline_delimited', union_by_name = true`;
  return `CREATE OR REPLACE TABLE ${quoteKafkaIdent(topic)} AS SELECT * FROM ${reader}${
    format === 'text' ? ", columns = {_partition: 'INTEGER', _offset: 'BIGINT', _timestamp: 'TIMESTAMP', _key: 'VARCHAR', message: 'VARCHAR'}" : ''
  })`;
}

/** An empty topic still has to become a table, or the statement cannot run. */
export function emptyTableSql(topic: string, columns: readonly Column[]): string {
  const declared = [
    '_partition INTEGER', '_offset BIGINT', '_timestamp TIMESTAMP', '_key VARCHAR',
    ...columns.filter(c => !META_COLUMNS.includes(c.name as never)).map(c => `${quoteKafkaIdent(c.name)} ${c.type}`),
  ];
  return `CREATE OR REPLACE TABLE ${quoteKafkaIdent(topic)} (${declared.join(', ')})`;
}

/** KafkaJS protocol error types that mean the credentials, not the request. */
const AUTH_TYPES = new Set([
  'SASL_AUTHENTICATION_FAILED',
  'TOPIC_AUTHORIZATION_FAILED',
  'GROUP_AUTHORIZATION_FAILED',
  'CLUSTER_AUTHORIZATION_FAILED',
  'ILLEGAL_SASL_STATE',
  'UNSUPPORTED_SASL_MECHANISM',
]);

const NOT_FOUND_TYPES = new Set([
  'UNKNOWN_TOPIC_OR_PARTITION',
  'UNKNOWN_TOPIC_ID',
]);

export function classifyKafkaError(e: unknown): ErrorCode {
  const name = e instanceof Error ? e.name : '';
  const type = (e as { type?: unknown } | undefined)?.type;

  if (typeof type === 'string') {
    if (AUTH_TYPES.has(type)) return 'auth';
    if (NOT_FOUND_TYPES.has(type)) return 'not_found';
    if (type === 'REQUEST_TIMED_OUT') return 'timeout';
  }
  switch (name) {
    case 'KafkaJSSASLAuthenticationError': return 'auth';
    case 'KafkaJSConnectionError':
    case 'KafkaJSConnectionClosedError':
    case 'KafkaJSBrokerNotFound':
    case 'KafkaJSNumberOfRetriesExceeded': return 'network';
    case 'KafkaJSRequestTimeoutError': return 'timeout';
    default: break;
  }
  // A broker that is simply not there arrives as a plain socket error.
  const code = (e as { code?: unknown } | undefined)?.code;
  if (typeof code === 'string' && /^(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ECONNRESET|EPIPE|EAI_AGAIN)$/.test(code)) {
    return 'network';
  }
  return 'internal';
}

const HINTS: Partial<Record<ErrorCode, string>> = {
  auth: 'check the user, the password source and saslMechanism for this connection',
  network: 'check brokers and ssl; every broker in the list has to be reachable from the daemon',
  timeout: 'the cluster accepted the connection but did not answer in time',
};

export function kafkaError(e: unknown, connection: string): DbRexError {
  if (DbRexError.is(e)) return e;
  const code = classifyKafkaError(e);
  const type = (e as { type?: unknown } | undefined)?.type;
  const hint = HINTS[code];
  return new DbRexError(code, messageOf(e), {
    connection,
    ...(typeof type === 'string' ? { nativeCode: type } : {}),
    ...(hint === undefined ? {} : { hint }),
    retryable: code === 'network' || code === 'timeout',
  }, e);
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

interface KafkaConfig {
  readonly connection: string;
  readonly brokers: readonly string[];
  readonly ssl: boolean;
  readonly sasl: SASLOptions | undefined;
  readonly format: 'json' | 'text';
  readonly startPosition: 'latest' | 'earliest';
  readonly sampleMessages: number;
}

class KafkaSession implements Session {
  private readonly kafka: Kafka;
  private admin: Admin | undefined;
  private duck: DuckDBConnectionLike | undefined;
  private opening: Promise<DuckDBConnectionLike> | undefined;
  /** Fields per topic, so expanding a topic twice reads the cluster once. */
  private readonly schemas = new Map<string, Column[]>();
  /** Topics already pulled into DuckDB in this session. */
  private readonly materialized = new Set<string>();
  private spool: string | undefined;

  constructor(
    private readonly config: KafkaConfig,
    private readonly io: ProviderIo,
    private readonly configDir: string,
  ) {
    // Before any client exists: a fetch that returns a compressed batch fails
    // inside KafkaJS's decoder, nowhere near where a codec could be added.
    registerKafkaCodecs();
    this.kafka = new Kafka({
      clientId: `dbrex-${config.connection}`,
      brokers: [...config.brokers],
      ssl: config.ssl,
      ...(config.sasl === undefined ? {} : { sasl: config.sasl }),
      connectionTimeout: CONNECT_TIMEOUT_MS,
      // KafkaJS logs to stdout by default, which on a daemon means logging a
      // cluster's broker list into the terminal that started it.
      logLevel: logLevel.NOTHING,
    });
  }

  async *query(sql: string, options: QueryOptions = {}): AsyncGenerator<Chunk, QueryStats, void> {
    const started = Date.now();
    const connection = await this.duckdb();

    // Whatever topics the statement names have to exist as tables before it
    // runs. Already-read ones are left alone: re-reading on every keystroke
    // would make a result change under the user for no reason they asked for.
    const topics = await this.topicNames();
    for (const topic of topicsInSql(sql, topics)) {
      if (!this.materialized.has(topic)) await this.materialize(topic);
    }

    let result;
    try {
      result = await runDuck(connection, sql);
    } catch (e) {
      throw duckError(e, this.config.connection);
    }

    const limit = options.rowLimit;
    const kept = limit !== undefined && result.rows.length > limit ? result.rows.slice(0, limit) : result.rows;

    let announced = false;
    for (let at = 0; at < kept.length || !announced; at += CHUNK_ROWS) {
      yield announced
        ? { rows: kept.slice(at, at + CHUNK_ROWS) }
        : { columns: result.columns, rows: kept.slice(at, at + CHUNK_ROWS) };
      announced = true;
    }

    return {
      elapsedMs: Date.now() - started,
      truncated: kept.length < result.rows.length,
      rowsRead: kept.length,
    };
  }

  async browse(path: readonly string[]): Promise<BrowseNode[]> {
    const [topic] = path;
    try {
      if (topic === undefined) return topicNodes(await this.topics());
      if (path.length === 1) return columnNodes(await this.schemaOf(topic));
      throw new DbRexError('not_found', `a topic has nothing below a field, asked for ${path.join('.')}`);
    } catch (e) {
      throw kafkaError(e, this.config.connection);
    }
  }

  /** Nothing to check: DuckDB parses on execution, and a topic is a table only once read. */
  async validate(_sql: string): Promise<Diagnostic[]> {
    return [];
  }

  async close(): Promise<void> {
    const duck = this.duck;
    this.duck = undefined;
    this.opening = undefined;
    duck?.closeSync?.();
    await this.admin?.disconnect().catch(() => { /* already gone */ });
    this.admin = undefined;
    // The spool held message bodies, which is to say the user's data.
    if (this.spool !== undefined) {
      fs.rmSync(this.spool, { recursive: true, force: true });
      this.spool = undefined;
    }
  }

  // ------------------------------------------------------------------ kafka

  private async connectedAdmin(): Promise<Admin> {
    if (this.admin !== undefined) return this.admin;
    const admin = this.kafka.admin();
    await admin.connect();
    this.admin = admin;
    return admin;
  }

  private async topics(): Promise<TopicSummary[]> {
    const admin = await this.connectedAdmin();
    const metadata = await admin.fetchTopicMetadata();
    // Kafka's own bookkeeping, which is not anybody's data.
    const topics = metadata.topics.filter(t => !t.name.startsWith('__'));

    const counts = topics.length > COUNT_MAX_TOPICS
      ? new Map<string, number>()
      : await gatherWithin(
        topics.map(t => t.name),
        name => this.count(name),
        { concurrency: COUNT_CONCURRENCY, budgetMs: COUNT_BUDGET_MS },
      );
    if (counts.size < topics.length) {
      this.io.log('debug', 'listed topics without every count', {
        connection: this.config.connection, topics: topics.length, counted: counts.size,
      });
    }

    return topics.map(topic => {
      const messages = counts.get(topic.name);
      return {
        name: topic.name,
        partitions: topic.partitions.length,
        ...(messages === undefined ? {} : { messages }),
      };
    });
  }

  private async count(topic: string): Promise<number> {
    const admin = await this.connectedAdmin();
    const offsets = await admin.fetchTopicOffsets(topic);
    return offsets.reduce((total, o) => total + Number(BigInt(o.high) - BigInt(o.low)), 0);
  }

  private async schemaOf(topic: string): Promise<Column[]> {
    const cached = this.schemas.get(topic);
    if (cached !== undefined) return cached;
    const lines = await this.read(topic, SAMPLE_FOR_SCHEMA);
    const columns = inferColumns(lines);
    this.schemas.set(topic, columns);
    return columns;
  }

  /**
   * A bounded window of a topic, as lines of NDJSON.
   *
   * The offsets are worked out up front from the watermarks, so this knows
   * exactly how many messages it is waiting for and can stop. KafkaJS only
   * consumes as a group member, so the group is named per session and never
   * commits: the offsets come from `seek`, never from what a group remembers.
   */
  private async read(topic: string, sample: number): Promise<string[]> {
    const admin = await this.connectedAdmin();
    const watermarks = await admin.fetchTopicOffsets(topic);
    const window = windowFor(watermarks, sample, this.config.startPosition);
    if (window.length === 0) return [];

    const consumer = this.kafka.consumer({
      groupId: `dbrex-${this.config.connection}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
      allowAutoTopicCreation: false,
    });

    const lines: string[] = [];
    const remaining = new Map(window.map(w => [w.partition, w.quota]));
    const through = new Map(window.map(w => [w.partition, BigInt(w.through)]));

    try {
      await consumer.connect();
      await consumer.subscribe({ topic, fromBeginning: true });

      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(
          () => reject(new DbRexError('timeout', `reading ${topic} took longer than ${READ_DEADLINE_MS}ms`, {
            connection: this.config.connection,
            hint: 'the cluster stopped answering partway through a bounded read',
          })),
          READ_DEADLINE_MS,
        );
        const finish = (): void => { clearTimeout(deadline); resolve(); };

        void consumer.run({
          autoCommit: false,
          eachMessage: async ({ partition, message }) => {
            const left = remaining.get(partition);
            if (left === undefined || left <= 0) return;
            lines.push(envelope({
              partition,
              offset: message.offset,
              timestamp: message.timestamp,
              key: message.key?.toString() ?? undefined,
              value: message.value?.toString() ?? '',
            }, this.config.format));
            remaining.set(partition, left - 1);

            // Done with this partition once the quota is filled or its last
            // message has been handed over, whichever comes first.
            const last = through.get(partition);
            if (left - 1 <= 0 || (last !== undefined && BigInt(message.offset) >= last)) {
              remaining.set(partition, 0);
            }
            if ([...remaining.values()].every(n => n <= 0)) finish();
          },
        }).then(() => {
          // `run` resolves once the consumer is running; seeking before that is
          // what KafkaJS discards.
          for (const w of window) consumer.seek({ topic, partition: w.partition, offset: w.from });
        }).catch(e => { clearTimeout(deadline); reject(e); });
      });
    } finally {
      await consumer.disconnect().catch(() => { /* nothing to hang up */ });
    }

    return lines;
  }

  // ----------------------------------------------------------------- duckdb

  private async materialize(topic: string): Promise<void> {
    const lines = await this.read(topic, this.config.sampleMessages);
    const connection = await this.duckdb();

    if (lines.length === 0) {
      // An empty topic is still a table, with whatever fields a previous sample
      // taught us about it, so `SELECT * FROM events` answers rather than fails.
      await connection.run(emptyTableSql(topic, this.schemas.get(topic) ?? []));
      this.materialized.add(topic);
      return;
    }

    // Spelled one way per field before DuckDB sees them, or a field two
    // producers cased differently fails the whole window.
    const { lines: spelled, unified } = foldCaseCollisions(lines);
    if (unified.length > 0) {
      this.io.log('warn', 'kafka fields differing only in case were unified', {
        connection: this.config.connection, topic, fields: unified,
      });
    }

    const file = path.join(this.spoolDir(), `${topic.replace(/[^\w.-]/g, '_')}.ndjson`);
    fs.writeFileSync(file, spelled.join('\n') + '\n', { mode: 0o600 });
    try {
      await connection.run(materializeSql(topic, file, this.config.format));
    } catch (e) {
      throw duckError(e, this.config.connection);
    } finally {
      fs.rmSync(file, { force: true });
    }

    this.materialized.add(topic);
    this.schemas.set(topic, inferColumns(spelled));
    this.io.log('debug', 'kafka topic materialised', {
      connection: this.config.connection, topic, messages: lines.length,
    });
  }

  private spoolDir(): string {
    if (this.spool === undefined) {
      this.spool = fs.mkdtempSync(path.join(os.tmpdir(), 'dbrex-kafka-'));
      fs.chmodSync(this.spool, 0o700);
    }
    return this.spool;
  }

  /** Only a query needs DuckDB, so only a query pays for finding it. */
  private duckdb(): Promise<DuckDBConnectionLike> {
    if (this.duck !== undefined) return Promise.resolve(this.duck);
    this.opening ??= (async () => {
      const duckdb = await loadDuckDB({ configDir: this.configDir });
      const instance = await duckdb.DuckDBInstance.create(':memory:');
      const connection = await instance.connect();
      this.duck = connection;
      return connection;
    })().finally(() => { this.opening = undefined; });
    return this.opening;
  }

  private async topicNames(): Promise<string[]> {
    try {
      return (await this.topics()).map(t => t.name);
    } catch (e) {
      throw kafkaError(e, this.config.connection);
    }
  }
}

interface DuckResult {
  readonly columns: Column[];
  readonly rows: unknown[][];
}

async function runDuck(connection: DuckDBConnectionLike, sql: string): Promise<DuckResult> {
  const result = await connection.run(sql);
  const names = result.columnNames();
  const types = result.columnTypes().map(t => String(t));
  const rows = await result.getRows();
  return {
    columns: names.map((name, i) => ({ name, type: types[i] ?? 'UNKNOWN' })),
    rows: rows.map(row => row.map(jsonSafe)),
  };
}

/**
 * DuckDB value to something a client can serialise.
 *
 * The same problem the object store provider has: integers arrive as `bigint`,
 * which `JSON.stringify` refuses outright.
 */
function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value !== null && typeof value === 'object' && 'toString' in value && value.constructor !== Object && !Array.isArray(value)) {
    return String(value);
  }
  return value;
}

/** A DuckDB failure. Everything it rejects here is the statement. */
export function duckError(e: unknown, connection: string): DbRexError {
  if (DbRexError.is(e)) return e;
  const message = messageOf(e);
  const missing = /Table with name (\w+) does not exist/i.exec(message);
  return new DbRexError('sql', message, {
    connection,
    ...(missing === null ? {} : {
      hint: `"${missing[1]}" is not a topic on this cluster; expand the connection to see what is`,
    }),
  });
}

export const kafkaProvider: Provider = {
  id: 'kafka',
  displayName: 'Kafka',
  capabilities: KAFKA_CAPABILITIES,
  fields: FIELDS,

  async open(spec: ConnectionSpec, _endpoint: Endpoint, io: ProviderIo): Promise<Session> {
    const options = new Options(spec.options, spec.name);
    const user = options.str('user');
    const mechanism = options.str('saslMechanism') ?? 'plain';
    if (!SASL_MECHANISMS.includes(mechanism as never)) {
      throw new DbRexError('config', `"${mechanism}" is not a SASL mechanism`, {
        connection: spec.name,
        hint: `saslMechanism must be one of: ${SASL_MECHANISMS.join(', ')}`,
      });
    }
    const format = options.str('format') ?? 'json';
    if (!MESSAGE_FORMATS.includes(format as never)) {
      throw new DbRexError('config', `"${format}" is not a message format`, {
        connection: spec.name,
        hint: `format must be one of: ${MESSAGE_FORMATS.join(', ')}`,
      });
    }
    const startPosition = options.str('startPosition') ?? 'latest';
    if (!START_POSITIONS.includes(startPosition as never)) {
      throw new DbRexError('config', `"${startPosition}" is not a start position`, {
        connection: spec.name,
        hint: `startPosition must be one of: ${START_POSITIONS.join(', ')}`,
      });
    }

    // An unauthenticated cluster is the normal case for a container on a
    // laptop, and asking for a password to reach one would be theatre.
    const sasl: SASLOptions | undefined = user === undefined
      ? undefined
      : { mechanism, username: user, password: await io.secret({ kind: 'password' }) } as SASLOptions;

    // The brokers are the ones written down, and `endpoint` is deliberately
    // unused: it is built from `host`/`port` options this provider does not
    // declare, which is also how the daemon knows not to tunnel this kind. A
    // tunnel could not work anyway — the cluster answers metadata with its own
    // advertised listeners, and the client goes there next.
    const brokers = parseBrokers(options.reqStr('brokers'));

    io.log('debug', 'kafka session opened', {
      connection: spec.name, brokers: brokers.length, ssl: options.bool('ssl') === true, sasl: sasl !== undefined,
    });

    return new KafkaSession({
      connection: spec.name,
      brokers,
      ssl: options.bool('ssl') === true,
      sasl,
      format: format as 'json' | 'text',
      startPosition: startPosition as 'latest' | 'earliest',
      sampleMessages: options.num('sampleMessages') ?? 1000,
    }, io, configDirFor({
      home: os.homedir(),
      tmpDir: os.tmpdir(),
      uid: typeof process.getuid === 'function' ? process.getuid() : 0,
    }));
  },
};
