/**
 * Elasticsearch and OpenSearch.
 *
 * One provider for both, because they are the same shape behind two spellings:
 * HTTP and JSON, a cluster of indices, documents with inferred fields. What
 * differs is settled once at connect, by asking the cluster what it is, rather
 * than by making the user declare it.
 *
 * Three things shape the code below.
 *
 * 1. SQL is the free path, and only over HTTP. Elastic's subscription matrix
 *    puts "Elasticsearch SQL APIs & CLI" in Basic, and the JDBC and ODBC
 *    drivers behind a paid tier. So a tool that speaks HTTP reaches SQL on a
 *    cluster where a JDBC-based tool cannot — this is a reason to use the REST
 *    API, not a limitation of it. OpenSearch gates nothing: its SQL plugin is
 *    Apache-2.0 and ships in every distribution but the minimal one.
 *
 * 2. Not every cluster has SQL. It is a plugin on OpenSearch and a licensed
 *    feature surface on Elasticsearch, and plenty of older clusters have
 *    neither. So a statement may also be a Query DSL body, written the way
 *    Kibana's console writes it, and that path needs nothing installed at all.
 *
 * 3. No dependency. This is HTTP with JSON bodies, `fetch` is in the runtime,
 *    and `@elastic/elasticsearch` would add a client whose only job here is to
 *    POST four endpoints — while also refusing to talk to OpenSearch, which it
 *    deliberately version-checks against.
 *
 * What this is not: a full search client. Aggregations come back as the engine
 * renders them, and a Query DSL body is passed through untouched. The job is to
 * make a cluster answer in rows, not to model its query language.
 */

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

const FIELDS: readonly FieldSpec[] = [
  { name: 'host', type: 'string', description: 'Cluster hostname or IP address', required: true, prompt: true },
  { name: 'port', type: 'number', description: 'HTTP port', default: 9200, prompt: true },
  {
    name: 'user',
    type: 'string',
    description: 'User for basic authentication; leave empty for a cluster with security disabled',
    substitute: true,
    prompt: true,
  },
  { name: 'protocol', type: 'string', description: 'Wire protocol: http or https', default: 'http', prompt: true },
  {
    name: 'index',
    type: 'string',
    description: 'Default index for a Query DSL statement that does not name one, and the only one browsed',
    substitute: true,
    prompt: true,
  },
  {
    name: 'fetchSize',
    type: 'number',
    description: 'Rows per page when paging a SQL cursor',
    default: 1000,
    prompt: false,
  },
];

/**
 * Elasticsearch SQL, which is a deliberately small dialect: no joins, one index
 * (or pattern) per statement, and functions of its own for text search.
 */
const KEYWORDS: readonly string[] = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'HAVING', 'ORDER BY', 'LIMIT', 'AS',
  'AND', 'OR', 'NOT', 'IN', 'LIKE', 'RLIKE', 'BETWEEN', 'IS NULL', 'IS NOT NULL',
  'DISTINCT', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'CASE', 'WHEN', 'THEN', 'ELSE',
  'END', 'CAST', 'CONVERT', 'EXTRACT', 'ASC', 'DESC', 'DESCRIBE', 'SHOW TABLES',
  'SHOW COLUMNS', 'SHOW FUNCTIONS', 'PIVOT',
  // Full-text predicates, which are the reason to query this engine at all.
  'MATCH', 'QUERY', 'SCORE', 'KEYWORD', 'TEXT',
];

export const ELASTICSEARCH_CAPABILITIES: Capabilities = capabilities({
  limit: 'limit',
  // A cursor page is yielded and dropped; nothing accumulates.
  streams: true,
  // There is no synchronous cancel: the cursor is closed and the socket
  // abandoned. The engine may finish the page it is on.
  cancel: 'transport',
  // `_sql/translate` renders a statement as Query DSL without running it, which
  // is a parse and a plan with nothing scanned.
  explain: 'validate',
  browse: true,
  validate: true,
  settings: false,
  keywords: KEYWORDS,
});

