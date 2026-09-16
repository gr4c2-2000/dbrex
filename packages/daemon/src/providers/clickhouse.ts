/**
 * ClickHouse provider.
 *
 * Two behaviours the old adapter did not have:
 *
 * 1. Rows are read from `result_set.stream()` instead of `json()`, which
 *    parsed the entire response into one array before anyone could look at it.
 * 2. Cancellation reaches the server. The client's `abort_signal` only drops
 *    the HTTP request; unless the server was configured to notice the closed
 *    socket it keeps executing. Every query therefore carries a `query_id` and
 *    an interrupted one is followed by `KILL QUERY`, which is what makes
 *    `cancel: 'server'` true rather than aspirational.
 */

import { randomUUID } from 'node:crypto';
import * as https from 'node:https';
import { createClient, type ClickHouseClient, type ClickHouseSettings } from '@clickhouse/client';
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

/** Rows per chunk; see the same constant in the MySQL provider. */
const CHUNK_ROWS = 500;

/**
 * Names and types arrive as the first two rows of this format, which is why it
 * is preferred over plain JSONCompactEachRow: one request, no separate
 * `DESCRIBE` round trip for the column header.
 */
const ROW_FORMAT = 'JSONCompactEachRowWithNamesAndTypes';

const FIELDS: readonly FieldSpec[] = [
  { name: 'host', type: 'string', description: 'Server hostname or IP address', required: true, prompt: true },
  { name: 'port', type: 'number', description: 'HTTP port (8123 plain, usually 8443 for TLS)', default: 8123, prompt: true },
  { name: 'user', type: 'string', description: 'User to authenticate as', default: 'default', substitute: true, prompt: true },
  { name: 'database', type: 'string', description: 'Database to query by default', default: 'default', substitute: true, prompt: true },
  { name: 'protocol', type: 'string', description: 'Wire protocol: http or https', default: 'http', prompt: true },
];

const KEYWORDS: readonly string[] = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET',
  'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'ON', 'AS', 'AND', 'OR', 'NOT',
  'IN', 'LIKE', 'BETWEEN', 'IS NULL', 'IS NOT NULL', 'DISTINCT', 'COUNT', 'SUM',
  'AVG', 'MIN', 'MAX', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'WITH', 'UNION',
  'ASC', 'DESC', 'PREWHERE', 'FINAL', 'ARRAY JOIN', 'LIMIT BY', 'SAMPLE',
  'SETTINGS', 'FORMAT', 'toDate', 'toDateTime', 'now', 'uniq', 'arrayJoin',
];

export const CLICKHOUSE_CAPABILITIES: Capabilities = capabilities({
  limit: 'limit',
  // Reading fewer rows is not the same as asking for fewer: the query is
  // already running server-side when the generator stops. Only a `LIMIT` in
  // the statement makes the engine do less work.
  streams: true,
  cancel: 'server',
  // `DESCRIBE (<query>)` and `EXPLAIN` analyse the statement; neither is the
  // engine's own "validate, guaranteed no scan" mode.
  explain: 'plan',
  browse: true,
  validate: true,
  settings: true,
  keywords: KEYWORDS,
});

/**
 * ClickHouse quotes identifiers with backticks and escapes with a backslash,
 * not by doubling.
 */
export function quoteClickhouseIdent(name: string): string {
  return `\`${name.replace(/\\/g, '\\\\').replace(/`/g, '\\`')}\``;
}

const SYSTEM_DATABASES = ['system', 'information_schema', 'INFORMATION_SCHEMA'];

/**
 * Introspection SQL for one level of the tree, with the identifiers bound as
 * query parameters. The old `schemaQuery` pasted them into the statement after
 * doubling quotes, which is not how ClickHouse escapes a string literal.
 */
export function clickhouseBrowseQuery(
  path: readonly string[],
): { sql: string; params: Record<string, string> } {
  const [database, table] = path;
  if (database === undefined) {
    return {
      sql: `SELECT name FROM system.databases
            WHERE name NOT IN (${SYSTEM_DATABASES.map((_, i) => `{sys${i}:String}`).join(', ')})
            ORDER BY name`,
      params: Object.fromEntries(SYSTEM_DATABASES.map((name, i) => [`sys${i}`, name])),
    };
  }
  if (table === undefined) {
    return {
      sql: `SELECT name, engine FROM system.tables
            WHERE database = {database:String} ORDER BY name`,
      params: { database },
    };
  }
  if (path.length === 2) {
    return {
      sql: `SELECT name, type FROM system.columns
            WHERE database = {database:String} AND table = {table:String} ORDER BY position`,
      params: { database, table },
    };
  }
  throw new DbRexError('not_found', `clickhouse has nothing below a column, asked for ${path.join('.')}`);
}

