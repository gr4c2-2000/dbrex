/**
 * PostgreSQL provider, and with it RisingWave.
 *
 * RisingWave speaks the PostgreSQL wire protocol and serves `pg_catalog`, so it
 * needs no provider of its own — which is the point of having a capability
 * model instead of a `switch (kind)`. Two consequences shape the code below:
 *
 * - Introspection stays on `pg_catalog` and never calls a function like
 *   `format_type`. A type name comes from `pg_type.typname`, which both engines
 *   have. `information_schema` would have been the more standard choice and is
 *   the wrong one: PostgreSQL omits materialized views from it entirely, and in
 *   RisingWave a materialized view is the main thing anybody wants to look at.
 * - The browse tree starts at schemas, not databases. A PostgreSQL connection
 *   is bound to one database and cannot join across them, so a tree offering
 *   the others would list tables this session cannot query.
 *
 * Rows stream through `pg-cursor`: `client.query` buffers the whole result
 * before anyone sees a row, which is the memory the streaming contract exists
 * to avoid.
 */

import { Client, types as pgTypes, type FieldDef } from 'pg';
import Cursor from 'pg-cursor';
import * as tls from 'node:tls';
import {
  DbRexError,
  capabilities,
  isAbortError,
  Options,
  splitSql,
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
import { armInterrupt, type Interruption } from './interrupt';

/** Rows per chunk, matching the MySQL provider so a reader sees one policy. */
const CHUNK_ROWS = 500;

/** How to treat the connection's transport security. The `libpq` spelling. */
export const SSL_MODES = ['disable', 'require', 'verify-ca', 'verify-full'] as const;
export type SslMode = (typeof SSL_MODES)[number];

const FIELDS: readonly FieldSpec[] = [
  { name: 'host', type: 'string', description: 'Server hostname or IP address', required: true, prompt: true },
  { name: 'port', type: 'number', description: 'Port the server listens on (RisingWave uses 4566)', default: 5432, prompt: true },
  { name: 'user', type: 'string', description: 'Role to authenticate as', required: true, substitute: true, prompt: true },
  { name: 'database', type: 'string', description: 'Database to connect to (RisingWave calls its default "dev")', substitute: true, prompt: true },
  {
    name: 'sslmode',
    type: 'string',
    description: `Transport security: ${SSL_MODES.join(', ')}. Managed services require verify-full`,
    default: 'disable',
    prompt: true,
  },
];

const KEYWORDS: readonly string[] = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET',
  'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'INNER JOIN', 'CROSS JOIN',
  'LATERAL', 'ON', 'USING', 'AS', 'AND', 'OR', 'NOT', 'IN', 'LIKE', 'ILIKE',
  'BETWEEN', 'IS NULL', 'IS NOT NULL', 'DISTINCT', 'DISTINCT ON', 'COUNT',
  'SUM', 'AVG', 'MIN', 'MAX', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'WITH',
  'RECURSIVE', 'UNION', 'UNION ALL', 'INTERSECT', 'EXCEPT', 'ASC', 'DESC',
  'NULLS FIRST', 'NULLS LAST', 'COALESCE', 'NULLIF', 'GREATEST', 'LEAST',
  'CAST', 'EXTRACT', 'NOW', 'CURRENT_DATE', 'CURRENT_TIMESTAMP', 'INTERVAL',
  'DATE_TRUNC', 'TO_CHAR', 'GENERATE_SERIES', 'ARRAY_AGG', 'STRING_AGG',
  'JSONB_BUILD_OBJECT', 'OVER', 'PARTITION BY', 'ROW_NUMBER', 'RANK',
  'DENSE_RANK', 'LAG', 'LEAD', 'FILTER', 'TABLESAMPLE', 'RETURNING',
  'ON CONFLICT', 'EXPLAIN', 'ANALYZE', 'SET', 'SHOW',
  // RisingWave's own vocabulary. Harmless completions against PostgreSQL,
  // where they are either valid (MATERIALIZED VIEW) or simply never typed.
  'CREATE MATERIALIZED VIEW', 'CREATE SOURCE', 'CREATE SINK', 'CREATE TABLE',
  'EMIT ON WINDOW CLOSE', 'TUMBLE', 'HOP', 'WATERMARK FOR',
];