/** Which of the two this cluster is. They differ in paths and in response shape. */
export type Flavour = 'elasticsearch' | 'opensearch';

/** What `GET /` reports about itself. */
export interface ClusterInfo {
  readonly flavour: Flavour;
  readonly version: string;
}

/**
 * Read the flavour out of a root response.
 *
 * OpenSearch sets `version.distribution` to `opensearch`; Elasticsearch has no
 * such field. Asked rather than configured, because a user who has to declare
 * which fork they are running will sometimes declare it wrong, and the failure
 * is a 404 on a path they never typed.
 */
export function readClusterInfo(body: unknown): ClusterInfo {
  const version = (body as { version?: { number?: unknown; distribution?: unknown } })?.version;
  const distribution = typeof version?.distribution === 'string' ? version.distribution : '';
  return {
    flavour: distribution.toLowerCase() === 'opensearch' ? 'opensearch' : 'elasticsearch',
    version: typeof version?.number === 'string' ? version.number : 'unknown',
  };
}

/** Endpoint paths, which is most of what separates the two. */
export function paths(flavour: Flavour): { sql: string; close: string; translate: string } {
  return flavour === 'opensearch'
    ? { sql: '/_plugins/_sql', close: '/_plugins/_sql/close', translate: '/_plugins/_sql/_explain' }
    : { sql: '/_sql', close: '/_sql/close', translate: '/_sql/translate' };
}

/* ------------------------------------------------------------------ statements */

export interface DslStatement {
  /** Path to POST, e.g. `/my-index/_search`. */
  readonly path: string;
  readonly body: string;
}

/**
 * Is this statement a Query DSL body rather than SQL?
 *
 * Decided on the first character of code, because that is unambiguous: SQL
 * never begins with `{`, and a console-style request never begins with anything
 * else once its verb line is taken off.
 */
export function isDsl(statement: string): boolean {
  const trimmed = statement.trimStart();
  return trimmed.startsWith('{') || /^(?:GET|POST)\s+\/?\S/i.test(trimmed);
}

/**
 * Split a Query DSL statement into a path and a body.
 *
 * Accepts what Kibana's console accepts, because that is where these bodies are
 * written and copied from:
 *
 *     POST /my-index/_search
 *     { "query": { "match_all": {} } }
 *
 * A bare body uses the connection's `index`. Without one there is nothing to
 * search and saying so is better than searching everything: on a cluster with a
 * thousand indices, an accidental cross-index scan is expensive.
 */
export function parseDsl(statement: string, defaultIndex: string | undefined): DslStatement {
  const trimmed = statement.trim();
  const verb = /^(?:GET|POST)\s+(\S+)\s*([\s\S]*)$/i.exec(trimmed);

  if (verb) {
    const path = verb[1]!.startsWith('/') ? verb[1]! : `/${verb[1]!}`;
    return { path, body: (verb[2] ?? '').trim() || '{}' };
  }

  if (defaultIndex === undefined) {
    throw new DbRexError('config', 'a Query DSL statement needs an index', {
      hint: 'write the path, as in "POST /my-index/_search", or set "index" on the connection',
    });
  }
  return { path: `/${defaultIndex}/_search`, body: trimmed };
}

/* ------------------------------------------------------------------ responses */

/**
 * Columns and rows out of a SQL response, in either dialect's shape.
 *
 * Elasticsearch answers `{ columns: [{name, type}], rows: [[...]] }`.
 * OpenSearch's default `jdbc` format answers `{ schema: [{name, type}],
 * datarows: [[...]] }`. Same information, two spellings, so both are read here
 * rather than branching at every call site.
 */