/** Shape introspection rows into tree nodes. Mirrors `clickhouseBrowseQuery`. */
export function clickhouseBrowseNodes(
  path: readonly string[],
  rows: readonly (readonly unknown[])[],
): BrowseNode[] {
  const [database] = path;
  if (database === undefined) {
    return rows.map(r => {
      const name = String(r[0]);
      return { kind: 'database', name, hasChildren: true, insert: quoteClickhouseIdent(name) };
    });
  }
  if (path.length === 1) {
    return rows.map(r => {
      const name = String(r[0]);
      const engine = String(r[1] ?? '');
      return {
        kind: engine.endsWith('View') ? 'view' : 'table',
        name,
        detail: engine,
        hasChildren: true,
        insert: `${quoteClickhouseIdent(database)}.${quoteClickhouseIdent(name)}`,
        query: `SELECT *\nFROM ${quoteClickhouseIdent(database)}.${quoteClickhouseIdent(name)}\nLIMIT 100`,
      };
    });
  }
  return rows.map(r => {
    const name = String(r[0]);
    return { kind: 'column', name, detail: String(r[1] ?? ''), hasChildren: false, insert: quoteClickhouseIdent(name) };
  });
}

/** The first two rows of `JSONCompactEachRowWithNamesAndTypes`. */
export function columnsOfHeader(names: readonly unknown[], types: readonly unknown[]): Column[] {
  return names.map((name, i) => ({ name: String(name), type: String(types[i] ?? 'Unknown') }));
}

/**
 * Per-query settings. The deadline is pushed down as `max_execution_time` so
 * the server stops on its own; the client-side timer is only there for a
 * transport that stops talking.
 */
export function clickhouseSettings(options: QueryOptions | undefined): Record<string, string | number | boolean> {
  const settings: Record<string, string | number | boolean> = { ...(options?.settings ?? {}) };
  if (options?.timeoutMs !== undefined && settings['max_execution_time'] === undefined) {
    settings['max_execution_time'] = Math.max(1, Math.ceil(options.timeoutMs / 1000));
  }
  return settings;
}

/** Server exception codes worth telling apart. Everything else is the user's SQL. */
/**
 * How long the HTTP client waits before giving up on a single request.
 *
 * Deliberately far beyond any interactive query: this is a backstop against a
 * dead socket, not a query budget. Query budgets come from `timeoutMs`.
 */
const CLIENT_REQUEST_TIMEOUT_MS = 3_600_000;

const SERVER_CODES: Readonly<Record<string, ErrorCode>> = {
  '192': 'auth',      // UNKNOWN_USER
  '193': 'auth',      // WRONG_PASSWORD
  '194': 'auth',      // REQUIRED_PASSWORD
  '195': 'auth',      // IP_ADDRESS_NOT_ALLOWED
  '497': 'auth',      // ACCESS_DENIED
  '516': 'auth',      // AUTHENTICATION_FAILED
  '159': 'timeout',   // TIMEOUT_EXCEEDED
  '160': 'timeout',   // TOO_SLOW
  '209': 'timeout',   // SOCKET_TIMEOUT
  '394': 'cancelled', // QUERY_WAS_CANCELLED
  '210': 'network',   // NETWORK_ERROR
  '279': 'network',   // ALL_CONNECTION_TRIES_FAILED
};

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
  if (typeof code === 'string' && code.length > 0) return code;
  return typeof code === 'number' ? String(code) : undefined;
}

/**
 * Driver error to taxonomy. `ClickHouseError.code` is the server's numeric
 * exception code as a string, so anything numeric came from the engine — which
 * is a stronger signal than the `DB::Exception` text the old validator grepped
 * for, and the text is only the fallback here.
 */
export function classifyClickhouseError(e: unknown): ErrorCode {
  if (isAbortError(e)) return 'cancelled';
  const code = driverCode(e);
  if (code !== undefined) {
    if (NETWORK_CODES.has(code)) return 'network';
    if (/^\d+$/.test(code)) return SERVER_CODES[code] ?? 'sql';
  }
  const message = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  if (message.includes('DB::Exception')) return 'sql';
  // The driver reports its own socket deadline as a bare "Timeout error." with
  // no code attached. Filed as `internal` it looked like a bug in us.
  if (/^\s*timeout error\.?\s*$/i.test(message) || message.includes('socket hang up')) return 'timeout';
  return 'internal';
}

