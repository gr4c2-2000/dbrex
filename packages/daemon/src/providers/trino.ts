/**
 * Trino provider.
 *
 * The REST protocol is a chain, not a request: `POST /v1/statement` returns the
 * first page, every page carries a `nextUri` for the next one, and a `DELETE`
 * on that uri makes the coordinator abandon the query for real. That shape maps
 * onto the streaming `query()` contract directly — each page becomes a chunk,
 * and `rowLimit` is a genuine server-side stop rather than a post-hoc slice.
 *
 * Three things the old adapter got wrong, fixed here by construction:
 *
 * 1. `page.error` was checked only on pages fetched *after* the first, so a
 *    query that failed on submission came back as an empty success. `walkPages`
 *    checks the page it is holding, before anything else, on every iteration.
 * 2. Pages were accumulated into an array and `collectResult` walked all of them
 *    twice at the end. Nothing is accumulated; a page is yielded and dropped.
 * 3. The OAuth2 browser login lived in `extension.ts`, so the MCP path skipped
 *    it and an agent hitting an unauthenticated coordinator got a raw 401. The
 *    flow lives here now and asks for a human through `io.interactive`, which
 *    the daemon routes to whichever client can answer.
 */

import * as fs from 'node:fs';
import * as https from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { URL } from 'node:url';
import type {
  BrowseNode,
  Chunk,
  Column,
  ConnectionSpec,
  Diagnostic,
  Endpoint,
  FieldSpec,
  Provider,
  ProviderIo,
  QueryOptions,
  QueryStats,
  SecretPurpose,
  Session,
} from '@dbrex/core';
import { DbRexError, Options, capabilities, isAbortError } from '@dbrex/core';

/** One page of the Trino REST protocol response. */
export interface TrinoPage {
  readonly id?: string;
  readonly nextUri?: string;
  readonly columns?: readonly { readonly name: string; readonly type: string }[];
  readonly data?: readonly (readonly unknown[])[];
  readonly error?: TrinoError;
  readonly stats?: { readonly state?: string };
}

export interface TrinoError {
  readonly message?: string;
  readonly errorName?: string;
  readonly errorCode?: number;
  readonly errorType?: string;
  readonly errorLocation?: { readonly lineNumber?: number; readonly columnNumber?: number };
}

/** The two urls a Trino OAuth2 401 hands back. */
export interface AuthChallenge {
  readonly redirectServer: string;
  readonly tokenServer: string;
}

export type TokenPoll =
  | { readonly status: 'ready'; readonly token: string }
  | { readonly status: 'pending' }
  | { readonly status: 'failed'; readonly message: string };

// ---------------------------------------------------------------------------
// Pure helpers. Exported because they are where the protocol's sharp edges are,
// and they are testable without a coordinator.
// ---------------------------------------------------------------------------

/**
 * Parse the OAuth2 challenge out of a 401's `WWW-Authenticate`.
 *
 * Node hands repeated headers back as an array; Trino also emits the two
 * parameters across separate `Bearer` challenges on some builds, so the parts
 * are joined before matching rather than parsed as one well-formed challenge.
 * Anything missing either half is not a flow we can drive — say so with `null`
 * instead of half-starting a login.
 */
export function parseAuthChallenge(header: string | string[] | undefined): AuthChallenge | null {
  if (header === undefined) return null;
  const raw = Array.isArray(header) ? header.join(', ') : header;
  const redirectServer = /x_redirect_server="([^"]+)"/.exec(raw)?.[1];
  const tokenServer = /x_token_server="([^"]+)"/.exec(raw)?.[1];
  if (!redirectServer || !tokenServer) return null;
  return { redirectServer, tokenServer };
}

/**
 * Read one token-server poll response.
 *
 * While the human is still in the browser the server answers with no token and
 * no error, which is "keep waiting" — distinct from a body that says the login
 * failed, which must stop the loop instead of burning two minutes of polling.
 */
