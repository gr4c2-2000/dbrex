/**
 * MySQL provider.
 *
 * The old adapter awaited the buffered `conn.query()`, so the driver had
 * already built an array of every row before `rowLimit` sliced it — the memory
 * was spent before the limit was read. Here rows are consumed through mysql2's
 * row stream and yielded in chunks, so abandoning the generator abandons the
 * transfer.
 *
 * What this provider still cannot do is stop the *server*: MySQL has no
 * per-query cancel on the same connection, only `KILL` from a second one.
 * `cancel: 'transport'` says so out loud.
 */

import { createConnection, type Connection, type FieldPacket } from 'mysql2';
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

/**
 * Rows per chunk. Large enough that the per-chunk await does not dominate a
 * narrow result, small enough that a wide one does not stage megabytes before
 * the consumer sees its first row.
 */
const CHUNK_ROWS = 500;

const FIELDS: readonly FieldSpec[] = [
  { name: 'host', type: 'string', description: 'Server hostname or IP address', required: true, prompt: true },
  { name: 'port', type: 'number', description: 'Port the server listens on', default: 3306, prompt: true },
  { name: 'user', type: 'string', description: 'User to authenticate as', required: true, substitute: true, prompt: true },
  { name: 'database', type: 'string', description: 'Database to select on connect (optional)', substitute: true, prompt: true },
];

const KEYWORDS: readonly string[] = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET',
  'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'ON', 'AS', 'AND', 'OR', 'NOT',
  'IN', 'LIKE', 'BETWEEN', 'IS NULL', 'IS NOT NULL', 'DISTINCT', 'COUNT', 'SUM',
  'AVG', 'MIN', 'MAX', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'WITH', 'UNION',
  'ASC', 'DESC', 'STRAIGHT_JOIN', 'FOR UPDATE', 'LOCK IN SHARE MODE', 'IFNULL',
  'GROUP_CONCAT', 'NOW', 'CURDATE', 'DATE_FORMAT', 'SHOW', 'DESCRIBE', 'EXPLAIN',
];

export const MYSQL_CAPABILITIES: Capabilities = capabilities({
  limit: 'limit',
  // The stream stops reading, the server does not stop producing. Shared code
  // must keep treating a big query as a big query.
  streams: true,
  // Killing a MySQL query needs a second connection; all we own is the socket.
  cancel: 'transport',
  // `EXPLAIN` plans the statement without executing it, but it is a plan, not
  // the guaranteed-no-scan validation mode the contract means by 'validate'.
  explain: 'plan',
  browse: true,
  validate: true,
  // mysql2 has no per-query settings channel; `SET` would leak into the session.
  settings: false,
  keywords: KEYWORDS,
});

/**
 * Column type codes to names. mysql2 computes prettier names than this, but
 * only inside its `inspect` helper — the field packets handed to a caller
 * carry the raw protocol code.
 */
const TYPE_NAMES: Readonly<Record<number, string>> = {
  0: 'DECIMAL', 1: 'TINYINT', 2: 'SMALLINT', 3: 'INT', 4: 'FLOAT', 5: 'DOUBLE',
  6: 'NULL', 7: 'TIMESTAMP', 8: 'BIGINT', 9: 'MEDIUMINT', 10: 'DATE', 11: 'TIME',
  12: 'DATETIME', 13: 'YEAR', 14: 'NEWDATE', 15: 'VARCHAR', 16: 'BIT', 242: 'VECTOR',
  245: 'JSON', 246: 'DECIMAL', 247: 'ENUM', 248: 'SET', 249: 'TINYBLOB',
  250: 'MEDIUMBLOB', 251: 'LONGBLOB', 252: 'BLOB', 253: 'VARCHAR', 254: 'CHAR',
  255: 'GEOMETRY',
};

export function mysqlTypeName(code: number | undefined): string {
  if (code === undefined) return 'UNKNOWN';
  return TYPE_NAMES[code] ?? `TYPE_${code}`;
}

/** Field packets to columns. MariaDB's extended metadata wins when present. */
export function columnsOfFields(fields: readonly FieldPacket[] | undefined): Column[] {
  if (!fields) return [];
  return fields.map(f => ({
    name: f.name,
    type: f.extendedTypeName ? f.extendedTypeName.toUpperCase() : mysqlTypeName(f.columnType ?? f.type),
  }));
}

