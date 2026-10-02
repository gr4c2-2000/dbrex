/**
 * Microsoft SQL Server, and with it Azure SQL, Synapse and Fabric.
 *
 * Four products, one wire: TDS on 1433, T-SQL above it, `INFORMATION_SCHEMA`
 * underneath. So this is one provider rather than four, the same way the
 * PostgreSQL provider carries RisingWave — which is what the capability model
 * is for.
 *
 * Three things the code below is shaped by.
 *
 * 1. `TOP`, not `FETCH FIRST`. SQL Server's `FETCH` is only legal after an
 *    `OFFSET`, and `OFFSET` only after an `ORDER BY`, so appending the standard
 *    clause to an unordered SELECT is a syntax error rather than a smaller
 *    result. With a default row limit switched on that would be an error on
 *    nearly every statement, so `LimitSyntax` carries a `top` spelling and this
 *    provider declares it.
 *
 * 2. Fabric cannot use a password. Its documentation is explicit that SQL
 *    authentication is unsupported and only Entra ID identities are accepted, so
 *    the credential may be an access token rather than a password. Which one is
 *    declared per connection; where the token comes from is the daemon's
 *    business, and `secret: { from: "command" }` makes `az account get-access-token`
 *    the whole of it.
 *
 * 3. `tedious`, directly. It is a pure-JS TDS implementation with real
 *    backpressure — `pause()` and `resume()` on a request — which is what lets a
 *    large result stream instead of being collected. The `mssql` wrapper would
 *    add a connection pool this provider does not want: the daemon already owns
 *    one session per connection and decides when it closes.
 */