export const POSTGRES_CAPABILITIES: Capabilities = capabilities({
  limit: 'limit',
  // Rows are read a chunk at a time and the cursor is abandoned on the way out,
  // so the daemon's memory does not grow with the result.
  streams: true,
  // A real server-side stop needs a second connection carrying a CancelRequest.
  // `pg` does not send one, so all we own is the socket — and RisingWave does
  // not promise to honour one either. Claim no more than we do.
  cancel: 'transport',
  // `EXPLAIN` plans without executing; `EXPLAIN ANALYZE` would run the
  // statement, which is not what a validity check may do.
  explain: 'plan',
  browse: true,
  validate: true,
  // No per-query settings channel: `SET` would outlive the statement and leak
  // into everything else running on this session.
  settings: false,
  keywords: KEYWORDS,
});

/**
 * Type OIDs to names.
 *
 * `pg` hands back a numeric `dataTypeID` and nothing else, and resolving names
 * properly means querying `pg_type` for every unknown oid. These are the fixed
 * built-in oids, which both engines share; anything else shows as its oid so a
 * reader can look it up rather than being told a wrong name.
 */
const TYPE_NAMES: Readonly<Record<number, string>> = {
  16: 'bool', 17: 'bytea', 18: 'char', 19: 'name', 20: 'int8', 21: 'int2',
  23: 'int4', 25: 'text', 26: 'oid', 114: 'json', 142: 'xml', 600: 'point',
  650: 'cidr', 700: 'float4', 701: 'float8', 790: 'money', 829: 'macaddr',
  869: 'inet', 1000: 'bool[]', 1005: 'int2[]', 1007: 'int4[]', 1009: 'text[]',
  1014: 'char[]', 1015: 'varchar[]', 1016: 'int8[]', 1021: 'float4[]',
  1022: 'float8[]', 1042: 'bpchar', 1043: 'varchar', 1082: 'date',
  1083: 'time', 1114: 'timestamp', 1115: 'timestamp[]', 1182: 'date[]',
  1184: 'timestamptz', 1185: 'timestamptz[]', 1186: 'interval',
  1231: 'numeric[]', 1266: 'timetz', 1700: 'numeric', 2249: 'record',
  2950: 'uuid', 3220: 'pg_lsn', 3802: 'jsonb', 3807: 'jsonb[]',
  3904: 'int4range', 3906: 'numrange', 3908: 'tsrange', 3910: 'tstzrange',
  3912: 'daterange', 3926: 'int8range',
};

/**
 * Types handed over exactly as the server formatted them.
 *
 * A JS `Date` cannot hold `infinity`, a year outside its range, or a bare
 * `time`, and parsing one silently moves the value into the daemon's timezone —
 * the same reason the MySQL provider asks for `dateStrings`. Everything else
 * keeps `pg`'s own parsers, so a number stays a number and `--format json`
 * emits numbers rather than quoted strings.
 */
const VERBATIM_OIDS = new Set([
  1082,  // date
  1083,  // time
  1114,  // timestamp
  1184,  // timestamptz
  1186,  // interval
  1266,  // timetz
]);

export function postgresTypeName(oid: number | undefined): string {
  if (oid === undefined) return 'unknown';
  return TYPE_NAMES[oid] ?? `oid_${oid}`;
}

export function columnsOfFields(fields: readonly FieldDef[] | undefined): Column[] {
  if (!fields) return [];
  return fields.map(f => ({ name: f.name, type: postgresTypeName(f.dataTypeID) }));
}

export function quotePostgresIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Schemas nobody browses for.
 *
 * `rw_catalog` is RisingWave's own metadata and belongs here for the same
 * reason `pg_catalog` does: it is machinery, not the user's data.
 */
const SYSTEM_SCHEMAS = ['pg_catalog', 'information_schema', 'rw_catalog'];

/**
 * Relation kinds worth showing, as `pg_class.relkind`:
 * ordinary table, partitioned table, view, materialized view, foreign table.
 */
const RELKINDS = ['r', 'p', 'v', 'm', 'f'];

/** Introspection SQL for one level of the tree. Values are always bound. */
export function postgresBrowseQuery(path: readonly string[]): { sql: string; params: string[] } {
  const [schema, relation] = path;
  if (schema === undefined) {
    return {
      sql: `SELECT n.nspname
            FROM pg_catalog.pg_namespace n
            WHERE n.nspname <> ALL($1::text[]) AND n.nspname NOT LIKE 'pg_toast%'
              AND n.nspname NOT LIKE 'pg_temp%'
            ORDER BY n.nspname`,
      params: [`{${SYSTEM_SCHEMAS.join(',')}}`],
    };
  }
  if (relation === undefined) {
    return {
      sql: `SELECT c.relname, c.relkind
            FROM pg_catalog.pg_class c
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relkind = ANY($2::text[])
            ORDER BY c.relname`,
      params: [schema, `{${RELKINDS.join(',')}}`],
    };
  }
  if (path.length === 2) {
    return {
      sql: `SELECT a.attname, t.typname
            FROM pg_catalog.pg_attribute a
            JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            LEFT JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
            WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
            ORDER BY a.attnum`,
      params: [schema, relation],
    };
  }
  throw new DbRexError('not_found', `postgres has nothing below a column, asked for ${path.join('.')}`);
}