export function quoteMysqlIdent(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

const SYSTEM_SCHEMAS = ['mysql', 'information_schema', 'performance_schema', 'sys'];

/**
 * Introspection SQL for one level of the tree.
 *
 * The old `schemaQuery` interpolated the database name into the statement
 * behind an escape function that only doubled quotes; anything mysql2 would
 * have escaped differently was a bug waiting for a table named after an
 * apostrophe. These are placeholders.
 */
export function mysqlBrowseQuery(path: readonly string[]): { sql: string; params: string[] } {
  const [database, table] = path;
  if (database === undefined) {
    return {
      sql: `SELECT SCHEMA_NAME FROM information_schema.SCHEMATA
            WHERE SCHEMA_NAME NOT IN (${SYSTEM_SCHEMAS.map(() => '?').join(', ')})
            ORDER BY SCHEMA_NAME`,
      params: [...SYSTEM_SCHEMAS],
    };
  }
  if (table === undefined) {
    return {
      sql: `SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
      params: [database],
    };
  }
  if (path.length === 2) {
    return {
      sql: `SELECT COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
      params: [database, table],
    };
  }
  throw new DbRexError('not_found', `mysql has nothing below a column, asked for ${path.join('.')}`);
}

/** Shape introspection rows into tree nodes. Mirrors `mysqlBrowseQuery`. */
export function mysqlBrowseNodes(
  path: readonly string[],
  rows: readonly (readonly unknown[])[],
): BrowseNode[] {
  const [database] = path;
  if (database === undefined) {
    return rows.map(r => {
      const name = String(r[0]);
      return { kind: 'database', name, hasChildren: true, insert: quoteMysqlIdent(name) };
    });
  }
  if (path.length === 1) {
    return rows.map(r => {
      const name = String(r[0]);
      return {
        kind: String(r[1]) === 'VIEW' ? 'view' : 'table',
        name,
        hasChildren: true,
        insert: `${quoteMysqlIdent(database)}.${quoteMysqlIdent(name)}`,
        query: `SELECT *\nFROM ${quoteMysqlIdent(database)}.${quoteMysqlIdent(name)}\nLIMIT 100`,
      };
    });
  }
  return rows.map(r => {
    const name = String(r[0]);
    return { kind: 'column', name, detail: String(r[1] ?? ''), hasChildren: false, insert: quoteMysqlIdent(name) };
  });
}

/** Rejected credentials. Retrying with the same password will not help. */
const AUTH_CODES = new Set([
  'ER_ACCESS_DENIED_ERROR',
  'ER_ACCESS_DENIED_NO_PASSWORD_ERROR',
  'ER_DBACCESS_DENIED_ERROR',
  'ER_MUST_CHANGE_PASSWORD',
  'ER_MUST_CHANGE_PASSWORD_LOGIN',
  'ER_ACCOUNT_HAS_BEEN_LOCKED',
  'ER_NOT_SUPPORTED_AUTH_MODE',
  'ER_PASSWORD_NO_MATCH',
]);

/** Never reached the server, or lost it mid-flight: DNS, TCP, TLS. */
const NETWORK_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH',
  'ECONNRESET', 'EPIPE', 'EAI_AGAIN', 'EPROTO', 'PROTOCOL_CONNECTION_LOST',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'HANDSHAKE_NO_SSL_SUPPORT',
]);

function driverCode(e: unknown): string | undefined {
  if (!e || typeof e !== 'object') return undefined;
  const code = (e as { code?: unknown }).code;
  if (typeof code === 'string' && code.length > 0) return code;
  const errno = (e as { errno?: unknown }).errno;
  return typeof errno === 'number' ? String(errno) : undefined;
}

/**
 * Driver error to taxonomy. Everything the server itself rejected arrives as
 * an `ER_*` code, which is why the old regex hunt for "you have an error in
 * your sql syntax" is gone.
 */
export function classifyMysqlError(e: unknown): ErrorCode {
  if (isAbortError(e)) return 'cancelled';
  const code = driverCode(e);
  if (code !== undefined) {
    if (AUTH_CODES.has(code)) return 'auth';
    if (NETWORK_CODES.has(code)) return 'network';
    if (code === 'PROTOCOL_SEQUENCE_TIMEOUT') return 'timeout';
    if (code.startsWith('ER_')) return 'sql';
  }
  // mysql2 reports a dead socket with a bare message and `fatal`, no code.
  if (e && typeof e === 'object' && (e as { fatal?: unknown }).fatal === true) return 'network';
  return 'internal';
}

const HINTS: Partial<Record<ErrorCode, string>> = {
  auth: 'check the user and the password source for this connection',
  network: 'check the host, the port and any tunnel for this connection',
};

export function mysqlError(e: unknown, connection: string): DbRexError {
  if (DbRexError.is(e)) return e;
  const code = classifyMysqlError(e);
  const native = driverCode(e);
  const hint = HINTS[code];
  return DbRexError.wrap(code, e, {
    connection,
    ...(native === undefined ? {} : { nativeCode: native }),
    ...(hint === undefined ? {} : { hint }),
    retryable: code === 'network',
  });
}

type Interruption = 'cancelled' | 'timeout';