import { Connection, Request, TYPES, type ConnectionConfiguration } from 'tedious';
import {
  DbRexError,
  Options,
  capabilities,
  isAbortError,
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
import { armInterrupt } from './interrupt';

export const AUTH_MODES = ['password', 'token'] as const;

const FIELDS: readonly FieldSpec[] = [
  { name: 'host', type: 'string', description: 'Server hostname; for Azure SQL the full *.database.windows.net name', required: true, prompt: true },
  { name: 'port', type: 'number', description: 'Port the server listens on', default: 1433, prompt: true },
  { name: 'user', type: 'string', description: 'Login to authenticate as; ignored when auth is "token"', substitute: true, prompt: true },
  { name: 'database', type: 'string', description: 'Database to connect to', substitute: true, prompt: true },
  {
    name: 'auth',
    type: 'string',
    description: `How the credential is read: ${AUTH_MODES.join(' or ')}. Fabric and Synapse serverless accept only token`,
    default: 'password',
    prompt: true,
  },
  {
    name: 'encrypt',
    type: 'boolean',
    description: 'Encrypt the connection. Required by Azure SQL, Synapse and Fabric',
    default: true,
    prompt: true,
  },
  {
    name: 'trustServerCertificate',
    type: 'boolean',
    description: 'Accept the server certificate without verifying it. For a local container, not for a managed service',
    default: false,
    prompt: true,
  },
  { name: 'instanceName', type: 'string', description: 'Named instance, for a server that uses one instead of a port', prompt: false },
];

const KEYWORDS: readonly string[] = [
  'SELECT', 'TOP', 'FROM', 'WHERE', 'GROUP BY', 'HAVING', 'ORDER BY', 'OFFSET',
  'FETCH NEXT', 'ROWS ONLY', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN',
  'INNER JOIN', 'CROSS JOIN', 'CROSS APPLY', 'OUTER APPLY', 'ON', 'AS', 'AND',
  'OR', 'NOT', 'IN', 'LIKE', 'BETWEEN', 'IS NULL', 'IS NOT NULL', 'DISTINCT',
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'WITH', 'UNION', 'UNION ALL', 'EXCEPT', 'INTERSECT', 'ASC', 'DESC',
  'OVER', 'PARTITION BY', 'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'NTILE', 'LAG', 'LEAD',
  'ISNULL', 'COALESCE', 'CAST', 'TRY_CAST', 'CONVERT', 'TRY_CONVERT', 'FORMAT',
  'DATEADD', 'DATEDIFF', 'GETDATE', 'SYSDATETIME', 'STRING_AGG', 'IIF',
  'PIVOT', 'UNPIVOT', 'MERGE', 'OUTPUT', 'WITH (NOLOCK)',
];

export const MSSQL_CAPABILITIES: Capabilities = capabilities({
  // See the note at the top: `FETCH FIRST` without an `ORDER BY` does not parse.
  limit: 'top',
  // Rows arrive on an event and the request is paused while one is handed on,
  // so nothing accumulates.
  streams: true,
  // TDS carries an attention signal and `tedious` sends it, so the server is
  // genuinely told to stop rather than merely being hung up on.
  cancel: 'server',
  // `SET PARSEONLY ON` parses and returns without producing a plan or touching
  // data, which is what a squiggle needs and nothing more.
  explain: 'validate',
  browse: true,
  validate: true,
  settings: false,
  keywords: KEYWORDS,
});

/* ------------------------------------------------------------------ introspection */

/**
 * Introspection SQL for one level of the tree.
 *
 * `INFORMATION_SCHEMA` rather than the `sys` catalogues, because it is the one
 * surface all four products implement the same way — Synapse serverless and
 * Fabric both omit parts of `sys` that a SQL Server script would reach for.
 *
 * Parameterised, not interpolated: a schema named after an apostrophe is a bug
 * waiting in any escape function written by hand.
 */
export function mssqlBrowseQuery(path: readonly string[]): { sql: string; params: string[] } {
  const [schema, table] = path;

  if (schema === undefined) {
    return {
      sql: `SELECT s.name
            FROM sys.schemas s
            WHERE s.name NOT IN ('sys', 'INFORMATION_SCHEMA', 'guest', 'db_owner',
                                 'db_accessadmin', 'db_securityadmin', 'db_ddladmin',
                                 'db_backupoperator', 'db_datareader', 'db_datawriter',
                                 'db_denydatareader', 'db_denydatawriter')
            ORDER BY s.name`,
      params: [],
    };
  }

  if (table === undefined) {
    return {
      sql: `SELECT TABLE_NAME, TABLE_TYPE
            FROM INFORMATION_SCHEMA.TABLES
            WHERE TABLE_SCHEMA = @p1
            ORDER BY TABLE_NAME`,
      params: [schema],
    };
  }

  return {
    sql: `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, CHARACTER_MAXIMUM_LENGTH
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = @p1 AND TABLE_NAME = @p2
          ORDER BY ORDINAL_POSITION`,
    params: [schema, table],
  };
}

/** Turn one level's rows into tree nodes. */
export function mssqlBrowseNodes(path: readonly string[], rows: readonly (readonly unknown[])[]): BrowseNode[] {
  const [schema, table] = path;

  if (schema === undefined) {
    return rows.map(row => ({
      kind: 'schema' as const,
      name: String(row[0]),
      hasChildren: true,
      insert: quoteMssqlIdent(String(row[0])),
    }));
  }

  if (table === undefined) {
    return rows.map(row => {
      const name = String(row[0]);
      const view = String(row[1]).toUpperCase() === 'VIEW';
      const qualified = `${quoteMssqlIdent(schema)}.${quoteMssqlIdent(name)}`;
      return {
        kind: view ? ('view' as const) : ('table' as const),
        name,
        hasChildren: true,
        insert: qualified,
        query: `SELECT TOP 100 *\nFROM ${qualified}`,
      };
    });
  }

  return rows.map(row => {
    const length = row[3];
    const type = String(row[1]) + (typeof length === 'number' && length > 0 ? `(${length})` : '');
    return {
      kind: 'column' as const,
      name: String(row[0]),
      hasChildren: false,
      detail: String(row[2]).toUpperCase() === 'YES' ? `${type} NULL` : `${type} NOT NULL`,
      insert: quoteMssqlIdent(String(row[0])),
    };
  });
}

/**
 * Quote an identifier the way T-SQL does.
 *
 * Brackets rather than double quotes: `QUOTED_IDENTIFIER` can be off on a
 * connection, and brackets mean the same thing either way. A `]` inside a name
 * is doubled.
 */
export function quoteMssqlIdent(name: string): string {
  return `[${name.replace(/]/g, ']]')}]`;
}

/* ------------------------------------------------------------------ errors */

/**
 * A SQL Server failure, classified by its own error number.
 *
 * The number is the part worth keeping: it is stable across versions and
 * languages, and it is what a user can search for. A message alone is
 * localised and a status code does not exist on this wire.
 */
export function mssqlError(e: unknown, connection: string): DbRexError {
  if (DbRexError.is(e)) return e;
  if (isAbortError(e)) return new DbRexError('cancelled', 'query cancelled', { connection }, e);

  const error = e as { number?: unknown; code?: unknown; message?: unknown };
  const number = typeof error.number === 'number' ? error.number : undefined;
  const code = typeof error.code === 'string' ? error.code : undefined;
  const message = typeof error.message === 'string' ? error.message : String(e);

  const classified = classifyMssql(number, code);
  return new DbRexError(classified, message, {
    connection,
    ...(number === undefined ? { ...(code === undefined ? {} : { nativeCode: code }) } : { nativeCode: String(number) }),
    ...(mssqlHint(classified, number) === undefined ? {} : { hint: mssqlHint(classified, number)! }),
    retryable: classified === 'network',
  }, e);
}

/** Login failures, which are the ones worth naming rather than guessing at. */
const AUTH_NUMBERS = new Set([
  18456, // Login failed for user
  18452, // Login failed; the login is from an untrusted domain
  4060,  // Cannot open database requested by the login
  40615, // Azure SQL: client IP is not allowed by the firewall
]);

const NOT_FOUND_NUMBERS = new Set([
  208,  // Invalid object name
  2812, // Could not find stored procedure
  911,  // Database does not exist
]);

const TRANSPORT_CODES = new Set([
  'ESOCKET', 'ETIMEOUT', 'ECONNRESET', 'ENOTFOUND', 'ECONNREFUSED', 'EHOSTUNREACH', 'EPROTOCOL',
]);

export function classifyMssql(number?: number, code?: string): ErrorCode {
  if (code !== undefined && TRANSPORT_CODES.has(code)) {
    return code === 'ETIMEOUT' ? 'timeout' : 'network';
  }
  if (number !== undefined) {
    if (AUTH_NUMBERS.has(number)) return 'auth';
    if (NOT_FOUND_NUMBERS.has(number)) return 'not_found';
    if (number === 229 || number === 230 || number === 297) return 'forbidden';
    // Everything a parser or a binder rejects lands in this band.
    if (number >= 100) return 'sql';
  }
  return 'sql';
}

function mssqlHint(code: ErrorCode, number?: number): string | undefined {
  if (number === 40615) return 'add this client IP to the server firewall rules in Azure';
  if (number === 4060) return 'check the "database" option; the login may have no access to it';
  if (number === 18456) return 'check the login and password, or set auth to "token" for Fabric and Entra-only servers';
  if (code === 'auth') return 'check the credentials for this connection';
  if (code === 'network') return 'check the host and port, and whether the server requires encryption';
  return undefined;
}

/* ------------------------------------------------------------------ session */

interface Config {
  readonly connection: string;
  readonly database: string | undefined;
}

/** Rows handed over in batches, so a chunk is not one row of overhead each. */
const CHUNK_ROWS = 500;

class MssqlSession implements Session {
  private closed = false;

  constructor(
    private readonly conn: Connection,
    private readonly config: Config,
    private readonly io: ProviderIo,
  ) {}

  async *query(sql: string, options: QueryOptions = {}): AsyncGenerator<Chunk, QueryStats, void> {
    const started = Date.now();
    const limit = options.rowLimit ?? Number.POSITIVE_INFINITY;

    let columns: Column[] = [];
    let sent = 0;
    let truncated = false;
    let affected: number | undefined;

    for await (const batch of this.rows(sql, options)) {
      if (batch.columns !== undefined) columns = batch.columns;
      if (batch.affected !== undefined) affected = batch.affected;
      if (batch.rows === undefined) continue;

      const room = limit - sent;
      const rows = batch.rows.length > room ? batch.rows.slice(0, Math.max(0, room)) : batch.rows;
      if (rows.length < batch.rows.length) truncated = true;

      if (sent === 0) yield { columns, rows };
      else if (rows.length > 0) yield { rows };
      sent += rows.length;

      if (sent >= limit) { truncated = true; break; }
    }

    // A statement that returned no result set at all still has to announce its
    // columns, or a caller cannot tell an empty SELECT from a failed one.
    if (sent === 0) yield { columns, rows: [] };

    return {
      elapsedMs: Date.now() - started,
      truncated,
      rowsRead: sent,
      ...(affected === undefined ? {} : { affectedRows: affected }),
    };
  }

  /**
   * Rows off the wire, paused between batches.
   *
   * `tedious` pushes rows at whatever rate the server sends them. Pausing the
   * request while a batch is handed to the consumer is what makes this provider
   * honest about `streams: true`: without it the generator is a formality and
   * the whole result is already in memory.
   */
  private rows(
    sql: string,
    options: QueryOptions,
  ): AsyncGenerator<{ columns?: Column[]; rows?: unknown[][]; affected?: number }, void, void> {
    // The shared helper owns the deadline, the abort listener and — the part
    // that matters — remembering why the query stopped, so a cancellation is
    // not reported afterwards as a lost connection.
    const interrupt = armInterrupt(options, () => this.conn.cancel());
    const queue: { columns?: Column[]; rows?: unknown[][]; affected?: number }[] = [];
    let done = false;
    let failure: unknown;
    let wake: (() => void) | undefined;

    const push = (item: { columns?: Column[]; rows?: unknown[][]; affected?: number }): void => {
      queue.push(item);
      wake?.();
    };

    let pending: unknown[][] = [];
    const flush = (): void => {
      if (pending.length === 0) return;
      push({ rows: pending });
      pending = [];
    };

    const request = new Request(sql, (err, rowCount) => {
      flush();
      if (err) failure = err;
      else if (rowCount !== undefined) push({ affected: rowCount });
      done = true;
      interrupt.disarm();
      wake?.();
    });

    request.on('columnMetadata', metadata => {
      const list = (Array.isArray(metadata) ? metadata : Object.values(metadata)) as ColumnMetadataLike[];
      push({ columns: list.map(toColumn) });
    });

    request.on('row', values => {
      const list = (Array.isArray(values) ? values : Object.values(values)) as { value: unknown }[];
      pending.push(list.map(v => v.value));
      if (pending.length >= CHUNK_ROWS) {
        request.pause();
        flush();
      }
    });

    this.conn.execSql(request);

    const self = this;
    return (async function* walk() {
      try {
        for (;;) {
          while (queue.length > 0) {
            const item = queue.shift()!;
            yield item;
            // Resumed only once the consumer has taken the batch.
            request.resume();
          }
          if (failure !== undefined) throw mssqlError(failure, self.config.connection);
          if (done) return;
          await new Promise<void>(resolve => { wake = resolve; });
          wake = undefined;
        }
      } finally {
        interrupt.disarm();
        const reason = interrupt.reason();
        if (reason !== undefined && failure === undefined) {
          throw new DbRexError(
            reason === 'timeout' ? 'timeout' : 'cancelled',
            reason === 'timeout' ? 'query exceeded its deadline' : 'query cancelled',
            { connection: self.config.connection },
          );
        }
      }
    })();
  }

  async browse(path: readonly string[]): Promise<BrowseNode[]> {
    const { sql, params } = mssqlBrowseQuery(path);
    return mssqlBrowseNodes(path, await this.collect(sql, params));
  }

  /**
   * Parse the statement and report what the server said, without running it.
   *
   * `SET PARSEONLY ON` is a parse and nothing else — no plan, no data read — so
   * it is safe to run on every pause in an editor. It catches syntax, not names:
   * an unknown table is a binder error that only a compile would find.
   */
  async validate(sql: string): Promise<Diagnostic[]> {
    try {
      await this.collect(`SET PARSEONLY ON;\n${sql}\nSET PARSEONLY OFF;`, []);
      return [];
    } catch (e) {
      if (!DbRexError.is(e) || e.code !== 'sql') return [];
      return [{ message: e.message, severity: 'error' }];
    }
  }

  /** A small internal query, collected whole. Only for introspection. */
  private collect(sql: string, params: readonly string[]): Promise<unknown[][]> {
    return new Promise((resolve, reject) => {
      const rows: unknown[][] = [];
      const request = new Request(sql, err => {
        if (err) reject(mssqlError(err, this.config.connection));
        else resolve(rows);
      });
      for (const [i, value] of params.entries()) {
        // Named `p1`, `p2` to match the placeholders the browse SQL uses.
        request.addParameter(`p${i + 1}`, TYPES.NVarChar, value);
      }
      request.on('row', values => {
        const list = (Array.isArray(values) ? values : Object.values(values)) as { value: unknown }[];
        rows.push(list.map(v => v.value));
      });
      this.conn.execSql(request);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await new Promise<void>(resolve => {
      this.conn.once('end', () => resolve());
      this.conn.close();
    });
    this.io.log('debug', 'mssql session closed', { connection: this.config.connection });
  }
}

/**
 * The part of a column's metadata this needs.
 *
 * Declared here because `tedious` does not export the type, and depending on a
 * shape it keeps to itself is worse than naming the two fields actually read.
 */
interface ColumnMetadataLike {
  readonly colName: string;
  readonly type?: { readonly name?: unknown };
}

function toColumn(metadata: ColumnMetadataLike): Column {
  const type = metadata.type?.name;
  return {
    name: metadata.colName,
    type: typeof type === 'string' ? type.toUpperCase() : 'UNKNOWN',
  };
}

/* ------------------------------------------------------------------ provider */

export const mssqlProvider: Provider = {
  id: 'mssql',
  displayName: 'SQL Server / Azure SQL / Synapse / Fabric',
  capabilities: MSSQL_CAPABILITIES,
  fields: FIELDS,

  async open(spec: ConnectionSpec, endpoint: Endpoint, io: ProviderIo): Promise<Session> {
    const options = new Options(spec.options, spec.name);
    const auth = options.str('auth') ?? 'password';
    if (auth !== 'password' && auth !== 'token') {
      throw new DbRexError('config', `"${auth}" is not an authentication mode`, {
        connection: spec.name,
        hint: `auth must be one of: ${AUTH_MODES.join(', ')}`,
      });
    }

    const database = options.str('database');
    // Asked for every session and never kept: the daemon owns where it comes
    // from and how long it lives. For `token` the same slot carries a bearer
    // token, which is what Fabric and an Entra-only server accept instead.
    const credential = await io.secret(
      auth === 'token' ? { kind: 'token', label: 'Entra ID access token' } : { kind: 'password' },
    );

    const config: ConnectionConfiguration = {
      server: endpoint.host,
      authentication: auth === 'token'
        ? { type: 'azure-active-directory-access-token', options: { token: credential } }
        : { type: 'default', options: { userName: options.str('user'), password: credential } },
      options: {
        port: endpoint.port,
        ...(database === undefined ? {} : { database }),
        ...(options.str('instanceName') === undefined ? {} : { instanceName: options.str('instanceName')! }),
        encrypt: options.bool('encrypt') ?? true,
        trustServerCertificate: options.bool('trustServerCertificate') ?? false,
        // The certificate names the real server even when a tunnel moved the
        // address, which is the subtlety `Endpoint` exists to carry. `tedious`
        // takes it as `serverName` and fails the connection on a mismatch.
        ...(endpoint.tlsServerName === undefined ? {} : { serverName: endpoint.tlsServerName }),
        // Rows arrive as arrays, and none of them is collected for us: both are
        // what make the streaming contract above achievable.
        useColumnNames: false,
        rowCollectionOnRequestCompletion: false,
        rowCollectionOnDone: false,
      },
    };

    const conn = new Connection(config);
    await new Promise<void>((resolve, reject) => {
      conn.once('connect', err => (err ? reject(mssqlError(err, spec.name)) : resolve()));
      conn.connect();
    });

    io.log('info', 'mssql session opened', { connection: spec.name, auth, database: database ?? '(default)' });
    return new MssqlSession(conn, { connection: spec.name, database }, io);
  },
};