/** What a `relkind` is called in the tree, and in a detail line. */
function relationKind(relkind: string): { kind: BrowseNode['kind']; detail?: string } {
  switch (relkind) {
    case 'v': return { kind: 'view' };
    // A materialized view is a view that stores its rows. In RisingWave it is
    // also the thing a stream job produces, so saying so is worth a word.
    case 'm': return { kind: 'view', detail: 'materialized view' };
    case 'p': return { kind: 'table', detail: 'partitioned' };
    case 'f': return { kind: 'table', detail: 'foreign' };
    default: return { kind: 'table' };
  }
}

/** Shape introspection rows into tree nodes. Mirrors `postgresBrowseQuery`. */
export function postgresBrowseNodes(
  path: readonly string[],
  rows: readonly (readonly unknown[])[],
): BrowseNode[] {
  const [schema] = path;
  if (schema === undefined) {
    return rows.map(r => {
      const name = String(r[0]);
      return { kind: 'schema' as const, name, hasChildren: true, insert: quotePostgresIdent(name) };
    });
  }
  if (path.length === 1) {
    return rows.map(r => {
      const name = String(r[0]);
      const { kind, detail } = relationKind(String(r[1]));
      const qualified = `${quotePostgresIdent(schema)}.${quotePostgresIdent(name)}`;
      return {
        kind,
        name,
        ...(detail === undefined ? {} : { detail }),
        hasChildren: true,
        insert: qualified,
        query: `SELECT *\nFROM ${qualified}\nLIMIT 100`,
      };
    });
  }
  return rows.map(r => ({
    kind: 'column' as const,
    name: String(r[0]),
    detail: String(r[1] ?? ''),
    hasChildren: false,
    insert: quotePostgresIdent(String(r[0])),
  }));
}

/**
 * SQLSTATE classes, which is what makes this provider portable.
 *
 * Both engines report what they rejected as a five-character SQLSTATE, so the
 * taxonomy reads the code and never the message. The two-character class is
 * enough for most of it: `28` is always a rejected credential, `42` is always
 * the user's statement.
 */
const SQLSTATE_CLASSES: Readonly<Record<string, ErrorCode>> = {
  '08': 'network',  // connection exception
  '22': 'sql',      // data exception
  '23': 'sql',      // integrity constraint violation
  '25': 'sql',      // invalid transaction state
  '28': 'auth',     // invalid authorization specification
  '2B': 'sql',      // dependent objects still exist
  '34': 'sql',      // invalid cursor name
  '3D': 'sql',      // invalid catalog name
  '3F': 'sql',      // invalid schema name
  '42': 'sql',      // syntax error or access rule violation
  '53': 'sql',      // insufficient resources
  '54': 'sql',      // program limit exceeded
  '55': 'sql',      // object not in prerequisite state
};

/** Specific states that do not follow their class. */
const SQLSTATES: Readonly<Record<string, ErrorCode>> = {
  '57014': 'cancelled',  // query_canceled
  '57P01': 'network',    // admin_shutdown
  '57P02': 'network',    // crash_shutdown
  '57P03': 'network',    // cannot_connect_now
  '57P05': 'network',    // idle_session_timeout
};

/** Never reached the server, or lost it mid-flight: DNS, TCP, TLS. */
const NETWORK_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH',
  'ECONNRESET', 'EPIPE', 'EAI_AGAIN', 'EPROTO',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

function driverCode(e: unknown): string | undefined {
  if (!e || typeof e !== 'object') return undefined;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}