export function parseTokenBody(body: string): TokenPoll {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Not JSON (yet). Fall back to a substring match so a chunked or wrapped
    // body still yields the token rather than looping until the deadline.
    const token = /"token"\s*:\s*"([^"]+)"/.exec(body)?.[1];
    return token === undefined ? { status: 'pending' } : { status: 'ready', token };
  }
  if (!parsed || typeof parsed !== 'object') return { status: 'pending' };
  const record = parsed as { token?: unknown; error?: unknown };
  if (typeof record.token === 'string' && record.token.length > 0) {
    return { status: 'ready', token: record.token };
  }
  if (typeof record.error === 'string' && record.error.length > 0) {
    return { status: 'failed', message: record.error };
  }
  return { status: 'pending' };
}

/** Encode session properties for `X-Trino-Session`. Undefined when there is nothing to send. */
export function encodeSessionHeader(
  properties: Readonly<Record<string, string | number | boolean>>,
): string | undefined {
  const parts = Object.entries(properties).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return parts.length === 0 ? undefined : parts.join(', ');
}

/** Read the connection-level `sessionProperties` knob: `k=v,k2=v2`. */
export function parseSessionProperties(spec: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (spec === undefined) return out;
  for (const entry of spec.split(',')) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    const key = entry.slice(0, eq).trim();
    if (key.length > 0) out[key] = entry.slice(eq + 1).trim();
  }
  return out;
}