export function readSqlPage(body: unknown): {
  columns: Column[] | undefined;
  rows: unknown[][];
  cursor: string | undefined;
} {
  const page = body as {
    columns?: { name?: unknown; type?: unknown }[];
    schema?: { name?: unknown; type?: unknown }[];
    rows?: unknown[][];
    datarows?: unknown[][];
    cursor?: unknown;
  };

  const declared = page.columns ?? page.schema;
  const columns = declared?.map(c => ({
    name: typeof c.name === 'string' ? c.name : '',
    type: typeof c.type === 'string' ? c.type : 'unknown',
  }));

  return {
    columns,
    rows: page.rows ?? page.datarows ?? [],
    cursor: typeof page.cursor === 'string' && page.cursor.length > 0 ? page.cursor : undefined,
  };
}

/** Metadata columns a document always has, before its own fields. */
const DOC_COLUMNS: readonly Column[] = [
  { name: '_index', type: 'keyword' },
  { name: '_id', type: 'keyword' },
  { name: '_score', type: 'float' },
];

/**
 * Documents as rows.
 *
 * A search response has no column list — each document carries whatever fields
 * it has — so the shape is taken from the union of the page's own documents, in
 * first-seen order. Nested objects are rendered as JSON rather than flattened
 * into columns: flattening invents names that are not in the mapping, and the
 * renderer already shows an object readably.
 */
export function readSearchPage(body: unknown): { columns: Column[]; rows: unknown[][]; total: number } {
  const hits = (body as { hits?: { hits?: unknown[]; total?: unknown } })?.hits;
  const docs = Array.isArray(hits?.hits) ? hits.hits : [];

  const names: string[] = [];
  const sources = docs.map(doc => {
    const d = doc as { _source?: unknown };
    const source = d._source !== null && typeof d._source === 'object' && !Array.isArray(d._source)
      ? (d._source as Record<string, unknown>)
      : {};
    for (const key of Object.keys(source)) if (!names.includes(key)) names.push(key);
    return source;
  });

  const columns = [...DOC_COLUMNS, ...names.map(name => ({ name, type: 'unknown' }))];
  const rows = docs.map((doc, i) => {
    const d = doc as { _index?: unknown; _id?: unknown; _score?: unknown };
    const source = sources[i] ?? {};
    return [d._index ?? null, d._id ?? null, d._score ?? null, ...names.map(n => source[n] ?? null)];
  });

  const total = hits?.total;
  const counted = typeof total === 'number'
    ? total
    : typeof (total as { value?: unknown })?.value === 'number'
      ? (total as { value: number }).value
      : rows.length;

  return { columns, rows, total: counted };
}

/* ------------------------------------------------------------------ errors */

/**
 * An Elasticsearch failure, read from the status and the body it came with.
 *
 * The body is where the useful part is: `error.reason` says what was wrong with
 * the statement, and losing it in favour of "request failed with 400" is the
 * difference between a fixable message and a shrug.
 */
export function elasticError(
  status: number,
  body: unknown,
  connection: string,
  cause?: unknown,
): DbRexError {
  const error = (body as { error?: unknown })?.error;
  const reason = typeof error === 'string'
    ? error
    : typeof (error as { reason?: unknown })?.reason === 'string'
      ? (error as { reason: string }).reason
      : undefined;
  const type = typeof (error as { type?: unknown })?.type === 'string'
    ? (error as { type: string }).type
    : undefined;

  const code = classifyStatus(status, type);
  const message = reason ?? `Elasticsearch answered ${status}`;

  return new DbRexError(code, message, {
    connection,
    ...(type === undefined ? {} : { nativeCode: type }),
    ...(hintFor(code, status, type) === undefined ? {} : { hint: hintFor(code, status, type)! }),
    retryable: code === 'network',
  }, cause);
}

export function classifyStatus(status: number, type?: string): ErrorCode {
  if (type === 'index_not_found_exception') return 'not_found';
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 400 || status === 422) return 'sql';
  if (status >= 500) return 'network';
  return 'sql';
}