export function classifyPostgresError(e: unknown): ErrorCode {
  if (isAbortError(e)) return 'cancelled';
  const code = driverCode(e);
  if (code !== undefined) {
    const exact = SQLSTATES[code];
    if (exact !== undefined) return exact;
    if (NETWORK_CODES.has(code)) return 'network';
    const byClass = SQLSTATE_CLASSES[code.slice(0, 2)];
    if (byClass !== undefined && /^[0-9A-Z]{5}$/.test(code)) return byClass;
  }
  // `pg` reports a server that hung up with a bare message and no code at all.
  if (e instanceof Error && /terminated unexpectedly|connection terminated/i.test(e.message)) {
    return 'network';
  }
  return 'internal';
}

const HINTS: Partial<Record<ErrorCode, string>> = {
  auth: 'check the user and the password source for this connection',
  network: 'check the host, the port, sslmode and any tunnel for this connection',
};

export function postgresError(e: unknown, connection: string): DbRexError {
  if (DbRexError.is(e)) return e;
  const code = classifyPostgresError(e);
  const native = driverCode(e);
  const hint = HINTS[code];
  return DbRexError.wrap(code, e, {
    connection,
    ...(native === undefined ? {} : { nativeCode: native }),
    ...(hint === undefined ? {} : { hint }),
    retryable: code === 'network',
  });
}

/**
 * `sslmode` to what `pg` wants.
 *
 * `require` encrypts without judging the certificate, which is what it means in
 * `libpq` and what every self-signed staging server needs. The verifying modes
 * differ only in whether the hostname has to match, and the name they check is
 * the real one even when a tunnel moved the address.
 */
export function sslOptionFor(
  mode: string,
  endpoint: Endpoint,
  connection: string,
): false | tls.ConnectionOptions {
  const serverName = endpoint.tlsServerName ?? endpoint.host;
  switch (mode) {
    case 'disable': return false;
    case 'require': return { rejectUnauthorized: false };
    case 'verify-ca': return { rejectUnauthorized: true, checkServerIdentity: () => undefined };
    case 'verify-full': return { rejectUnauthorized: true, servername: serverName };
    default:
      throw new DbRexError('config', `"${mode}" is not an sslmode`, {
        connection,
        hint: `sslmode must be one of: ${SSL_MODES.join(', ')}`,
      });
  }
}

class PostgresSession implements Session {
  private closed = false;
  /** The socket was destroyed to interrupt a query; nothing more can run on it. */
  private dead = false;

  constructor(
    private readonly client: Client,
    private readonly connection: string,
  ) {}

  async *query(sql: string, options?: QueryOptions): AsyncGenerator<Chunk, QueryStats, void> {
    const started = Date.now();
    const limit = options?.rowLimit;
    const guard = armInterrupt(options, () => {
      this.dead = true;
      this.destroy();
    });

    const cursor = this.client.query(new Cursor<unknown[]>(sql, undefined, { rowMode: 'array' }));
    let columns: Column[] = [];
    let sentColumns = false;
    let rowsRead = 0;
    let truncated = false;
    let affectedRows: number | undefined;

    try {
      for (;;) {
        // One row past the limit, so `truncated` reports what happened rather
        // than inferring it from `rowsRead === limit`.
        const want = limit === undefined
          ? CHUNK_ROWS
          : Math.min(CHUNK_ROWS, limit - rowsRead + 1);
        const batch = await this.read(cursor, want);
        if (batch.columns.length > 0) columns = batch.columns;
        if (batch.affectedRows !== undefined) affectedRows = batch.affectedRows;

        let rows = batch.rows;
        if (limit !== undefined && rowsRead + rows.length > limit) {
          rows = rows.slice(0, limit - rowsRead);
          truncated = true;
        }
        rowsRead += rows.length;

        if (rows.length > 0 || !sentColumns) {
          yield sentColumns ? { rows } : { columns, rows };
          sentColumns = true;
        }
        if (truncated || batch.done) break;
      }
    } catch (e) {
      const reason = guard.reason();
      if (reason !== undefined) throw this.interrupted(reason, options);
      throw postgresError(e, this.connection);
    } finally {
      guard.disarm();
      // Abandoning a cursor leaves the statement open on the session, so the
      // next query on it would fail. Closing is best-effort: if the socket is
      // already gone there is nothing to tell the server.
      if (!this.dead) await cursor.close().catch(() => { /* session is gone */ });
    }

    return {
      elapsedMs: Date.now() - started,
      truncated,
      rowsRead,
      ...(affectedRows === undefined ? {} : { affectedRows }),
    };
  }

  async browse(path: readonly string[]): Promise<BrowseNode[]> {
    const { sql, params } = postgresBrowseQuery(path);
    return postgresBrowseNodes(path, await this.rows(sql, params));
  }