/** Take at most the rows still allowed by `rowLimit`. */
export function takeRows(
  data: readonly (readonly unknown[])[],
  taken: number,
  rowLimit: number | undefined,
): readonly (readonly unknown[])[] {
  if (rowLimit === undefined) return data;
  const room = Math.max(0, rowLimit - taken);
  return data.length <= room ? data : data.slice(0, room);
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function quoteString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** A query the engine understood and rejected. The Trino error name is what the user will search for. */
export function pageFailure(error: TrinoError, connection: string): DbRexError {
  const message = error.message ?? error.errorName ?? 'Trino rejected the statement';
  const details = error.errorName === undefined
    ? { connection }
    : { connection, nativeCode: error.errorName };
  // The raw error rides along as `cause` so `validate()` can recover the
  // statement position, which `ErrorDetails` has no room for.
  return new DbRexError('sql', message, details, error);
}

export function isTrinoError(value: unknown): value is TrinoError {
  if (!value || typeof value !== 'object') return false;
  const e = value as TrinoError;
  return typeof e.message === 'string' || typeof e.errorName === 'string';
}

/** Non-2xx from the coordinator. 401/403 is credentials; 5xx is a coordinator we could not get an answer from. */
export function httpFailure(status: number, body: string, connection: string): DbRexError {
  const excerpt = body.trim().slice(0, 300);
  if (status === 401 || status === 403) {
    return new DbRexError('auth', `Trino refused the credentials (HTTP ${status})`, {
      connection,
      hint: 'run the query again to trigger a fresh login, or check authMode and the user',
      retryable: true,
    });
  }
  if (status >= 500 || status === 429) {
    return new DbRexError('network', `Trino coordinator returned HTTP ${status}: ${excerpt}`, {
      connection,
      retryable: true,
    });
  }
  return new DbRexError('sql', `Trino returned HTTP ${status}: ${excerpt}`, { connection });
}

/** Anything the socket threw. DNS, TCP and TLS failures are all "could not reach the server". */
export function transportFailure(e: unknown, connection: string): DbRexError {
  if (DbRexError.is(e)) return e;
  if (isAbortError(e)) return cancelled(connection);
  const code = (e as { code?: unknown } | null)?.code;
  const hint = typeof code === 'string' && code.startsWith('CERT_')
    ? 'set caCertPath to the CA that signed the coordinator certificate'
    : 'check the host, the port, and the tunnel if this connection uses one';
  return DbRexError.wrap('network', e, { connection, hint, retryable: true });
}

export function cancelled(connection: string): DbRexError {
  return new DbRexError('cancelled', 'query cancelled', { connection });
}

/** Byte offset of a 1-based line/column pair, for editor diagnostics. */
export function offsetOf(sql: string, line: number, column: number): number | undefined {
  if (line < 1 || column < 1) return undefined;
  let offset = 0;
  for (let i = 1; i < line; i++) {
    const newline = sql.indexOf('\n', offset);
    if (newline < 0) return undefined;
    offset = newline + 1;
  }
  return offset + column - 1;
}

/** The wrapper `validate()` puts in front of the user's statement. */
export const VALIDATE_PREFIX = 'EXPLAIN (TYPE VALIDATE) ';

/**
 * Turn a rejected `EXPLAIN (TYPE VALIDATE)` into a diagnostic against the
 * user's own text. Trino reports the position inside the wrapped statement, so
 * only line 1 is shifted by the wrapper — every later line is untouched, and
 * subtracting the prefix from those would move the marker backwards.
 */
/**
 * `max()`/`min()` over Iceberg with no predicate reads every partition.
 *
 * Trino does not answer these from Iceberg metadata, so what looks like a
 * cheap lookup is a full scan. Static, so it costs nothing and works while the
 * user is still typing.
 */
export function icebergScanHint(sql: string): string | null {
  const touchesIceberg = /\biceberg\s*\.\s*\w/i.test(sql) || /\bfrom\s+"?iceberg"?\s*\./i.test(sql);
  const takesExtreme = /\b(max|min)\s*\(/i.test(sql);
  const hasPredicate = /\bwhere\b/i.test(sql);
  if (!touchesIceberg || !takesExtreme || hasPredicate) return null;
  return 'max()/min() on an Iceberg table without WHERE scans every partition — '
    + 'Trino does not read this from Iceberg metadata. Add a partition predicate, '
    + 'or query "<table>$partitions" instead.';
}

export function validationDiagnostic(sql: string, error: TrinoError): Diagnostic {
  const at = error.errorLocation;
  if (at?.lineNumber !== 1 || at.columnNumber === undefined) return diagnosticFrom(sql, error);
  return diagnosticFrom(sql, {
    ...error,
    errorLocation: { lineNumber: 1, columnNumber: at.columnNumber - VALIDATE_PREFIX.length },
  });
}

export function diagnosticFrom(sql: string, error: TrinoError): Diagnostic {
  const message = error.message ?? error.errorName ?? 'invalid statement';
  const at = error.errorLocation;
  const offset = at?.lineNumber !== undefined && at.columnNumber !== undefined
    ? offsetOf(sql, at.lineNumber, at.columnNumber)
    : undefined;
  return offset === undefined
    ? { message, severity: 'error' }
    : { message, offset, severity: 'error' };
}

// ---------------------------------------------------------------------------
// The page walk
// ---------------------------------------------------------------------------

export interface PageWalk {
  readonly rowsRead: number;
  readonly truncated: boolean;
  readonly nativeQueryId?: string;
}

/**
 * Walk the `nextUri` chain, yielding each page as it arrives.
 *
 * Split from the session so the protocol's decisions — when an error surfaces,
 * when columns are announced, when the server-side DELETE fires — can be driven
 * from a test without a coordinator or a socket.
 */
export async function* walkPages(
  first: TrinoPage,
  fetch: (uri: string) => Promise<TrinoPage>,
  cancel: (uri: string) => void,
  options: {
    readonly connection: string;
    readonly rowLimit?: number;
    readonly signal?: AbortSignal;
  },
): AsyncGenerator<Chunk, PageWalk, void> {
  let page = first;
  let taken = 0;
  let truncated = false;
  let announced = false;
  let columns: Column[] | undefined;
  let nativeQueryId: string | undefined;

  for (;;) {
    // Every page, the first one included. The old adapter checked only pages
    // fetched after the first, so an immediately failing query looked like an
    // empty success.
    if (page.error !== undefined) throw pageFailure(page.error, options.connection);
    if (page.id !== undefined) nativeQueryId = page.id;
    if (columns === undefined && page.columns !== undefined) {
      columns = page.columns.map(c => ({ name: c.name, type: c.type }));
    }

    const data = page.data ?? [];
    const rows = takeRows(data, taken, options.rowLimit);
    taken += rows.length;
    if (rows.length < data.length) truncated = true;

    // The first chunk carries the columns even when it carries no rows, so a
    // zero-row result still tells the client what the shape was.
    if (columns !== undefined && !announced) {
      announced = true;
      yield { columns, rows };
    } else if (rows.length > 0) {
      yield { rows };
    }

    const nextUri = page.nextUri;
    if (nextUri === undefined) break;

    if (options.signal?.aborted) {
      cancel(nextUri);
      throw cancelled(options.connection);
    }
    if (options.rowLimit !== undefined && taken >= options.rowLimit) {
      // A DELETE on nextUri is a real server-side stop: the coordinator drops
      // the query instead of finishing it into a buffer nobody reads.
      cancel(nextUri);
      truncated = true;
      break;
    }

    page = await fetch(nextUri);
  }

  return nativeQueryId === undefined
    ? { rowsRead: taken, truncated }
    : { rowsRead: taken, truncated, nativeQueryId };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const FIELDS: readonly FieldSpec[] = [
  { name: 'host', type: 'string', description: 'Coordinator hostname', required: true, prompt: true },
  { name: 'port', type: 'number', description: 'Coordinator HTTPS port', default: 443, prompt: true },
  {
    name: 'user',
    type: 'string',
    description: 'Trino user, sent as X-Trino-User',
    required: true,
    substitute: true,
    prompt: true,
  },
  { name: 'catalog', type: 'string', description: 'Default catalog for unqualified names', prompt: true },
  { name: 'schema', type: 'string', description: 'Default schema for unqualified names', prompt: true },
  {
    name: 'authMode',
    type: 'string',
    description: 'Authentication: "sso" for the OAuth2 browser login, "basic" for user and password',
    default: 'sso',
    prompt: true,
  },
  {
    name: 'caCertPath',
    type: 'string',
    description: 'PEM file holding the CA that signed the coordinator certificate',
    substitute: true,
    prompt: true,
  },
  {
    name: 'sessionProperties',
    type: 'string',
    description: 'Session properties sent with every query, as key=value,key=value',
    prompt: false,
  },
];

const KEYWORDS: readonly string[] = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'HAVING', 'ORDER BY', 'LIMIT', 'OFFSET', 'WITH', 'AS',
  'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN', 'ON', 'USING', 'UNION', 'INTERSECT',
  'EXCEPT', 'DISTINCT', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'CAST', 'TRY_CAST', 'UNNEST',
  'LATERAL', 'OVER', 'PARTITION BY', 'WINDOW', 'VALUES', 'INSERT INTO', 'CREATE TABLE',
  'CREATE VIEW', 'DROP TABLE', 'DELETE FROM', 'UPDATE', 'MERGE', 'EXPLAIN', 'ANALYZE',
  'SHOW CATALOGS', 'SHOW SCHEMAS', 'SHOW TABLES', 'SHOW COLUMNS', 'DESCRIBE', 'APPROX_DISTINCT',
  'ARBITRARY', 'ARRAY_AGG', 'DATE_TRUNC', 'FROM_UNIXTIME', 'JSON_EXTRACT', 'REGEXP_LIKE',
];

/** Socket-level ceiling for one HTTP hop. The query deadline is separate and owned by `QueryOptions`. */
/**
 * Deadline for one HTTP hop, not for a query.
 *
 * Trino answers immediately with a `nextUri` and the result is collected by
 * polling, so a query that runs for an hour is many short requests. This is a
 * guard against a socket that has gone quiet, and it does not cap how long a
 * query may take.
 */
const REQUEST_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 2_000;
const POLL_ATTEMPTS = 60;

interface TrinoConfig {
  readonly connection: string;
  readonly base: string;
  readonly user: string;
  readonly catalog: string | undefined;
  readonly schema: string | undefined;
  readonly authMode: 'sso' | 'basic';
  readonly sessionProperties: Readonly<Record<string, string>>;
  /** Hostname to verify TLS against when a tunnel moved the address. */
  readonly servername: string | undefined;
}

interface RawResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

interface SendOptions {
  readonly body?: string;
  readonly signal?: AbortSignal;
  readonly settings?: Readonly<Record<string, string | number | boolean>>;
}

class TrinoSession implements Session {
  private token: string | undefined;
  private password: string | undefined;
  private login: Promise<string> | undefined;
  /**
   * One purpose value for both the lookup and the write-back, so the token we
   * obtain lands in the same vault slot the next session reads from.
   */
  private readonly tokenPurpose: SecretPurpose;

  constructor(
    private readonly config: TrinoConfig,
    private readonly io: ProviderIo,
    private readonly agent: https.Agent | undefined,
  ) {
    this.tokenPurpose = { kind: 'token', label: `Trino OAuth2 token for ${config.connection}` };
  }

  /**
   * Resolve whatever credential the daemon already holds. A missing SSO token
   * is not an error and must not raise a prompt — `storedSecret` looks without
   * asking, and the first 401 drives the browser login instead.
   */
  async start(): Promise<void> {
    if (this.config.authMode === 'basic') {
      this.password = await this.io.secret({ kind: 'password' });
      return;
    }
    const token = await this.io.storedSecret(this.tokenPurpose);
    if (token !== undefined && token.length > 0) this.token = token;
  }

  async *query(sql: string, options: QueryOptions = {}): AsyncGenerator<Chunk, QueryStats, void> {
    const started = Date.now();
    const controller = new AbortController();
    const external = options.signal;
    const onAbort = (): void => controller.abort();
    if (external?.aborted) controller.abort();
    else external?.addEventListener('abort', onAbort, { once: true });

    // A deadline and a user cancellation both arrive as an abort, so the reason
    // is recorded here — the client must be able to tell "too slow" from "I
    // pressed stop".
    let timedOut = false;
    const timer = options.timeoutMs !== undefined && options.timeoutMs > 0
      ? setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs)
      : undefined;

    const signal = controller.signal;
    const settings = { ...this.config.sessionProperties, ...(options.settings ?? {}) };

    try {
      const first = await this.send('POST', `${this.config.base}/v1/statement`, { body: sql, signal, settings });
      const walk = yield* walkPages(
        first,
        uri => this.send('GET', uri, { signal }),
        uri => this.abandon(uri),
        options.rowLimit === undefined
          ? { connection: this.config.connection, signal }
          : { connection: this.config.connection, signal, rowLimit: options.rowLimit },
      );
      const stats: QueryStats = {
        elapsedMs: Date.now() - started,
        truncated: walk.truncated,
        rowsRead: walk.rowsRead,
      };
      return walk.nativeQueryId === undefined ? stats : { ...stats, nativeQueryId: walk.nativeQueryId };
    } catch (e) {
      if (timedOut && (isAbortError(e) || (DbRexError.is(e) && e.code === 'cancelled'))) {
        throw new DbRexError('timeout', `query exceeded ${String(options.timeoutMs)} ms`, {
          connection: this.config.connection,
          hint: 'raise the timeout or narrow the query',
        }, e);
      }
      throw e;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    }
  }

  async browse(path: readonly string[]): Promise<BrowseNode[]> {
    const [catalog, schema, table] = path;

    if (catalog === undefined) {
      const rows = await this.rows('SHOW CATALOGS');
      return rows.map(r => ({ kind: 'database' as const, name: String(r[0]), hasChildren: true }));
    }

    if (schema === undefined) {
      const rows = await this.rows(
        `SELECT schema_name FROM ${quoteIdent(catalog)}.information_schema.schemata ORDER BY 1`,
      );
      return rows.map(r => ({ kind: 'schema' as const, name: String(r[0]), hasChildren: true }));
    }

    if (table === undefined) {
      const rows = await this.rows(
        `SELECT table_name, table_type FROM ${quoteIdent(catalog)}.information_schema.tables` +
        ` WHERE table_schema = ${quoteString(schema)} ORDER BY 1`,
      );
      return rows.map(r => {
        const qualified =
          `${quoteIdent(catalog)}.${quoteIdent(schema)}.${quoteIdent(String(r[0]))}`;
        return {
          kind: String(r[1]).toUpperCase().includes('VIEW') ? ('view' as const) : ('table' as const),
          name: String(r[0]),
          hasChildren: true,
          insert: qualified,
          query: `SELECT *\nFROM ${qualified}\nLIMIT 100`,
        };
      });
    }

    if (path.length > 3) return [];

    const rows = await this.rows(
      `SELECT column_name, data_type FROM ${quoteIdent(catalog)}.information_schema.columns` +
      ` WHERE table_schema = ${quoteString(schema)} AND table_name = ${quoteString(table)}` +
      ' ORDER BY ordinal_position',
    );
    return rows.map(r => ({
      kind: 'column' as const,
      name: String(r[0]),
      detail: String(r[1]),
      hasChildren: false,
    }));
  }

  /**
   * `EXPLAIN (TYPE VALIDATE)` parses, analyses and plans the statement and
   * scans nothing, so it is safe to run on every keystroke's worth of SQL.
   */
  async validate(sql: string): Promise<Diagnostic[]> {
    const body = sql.trimEnd().replace(/;\s*$/, '');
    if (body.length === 0) return [];

    // Costed before it is checked: the hint needs no round trip, and a query
    // that is about to scan every partition is worth warning about even when
    // it is perfectly valid SQL.
    const hint = icebergScanHint(body);
    const hints: Diagnostic[] = hint === null ? [] : [{ message: hint, severity: 'warning' }];

    try {
      await this.rows(`${VALIDATE_PREFIX}${body}`);
      return hints;
    } catch (e) {
      if (!DbRexError.is(e) || e.code !== 'sql') throw e;
      // `pageFailure` kept the raw Trino error as the cause precisely so the
      // statement position survives; `ErrorDetails` has no room for it.
      const cause = (e as { cause?: unknown }).cause;
      if (isTrinoError(cause)) return [...hints, validationDiagnostic(body, cause)];
      return [...hints, { message: e.message, severity: 'error' }];
    }
  }

  async close(): Promise<void> {
    this.token = undefined;
    this.password = undefined;
    this.agent?.destroy();
  }

  /** Drain a small internal query. Only for browse and validate, never for user SQL. */
  private async rows(sql: string): Promise<readonly (readonly unknown[])[]> {
    const out: (readonly unknown[])[] = [];
    for await (const chunk of this.query(sql)) out.push(...chunk.rows);
    return out;
  }

  /** Best-effort server-side cancel. The query is already abandoned from our side. */
  private abandon(uri: string): void {
    void this.raw('DELETE', uri, this.headers('DELETE')).catch(() => { /* nothing left to do */ });
  }

  private async send(method: 'POST' | 'GET' | 'DELETE', url: string, options: SendOptions = {}): Promise<TrinoPage> {
    let response = await this.raw(method, url, this.headers(method, options.settings), options.body, options.signal);

    if (response.status === 401) {
      await this.reauthenticate(response.headers['www-authenticate'], options.signal);
      // Exactly one retry: a second 401 with a token we just obtained means the
      // coordinator will not accept us, and looping would reopen the browser.
      response = await this.raw(method, url, this.headers(method, options.settings), options.body, options.signal);
    }

    if (response.status >= 400) throw httpFailure(response.status, response.body, this.config.connection);
    if (method === 'DELETE') return {};

    try {
      return JSON.parse(response.body) as TrinoPage;
    } catch (e) {
      // A non-JSON 200 is a proxy or gateway answering instead of Trino.
      throw new DbRexError('network', 'Trino returned a body that is not JSON', {
        connection: this.config.connection,
        hint: 'a proxy is probably answering instead of the coordinator',
      }, e);
    }
  }

  /**
   * Drive the OAuth2 external-authentication flow: the 401 names a browser url
   * and a token url, a human visits the first, and we poll the second. The
   * daemon decides who sees that url — VSCode, a terminal, an agent relaying it
   * into a chat — and this code stays out of that decision.
   */
  private async reauthenticate(header: string | string[] | undefined, signal: AbortSignal | undefined): Promise<void> {
    if (this.config.authMode !== 'sso') {
      throw new DbRexError('auth', `Trino rejected the password for "${this.config.connection}"`, {
        connection: this.config.connection,
        hint: 'check the user and the stored password',
      });
    }

    const challenge = parseAuthChallenge(header);
    if (challenge === null) {
      throw new DbRexError('auth', 'Trino answered 401 without an OAuth2 challenge', {
        connection: this.config.connection,
        hint: 'the coordinator is not configured for external authentication; try authMode "basic"',
      });
    }

    // Two queries racing into a 401 must not open two browser windows.
    const pending = this.login ?? this.runLogin(challenge, signal);
    this.login = pending;
    try {
      this.token = await pending;
    } finally {
      if (this.login === pending) this.login = undefined;
    }
  }

  private async runLogin(challenge: AuthChallenge, signal: AbortSignal | undefined): Promise<string> {
    this.io.log('info', 'Trino requires a browser login', { connection: this.config.connection });
    await this.io.interactive({
      kind: 'browser',
      url: challenge.redirectServer,
      reason: `Log in to Trino to run queries on "${this.config.connection}"`,
    });
    const token = await this.pollToken(challenge.tokenServer, signal);
    // Hand the JWT to the daemon so the next session — and the next daemon
    // restart — starts authenticated instead of reopening a browser.
    await this.io.rememberSecret(this.tokenPurpose, token);
    this.io.log('info', 'Trino login complete', { connection: this.config.connection });
    return token;
  }

  private async pollToken(tokenServer: string, signal: AbortSignal | undefined): Promise<string> {
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
      if (signal?.aborted) throw cancelled(this.config.connection);
      const response = await this.raw('GET', tokenServer, {}, undefined, signal);
      const poll = parseTokenBody(response.body);
      if (poll.status === 'ready') return poll.token;
      if (poll.status === 'failed') {
        throw new DbRexError('auth', `Trino login failed: ${poll.message}`, { connection: this.config.connection });
      }
      await delay(POLL_INTERVAL_MS, signal);
    }
    throw new DbRexError('auth', 'timed out waiting for the Trino browser login', {
      connection: this.config.connection,
      hint: 'run the query again to get a fresh login url',
      retryable: true,
    });
  }

  private headers(
    method: string,
    settings?: Readonly<Record<string, string | number | boolean>>,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      'X-Trino-User': this.config.user,
      'X-Trino-Source': 'dbrex',
    };

    if (this.config.authMode === 'basic') {
      if (this.password === undefined) {
        throw new DbRexError('auth', `Trino connection "${this.config.connection}" has no password`, {
          connection: this.config.connection,
          hint: 'set a secret source for this connection',
        });
      }
      const credentials = Buffer.from(`${this.config.user}:${this.password}`).toString('base64');
      headers['authorization'] = `Basic ${credentials}`;
    } else if (this.token !== undefined) {
      headers['authorization'] = `Bearer ${this.token}`;
    }
    // With no token at all we deliberately send no authorization header: the
    // 401 that comes back carries the challenge we need to start the login.

    if (this.config.catalog !== undefined) headers['X-Trino-Catalog'] = this.config.catalog;
    if (this.config.schema !== undefined) headers['X-Trino-Schema'] = this.config.schema;
    if (method === 'POST') {
      headers['content-type'] = 'text/plain';
      // Session properties belong to the statement, so only the POST carries
      // them; the nextUri hops inherit the query's own session.
      const session = settings === undefined ? undefined : encodeSessionHeader(settings);
      if (session !== undefined) headers['X-Trino-Session'] = session;
    }
    return headers;
  }

  private raw(
    method: string,
    urlString: string,
    headers: Record<string, string>,
    body?: string,
    signal?: AbortSignal,
  ): Promise<RawResponse> {
    const url = new URL(urlString);
    return new Promise<RawResponse>((resolve, reject) => {
      if (signal?.aborted) {
        reject(cancelled(this.config.connection));
        return;
      }

      const request = https.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method,
          headers,
          agent: this.agent,
          timeout: REQUEST_TIMEOUT_MS,
          // Through a tunnel we connect to the local end while the certificate
          // names the real coordinator. Trino builds nextUri from the Host
          // header, so it carries the tunnel address too — every hop needs the
          // override, not just the first one.
          servername: this.config.servername,
        },
        response => {
          let raw = '';
          response.setEncoding('utf8');
          response.on('data', chunk => { raw += chunk; });
          response.on('end', () => {
            cleanup();
            resolve({ status: response.statusCode ?? 0, headers: response.headers, body: raw });
          });
        },
      );

      const onAbort = (): void => { request.destroy(cancelled(this.config.connection)); };
      const cleanup = (): void => { signal?.removeEventListener('abort', onAbort); };
      signal?.addEventListener('abort', onAbort, { once: true });

      request.on('error', e => { cleanup(); reject(transportFailure(e, this.config.connection)); });
      request.on('timeout', () => {
        request.destroy(new DbRexError('network', `Trino did not answer one request within ${REQUEST_TIMEOUT_MS} ms`, {
          connection: this.config.connection,
          retryable: true,
        }));
      });
      request.end(body);
    });
  }
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    function onAbort(): void { clearTimeout(timer); resolve(); }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function readCa(path: string, connection: string): Buffer {
  try {
    return fs.readFileSync(path);
  } catch (e) {
    throw DbRexError.wrap('config', e, {
      connection,
      hint: `caCertPath "${path}" could not be read`,
    });
  }
}