/**
 * Abort and deadline in one place. The reason has to be remembered: once the
 * socket is destroyed the driver reports a lost connection, and reporting a
 * cancelled query as a network failure is exactly the confusion the error
 * taxonomy exists to end.
 */
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

class MysqlSession implements Session {
  private closed = false;
  /** The socket was destroyed to interrupt a query; nothing more can run on it. */
  private dead = false;

  constructor(
    private readonly conn: Connection,
    private readonly connection: string,
  ) {}

  async *query(sql: string, options?: QueryOptions): AsyncGenerator<Chunk, QueryStats, void> {
    const started = Date.now();
    const limit = options?.rowLimit;
    const guard = armInterrupt(options, () => {
      this.dead = true;
      this.conn.destroy();
    });

    let columns: Column[] = [];
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
      const query = this.conn.query({ sql, rowsAsArray: true });
      const stream = query.stream({ highWaterMark: CHUNK_ROWS });
      stream.on('fields', (fields: FieldPacket[] | undefined) => {
        columns = columnsOfFields(fields);
      });

      for await (const row of stream) {
        // An OK packet, not a result set: `INSERT`/`UPDATE` have no rows.
        if (!Array.isArray(row)) continue;
        // Read one row past the limit so `truncated` reports what happened
        // instead of guessing from `rowsRead === limit`.
        if (limit !== undefined && rowsRead >= limit) {
          truncated = true;
          break;
        }
        pending.push(row as unknown[]);
        rowsRead++;
        if (pending.length >= CHUNK_ROWS) yield flush();
      }
      if (pending.length > 0 || !sentColumns) yield flush();
    } catch (e) {
      const reason = guard.reason();
      if (reason !== undefined) throw this.interrupted(reason, options);
      throw mysqlError(e, this.connection);
    } finally {
      guard.disarm();
    }

    return { elapsedMs: Date.now() - started, truncated, rowsRead };
  }

  async browse(path: readonly string[]): Promise<BrowseNode[]> {
    const { sql, params } = mysqlBrowseQuery(path);
    return mysqlBrowseNodes(path, await this.rows(sql, params));
  }

  /**
   * `EXPLAIN` plans a statement without running it. Only `SELECT`/`WITH` is
   * submitted: wrapping anything else would either be rejected or, worse,
   * execute. A failure that is not classified `sql` is a transport problem and
   * must not become a squiggle in the editor — the old validator decided that
   * with a regex over the message.
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
      this.conn.destroy();
      return;
    }
    await new Promise<void>(resolve => {
      this.conn.end(err => {
        // A refused graceful close still has to leave no socket behind.
        if (err) this.conn.destroy();
        resolve();
      });
    });
  }

  private interrupted(reason: Interruption, options: QueryOptions | undefined): DbRexError {
    const message = reason === 'timeout'
      ? `query exceeded its ${options?.timeoutMs}ms deadline`
      : 'query cancelled';
    return new DbRexError(reason, message, {
      connection: this.connection,
      hint: 'the MySQL connection was dropped to stop the query; the server may still be finishing it',
    });
  }

  /** Small, bounded result sets: introspection and validation. */
  private rows(sql: string, params: readonly string[]): Promise<unknown[][]> {
    return new Promise((resolve, reject) => {
      this.conn.query({ sql, values: [...params], rowsAsArray: true }, (err, result) => {
        if (err) reject(mysqlError(err, this.connection));
        else resolve(Array.isArray(result) ? (result as unknown[][]) : []);
      });
    });
  }
}

export const mysqlProvider: Provider = {
  id: 'mysql',
  displayName: 'MySQL',
  capabilities: MYSQL_CAPABILITIES,
  fields: FIELDS,

  async open(spec: ConnectionSpec, endpoint: Endpoint, io: ProviderIo): Promise<Session> {
    const options = new Options(spec.options, spec.name);
    const database = options.str('database');
    // Asked for every session and never kept: the daemon owns where it comes
    // from and how long it lives.
    const password = await io.secret({ kind: 'password' });

    const conn = createConnection({
      host: endpoint.host,
      port: endpoint.port,
      user: options.reqStr('user'),
      password,
      ...(database === undefined ? {} : { database }),
      // Dates as the server formatted them: a JS Date cannot hold '0000-00-00'
      // and silently moves everything into the daemon's timezone.
      dateStrings: true,
      // One statement per query, so a stray ';' cannot smuggle a second one.
      multipleStatements: false,
    });

    await new Promise<void>((resolve, reject) => {
      conn.connect(err => {
        if (!err) return resolve();
        conn.destroy();
        reject(mysqlError(err, spec.name));
      });
    });

    io.log('debug', 'mysql session opened', { connection: spec.name, host: endpoint.host, port: endpoint.port });
    return new MysqlSession(conn, spec.name);
  },
};