const HINTS: Partial<Record<ErrorCode, string>> = {
  auth: 'check the user and the password source for this connection',
  network: 'check the host, the port, the protocol and any tunnel for this connection',
};

export function clickhouseError(e: unknown, connection: string): DbRexError {
  if (DbRexError.is(e)) return e;
  const code = classifyClickhouseError(e);
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
 * Offset of a syntax error inside the statement. ClickHouse reports it as a
 * 1-based character position; the contract wants a 0-based offset.
 */
export function clickhousePosition(message: string): number | undefined {
  const m = /failed at position (\d+)/.exec(message);
  if (!m?.[1]) return undefined;
  const position = Number(m[1]);
  return Number.isFinite(position) && position > 0 ? position - 1 : undefined;
}

type Interruption = 'cancelled' | 'timeout';

/** See the identical helper in the MySQL provider: the reason must outlive the abort. */
function armInterrupt(
  options: QueryOptions | undefined,
  interrupt: () => void,
): { reason: () => Interruption | undefined; disarm: () => void } {
  let reason: Interruption | undefined;
  const fire = (r: Interruption): void => {
    if (reason !== undefined) return;
    reason = r;
    interrupt();
  };
  const onAbort = (): void => fire('cancelled');
  const signal = options?.signal;
  const timer = options?.timeoutMs === undefined ? undefined : setTimeout(() => fire('timeout'), options.timeoutMs);
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) fire('cancelled');
  return {
    reason: () => reason,
    disarm: () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

class ClickhouseSession implements Session {
  private closed = false;

  constructor(
    private readonly client: ClickHouseClient,
    private readonly connection: string,
    private readonly io: ProviderIo,
  ) {}

  async *query(sql: string, options?: QueryOptions): AsyncGenerator<Chunk, QueryStats, void> {
    const started = Date.now();
    const limit = options?.rowLimit;
    const queryId = randomUUID();
    const controller = new AbortController();
    const guard = armInterrupt(options, () => controller.abort());

    let columns: Column[] = [];
    let names: unknown[] | undefined;
    let types: unknown[] | undefined;
    let pending: unknown[][] = [];
    let sentColumns = false;
    let rowsRead = 0;
    let truncated = false;

    const flush = (): Chunk => {
      const rows = pending;
      pending = [];
      if (sentColumns) return { rows };
      sentColumns = true;
      return { columns, rows };
    };

    try {
      const result = await this.client.query({
        query: sql,
        format: ROW_FORMAT,
        query_id: queryId,
        abort_signal: controller.signal,
        clickhouse_settings: clickhouseSettings(options) as ClickHouseSettings,
      });

      // Anything short of a drained response — a row limit, an abort, an error,
      // a consumer that walked away — leaves the server working on a query
      // nobody will read. Closing the stream is not enough to stop it.
      let drained = false;
      try {
        outer: for await (const batch of result.stream<unknown[]>()) {
          for (const row of batch) {
            const values = row.json();
            if (names === undefined) {
              names = values;
              continue;
            }
            if (types === undefined) {
              types = values;
              columns = columnsOfHeader(names, types);
              continue;
            }
            // Read one row past the limit so `truncated` reports what happened
            // instead of guessing from `rowsRead === limit`.
            if (limit !== undefined && rowsRead >= limit) {
              truncated = true;
              break outer;
            }
            pending.push(values);
            rowsRead++;
            if (pending.length >= CHUNK_ROWS) yield flush();
          }
        }
        drained = !truncated;
        if (pending.length > 0 || !sentColumns) yield flush();
      } finally {
        if (!drained) {
          result.close();
          await this.kill(queryId);
        }
      }
    } catch (e) {
      const reason = guard.reason();
      if (reason !== undefined) throw this.interrupted(reason, options, queryId);
      throw clickhouseError(e, this.connection);
    } finally {
      guard.disarm();
    }

    return { elapsedMs: Date.now() - started, truncated, rowsRead, nativeQueryId: queryId };
  }

  async browse(path: readonly string[]): Promise<BrowseNode[]> {
    const { sql, params } = clickhouseBrowseQuery(path);
    return clickhouseBrowseNodes(path, await this.rows(sql, params));
  }

  /**
   * `DESCRIBE (<query>)` name-resolves the statement and returns its header
   * without reading data, and unlike `EXPLAIN AST` it still parses once the
   * client has appended its `FORMAT` clause. Only `SELECT`/`WITH` is submitted,
   * and only a failure classified `sql` becomes a diagnostic — a dropped
   * connection is not a squiggle.
   */
  async validate(sql: string): Promise<Diagnostic[]> {
    const out: Diagnostic[] = [];
    for (const statement of splitSql(sql)) {
      if (!/^\s*(select|with)\b/i.test(statement.sql)) continue;
      try {
        await this.rows(`DESCRIBE (${statement.sql})`, {});
      } catch (e) {
        if (!DbRexError.is(e) || e.code !== 'sql') throw e;
        const position = clickhousePosition(e.message);
        out.push({
          message: e.message,
          offset: statement.start + (position ?? 0),
          severity: 'error',
        });
      }
    }
    return out;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.client.close();
  }

  private interrupted(reason: Interruption, options: QueryOptions | undefined, queryId: string): DbRexError {
    const message = reason === 'timeout'
      ? `query exceeded its ${options?.timeoutMs}ms deadline`
      : 'query cancelled';
    return new DbRexError(reason, message, { connection: this.connection, nativeCode: queryId });
  }

  /**
   * Best effort: the request is already gone, this is what tells the server to
   * stop. It can legitimately fail — killing needs the privilege — so it is
   * logged rather than raised over whatever made us cancel in the first place.
   */
  private async kill(queryId: string): Promise<void> {
    try {
      await this.client.command({
        query: 'KILL QUERY WHERE query_id = {id:String} ASYNC',
        query_params: { id: queryId },
      });
    } catch (e) {
      this.io.log('debug', 'clickhouse kill query failed', {
        connection: this.connection,
        queryId,
        error: String(e),
      });
    }
  }

  /** Small, bounded result sets: introspection and validation. */
  private async rows(sql: string, params: Record<string, string>): Promise<unknown[][]> {
    try {
      const result = await this.client.query({
        query: sql,
        format: 'JSONCompactEachRow',
        query_params: params,
      });
      return await result.json<unknown[]>();
    } catch (e) {
      throw clickhouseError(e, this.connection);
    }
  }
}

export const clickhouseProvider: Provider = {
  id: 'clickhouse',
  displayName: 'ClickHouse',
  capabilities: CLICKHOUSE_CAPABILITIES,
  fields: FIELDS,

  async open(spec: ConnectionSpec, endpoint: Endpoint, io: ProviderIo): Promise<Session> {
    const options = new Options(spec.options, spec.name);
    const protocol = options.str('protocol') ?? 'http';
    if (protocol !== 'http' && protocol !== 'https') {
      throw new DbRexError('config', `connection "${spec.name}" has protocol "${protocol}", expected http or https`, {
        connection: spec.name,
        hint: 'set "protocol" to http or https',
      });
    }
    // Asked for every session and never kept: the daemon owns where it comes
    // from and how long it lives.
    const password = await io.secret({ kind: 'password' });

    const client = createClient({
      url: `${protocol}://${endpoint.host}:${endpoint.port}`,
      // The driver's own default is 30 seconds, which quietly kills any query
      // that runs longer — with a bare "Timeout error." and no hint that a
      // *client* decided it. Deadlines belong to the caller: `timeoutMs` is
      // enforced here by our own timer, and a query without one runs as long as
      // the server is willing to run it.
      request_timeout: CLIENT_REQUEST_TIMEOUT_MS,
      username: options.reqStr('user'),
      password,
      database: options.reqStr('database'),
      // A tunnel moved the address, so the certificate must still be verified
      // against the real hostname rather than against localhost.
      ...(protocol === 'https' && endpoint.tlsServerName !== undefined
        ? { http_agent: new https.Agent({ servername: endpoint.tlsServerName }) }
        : {}),
    });

    // `/ping` does not check credentials; a SELECT does. Without this a wrong
    // password would only surface on the user's first real query.
    const ping = await client.ping({ select: true });
    if (!ping.success) {
      await client.close();
      throw clickhouseError(ping.error, spec.name);
    }

    io.log('debug', 'clickhouse session opened', { connection: spec.name, host: endpoint.host, port: endpoint.port });
    return new ClickhouseSession(client, spec.name, io);
  },
};