function hintFor(code: ErrorCode, status: number, type?: string): string | undefined {
  if (code === 'auth') return 'check the user and password for this connection';
  if (code === 'forbidden') return 'this user lacks the privilege for that index or action';
  if (type === 'index_not_found_exception') return 'the index does not exist; browse the connection to see what does';
  // The one failure whose cause is not in the message: no SQL surface at all.
  if (status === 400 && type === 'parsing_exception') return 'Elasticsearch SQL is a small dialect: no joins, one index per statement';
  return undefined;
}

/** A transport failure, before any HTTP status existed. */
export function transportError(e: unknown, connection: string): DbRexError {
  if (isAbortError(e)) return new DbRexError('cancelled', 'query cancelled', { connection }, e);
  const message = e instanceof Error ? e.message : String(e);
  return new DbRexError('network', message, {
    connection,
    hint: 'check the host, the port and whether the cluster requires https',
    retryable: true,
  }, e);
}

/* ------------------------------------------------------------------ session */

interface Config {
  readonly connection: string;
  readonly base: string;
  readonly auth: string | undefined;
  readonly index: string | undefined;
  readonly fetchSize: number;
}

class ElasticSession implements Session {
  private closed = false;

  constructor(
    private readonly config: Config,
    private readonly cluster: ClusterInfo,
    private readonly io: ProviderIo,
  ) {}

  async *query(sql: string, options: QueryOptions = {}): AsyncGenerator<Chunk, QueryStats, void> {
    const started = Date.now();
    const stats = isDsl(sql)
      ? yield* this.search(sql, options)
      : yield* this.sql(sql, options);
    return { ...stats, elapsedMs: Date.now() - started };
  }

  /** Walk a SQL cursor, yielding each page and dropping it. */
  private async *sql(sql: string, options: QueryOptions): AsyncGenerator<Chunk, QueryStats, void> {
    const path = paths(this.cluster.flavour);
    const limit = options.rowLimit ?? Number.POSITIVE_INFINITY;

    let body: Record<string, unknown> = {
      query: sql,
      fetch_size: Math.max(1, Math.min(this.config.fetchSize, limit === Infinity ? this.config.fetchSize : limit)),
      // OpenSearch defaults to `jdbc`, which is the format its cursor works
      // with. Elasticsearch ignores the field and is told through the query
      // string instead.
      ...(this.cluster.flavour === 'opensearch' ? { format: 'jdbc' } : {}),
    };

    let sent = 0;
    let first = true;
    let cursor: string | undefined;
    let truncated = false;

    try {
      for (;;) {
        const url = this.cluster.flavour === 'opensearch' ? path.sql : `${path.sql}?format=json`;
        const page = readSqlPage(await this.request('POST', url, body, options.signal));

        const room = limit - sent;
        const rows = page.rows.length > room ? page.rows.slice(0, Math.max(0, room)) : page.rows;
        if (rows.length < page.rows.length) truncated = true;

        if (first) {
          yield { columns: page.columns ?? [], rows };
          first = false;
        } else if (rows.length > 0) {
          yield { rows };
        }
        sent += rows.length;

        cursor = page.cursor;
        if (cursor === undefined) break;
        if (sent >= limit) { truncated = true; break; }
        body = { cursor };
      }
    } finally {
      // A cursor left open holds a search context on the cluster. Closing it is
      // the one piece of cleanup this provider owes the server, and it has to
      // happen on the early exit too, which is why it is in a finally.
      if (cursor !== undefined) await this.closeCursor(path.close, cursor);
    }

    return { elapsedMs: 0, truncated, rowsRead: sent };
  }

  /** One Query DSL request. No scrolling: a search body says its own size. */
  private async *search(statement: string, options: QueryOptions): AsyncGenerator<Chunk, QueryStats, void> {
    const { path, body } = parseDsl(statement, this.config.index);

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      throw new DbRexError('sql', `the request body is not valid JSON: ${(e as Error).message}`, {
        connection: this.config.connection,
        hint: 'a statement starting with "{" is read as a Query DSL body',
      }, e);
    }