  /**
   * `EXPLAIN` plans a statement without running it.
   *
   * Only `SELECT`/`WITH` is submitted: `EXPLAIN INSERT` is valid PostgreSQL and
   * plans the write without performing it, but RisingWave does not accept it,
   * and a validity check that behaves differently per engine is worse than one
   * that checks less. Anything the server did not classify as the user's SQL is
   * a transport problem and must not become a squiggle in the editor.
   */
  async validate(sql: string): Promise<Diagnostic[]> {
    const out: Diagnostic[] = [];
    for (const statement of splitSql(sql)) {
      if (!/^\s*(select|with)\b/i.test(statement.sql)) continue;
      try {
        await this.rows(`EXPLAIN ${statement.sql}`, []);
      } catch (e) {
        if (!DbRexError.is(e) || e.code !== 'sql') throw e;
        out.push({ message: e.message, offset: statement.start, severity: 'error' });
      }
    }
    return out;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.dead) {
      this.destroy();
      return;
    }
    // A refused graceful close still has to leave no socket behind.
    await this.client.end().catch(() => this.destroy());
  }

  /** One `read`, with the field metadata and row count that came with it. */
  private read(
    cursor: Cursor<unknown[]>,
    want: number,
  ): Promise<{ rows: unknown[][]; columns: Column[]; done: boolean; affectedRows?: number }> {
    return new Promise((resolve, reject) => {
      cursor.read(want, (err, rows, result) => {
        if (err) return reject(postgresError(err, this.connection));
        const command = result?.command ?? '';
        resolve({
          rows: rows as unknown[][],
          columns: columnsOfFields(result?.fields),
          done: rows.length < want,
          // Only for statements that touched rows without returning any; a
          // SELECT's `rowCount` is just the rows already handed over.
          ...(rows.length === 0 && /^(INSERT|UPDATE|DELETE|MERGE)$/.test(command)
            ? { affectedRows: result?.rowCount ?? 0 }
            : {}),
        });
      });
    });
  }

  /** Small, bounded result sets: introspection and validation. */
  private async rows(sql: string, params: readonly string[]): Promise<unknown[][]> {
    try {
      const result = await this.client.query({ text: sql, values: [...params], rowMode: 'array' });
      return result.rows as unknown[][];
    } catch (e) {
      throw postgresError(e, this.connection);
    }
  }

  private destroy(): void {
    // `end()` waits politely for a server that may never answer. There is no
    // public destroy, and the socket is what has to go.
    const connection = (this.client as unknown as { connection?: { stream?: { destroy(): void } } }).connection;
    connection?.stream?.destroy();
  }

  private interrupted(reason: Interruption, options: QueryOptions | undefined): DbRexError {
    const message = reason === 'timeout'
      ? `query exceeded its ${options?.timeoutMs}ms deadline`
      : 'query cancelled';
    return new DbRexError(reason, message, {
      connection: this.connection,
      hint: 'the connection was dropped to stop the query; the server may still be finishing it',
    });
  }
}

export const postgresProvider: Provider = {
  id: 'postgres',
  displayName: 'PostgreSQL',
  capabilities: POSTGRES_CAPABILITIES,
  fields: FIELDS,

  async open(spec: ConnectionSpec, endpoint: Endpoint, io: ProviderIo): Promise<Session> {
    const options = new Options(spec.options, spec.name);
    const database = options.str('database');
    const ssl = sslOptionFor(options.str('sslmode') ?? 'disable', endpoint, spec.name);
    // Asked for every session and never kept: the daemon owns where it comes
    // from and how long it lives.
    const password = await io.secret({ kind: 'password' });

    const client = new Client({
      host: endpoint.host,
      port: endpoint.port,
      user: options.reqStr('user'),
      password,
      ...(database === undefined ? {} : { database }),
      ssl,
      types: {
        getTypeParser: ((oid: number, format?: unknown) => (
          VERBATIM_OIDS.has(oid)
            ? (value: string) => value
            : (pgTypes.getTypeParser as (o: number, f?: unknown) => unknown)(oid, format)
        )) as typeof pgTypes.getTypeParser,
      },
    });

    try {
      await client.connect();
    } catch (e) {
      await client.end().catch(() => { /* never connected */ });
      throw postgresError(e, spec.name);
    }

    io.log('debug', 'postgres session opened', {
      connection: spec.name, host: endpoint.host, port: endpoint.port, sslmode: options.str('sslmode'),
    });
    return new PostgresSession(client, spec.name);
  },
};