export const trinoProvider: Provider = {
  id: 'trino',
  displayName: 'Trino',
  capabilities: capabilities({
    limit: 'limit',
    // A DELETE on nextUri stops the coordinator, so the limit is a real safety
    // net and shared code may present it as one.
    streams: true,
    cancel: 'server',
    explain: 'analyze',
    browse: true,
    validate: true,
    settings: true,
    keywords: KEYWORDS,
  }),
  fields: FIELDS,

  async open(spec: ConnectionSpec, endpoint: Endpoint, io: ProviderIo): Promise<Session> {
    const options = new Options(spec.options, spec.name);
    const authMode = options.str('authMode') ?? 'sso';
    if (authMode !== 'sso' && authMode !== 'basic') {
      throw new DbRexError('config', `connection "${spec.name}": authMode must be "sso" or "basic"`, {
        connection: spec.name,
      });
    }

    const caCertPath = options.str('caCertPath');
    const agent = caCertPath === undefined
      ? undefined
      : new https.Agent({ ca: readCa(caCertPath, spec.name) });

    const config: TrinoConfig = {
      connection: spec.name,
      base: `https://${endpoint.host}:${endpoint.port}`,
      user: options.reqStr('user'),
      catalog: options.str('catalog'),
      schema: options.str('schema'),
      authMode,
      sessionProperties: parseSessionProperties(options.str('sessionProperties')),
      servername: endpoint.tlsServerName,
    };

    const session = new TrinoSession(config, io, agent);
    await session.start();
    return session;
  },
};