    const answer = await this.request('POST', path, parsed, options.signal);
    const page = readSearchPage(answer);
    const limit = options.rowLimit ?? Number.POSITIVE_INFINITY;
    const rows = page.rows.length > limit ? page.rows.slice(0, limit) : page.rows;

    yield { columns: page.columns, rows };
    return {
      elapsedMs: 0,
      truncated: rows.length < page.total,
      rowsRead: rows.length,
    };
  }

  async browse(path: readonly string[]): Promise<BrowseNode[]> {
    const [index] = path;
    return index === undefined ? this.indices() : this.fields(index);
  }

  /**
   * Indices, as tables.
   *
   * `_cat/indices` rather than `_aliases` because it carries the document count
   * and the store size, which is what makes the tree worth reading. Hidden and
   * system indices are left out: a cluster has dozens and none of them is what
   * anyone opened the tree to find.
   */
  private async indices(): Promise<BrowseNode[]> {
    if (this.config.index !== undefined) return [this.indexNode(this.config.index, undefined)];

    const body = await this.request('GET', '/_cat/indices?format=json&h=index,docs.count,store.size', undefined);
    const rows = Array.isArray(body) ? body : [];
    return rows
      .map(r => r as { index?: unknown; 'docs.count'?: unknown; 'store.size'?: unknown })
      .filter(r => typeof r.index === 'string' && !r.index.startsWith('.'))
      .map(r => this.indexNode(
        r.index as string,
        [r['docs.count'], r['store.size']].filter(v => typeof v === 'string').join('  ') || undefined,
      ))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private indexNode(name: string, detail: string | undefined): BrowseNode {
    return {
      kind: 'table',
      name,
      hasChildren: true,
      ...(detail === undefined ? {} : { detail }),
      insert: quoteIdent(name),
      query: `SELECT * FROM ${quoteIdent(name)}\nLIMIT 100`,
    };
  }

  /**
   * Fields of an index, from its mapping.
   *
   * The mapping, not `DESCRIBE`: an index whose cluster has no SQL surface still
   * has a mapping, so the tree keeps working where SQL does not.
   */
  private async fields(index: string): Promise<BrowseNode[]> {
    const body = await this.request('GET', `/${encodeURIComponent(index)}/_mapping`, undefined);
    const out: BrowseNode[] = [];
    for (const perIndex of Object.values((body ?? {}) as Record<string, unknown>)) {
      const properties = (perIndex as { mappings?: { properties?: unknown } })?.mappings?.properties;
      if (properties === null || typeof properties !== 'object') continue;
      collectFields(properties as Record<string, unknown>, '', out);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Translate the statement without running it, and report what came back.
   *
   * A successful translation is a parse and a plan with nothing scanned, which
   * is exactly what an editor squiggle needs. A Query DSL body is not checked:
   * there is no endpoint that validates one without executing it, and running a
   * search on every keystroke is not a diagnostic, it is a load test.
   */
  async validate(sql: string): Promise<Diagnostic[]> {
    if (isDsl(sql)) return [];
    try {
      await this.request('POST', paths(this.cluster.flavour).translate, { query: sql }, undefined);
      return [];
    } catch (e) {
      if (!DbRexError.is(e) || e.code !== 'sql') return [];
      return [{ message: e.message, severity: 'error' }];
    }
  }

  async close(): Promise<void> {
    // Nothing is held open: every request is its own HTTP round trip and any
    // cursor was closed by the query that opened it.
    this.closed = true;
  }

  private async closeCursor(path: string, cursor: string): Promise<void> {
    try {
      await this.request('POST', path, { cursor }, undefined);
    } catch (e) {
      // Losing a search context is a leak on the cluster, not a failed query.
      // It must not replace the error the caller is already handling.
      this.io.log('debug', 'could not close an elasticsearch cursor', {
        connection: this.config.connection, error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  private request(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.closed) {
      throw new DbRexError('internal', 'this session is closed', { connection: this.config.connection });
    }
    return send(this.config, method, path, body, signal);
  }
}

/**
 * One HTTP round trip against the cluster.
 *
 * A free function rather than a method because the flavour probe runs before
 * there is a session to call: everything a session does depends on the answer.
 */
async function send(
  config: Config,
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${config.base}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(config.auth === undefined ? {} : { authorization: config.auth }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (e) {
    throw transportError(e, config.connection);
  }

  const text = await response.text();
  const parsed = text.length === 0 ? undefined : safeJson(text);

  if (!response.ok) throw elasticError(response.status, parsed, config.connection);
  return parsed;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // A proxy in front of the cluster answering HTML is a real and confusing
    // case; keeping the body lets the error say what actually arrived.
    return { error: text.slice(0, 400) };
  }
}

/**
 * Mapping properties, flattened to dotted names.
 *
 * `user.address.city` is how the field is written in both SQL and the DSL, so
 * that is the name the tree offers. A `properties` block means an object field
 * and is walked; `fields` (multi-fields such as `.keyword`) is walked too,
 * because `text` is not aggregatable and `text.keyword` is what a GROUP BY
 * actually needs.
 */
function collectFields(
  properties: Record<string, unknown>,
  prefix: string,
  out: BrowseNode[],
): void {
  for (const [name, raw] of Object.entries(properties)) {
    const field = raw as { type?: unknown; properties?: unknown; fields?: unknown };
    const full = prefix.length > 0 ? `${prefix}.${name}` : name;

    if (field.properties !== null && typeof field.properties === 'object') {
      collectFields(field.properties as Record<string, unknown>, full, out);
      continue;
    }

    out.push({
      kind: 'column',
      name: full,
      hasChildren: false,
      detail: typeof field.type === 'string' ? field.type : 'unknown',
      insert: quoteIdent(full),
    });

    if (field.fields !== null && typeof field.fields === 'object') {
      collectFields(field.fields as Record<string, unknown>, full, out);
    }
  }
}

/**
 * Quote an identifier the way Elasticsearch SQL does.
 *
 * Double quotes, and an index name may contain a `-` or a `.` — a dated index
 * such as `logs-2026.10.01` cannot be written bare — so quoting is the normal
 * case here, not the exception.
 */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export const elasticsearchProvider: Provider = {
  id: 'elasticsearch',
  displayName: 'Elasticsearch / OpenSearch',
  capabilities: ELASTICSEARCH_CAPABILITIES,
  fields: FIELDS,

  async open(spec: ConnectionSpec, endpoint: Endpoint, io: ProviderIo): Promise<Session> {
    const options = new Options(spec.options, spec.name);
    const protocol = options.str('protocol') ?? 'http';
    if (protocol !== 'http' && protocol !== 'https') {
      throw new DbRexError('config', `"${protocol}" is not a protocol`, {
        connection: spec.name,
        hint: 'protocol must be http or https',
      });
    }

    const user = options.str('user');
    // Only when there is a user: a cluster with security disabled rejects an
    // Authorization header it was never configured to read, and prompting for a
    // password nobody set would be worse than not asking.
    const auth = user === undefined
      ? undefined
      : `Basic ${Buffer.from(`${user}:${await io.secret({ kind: 'password' })}`).toString('base64')}`;

    const config: Config = {
      connection: spec.name,
      base: `${protocol}://${endpoint.host}:${endpoint.port}`,
      auth,
      index: options.str('index'),
      fetchSize: options.num('fetchSize') ?? 1000,
    };

    // Asked once, at connect: every path and every response shape below depends
    // on the answer, and a cluster does not change which fork it is mid-session.
    const cluster = readClusterInfo(await send(config, 'GET', '/', undefined));
    io.log('info', 'elasticsearch cluster identified', {
      connection: spec.name, flavour: cluster.flavour, version: cluster.version,
    });

    return new ElasticSession(config, cluster, io);
  },
};
