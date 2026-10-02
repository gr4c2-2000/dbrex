/**
 * A local directory, queried with DuckDB.
 *
 * You give it a path. It walks the tree once, shows you the files, and lets you
 * write SQL against them. This is the piece that closes the DuckDB integration:
 * the object-store provider already reads parquet and CSV out of a bucket, and
 * the same machinery works on a folder — which is where most people's files
 * actually are while they are still working on them.
 *
 * Two things make it more than a thin wrapper.
 *
 * 1. **The index is queryable.** The walk produces a `dbrex_files` view —
 *    path, name, extension, size, modified — so "which of these is biggest",
 *    "what did I change today" and "how many parquet files are there" are
 *    questions you can ask in SQL rather than by reading the tree. A folder of
 *    four thousand files is not something anyone browses.
 *
 * 2. **The statement cannot leave the directory.** DuckDB will read any path it
 *    is given, so a provider that merely *displays* a root would be a provider
 *    that reads `/etc/passwd` on request. Confinement is applied before a
 *    statement runs and then locked, which was worth verifying rather than
 *    assuming — see `confinementSql` for the order it has to happen in and why
 *    two of the three settings alone achieve nothing.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DbRexError,
  Options,
  capabilities,
  type BrowseNode,
  type Capabilities,
  type Chunk,
  type Column,
  type ConnectionSpec,
  type Diagnostic,
  type Endpoint,
  type FieldSpec,
  type Provider,
  type ProviderIo,
  type QueryOptions,
  type QueryStats,
  type Session,
} from '@dbrex/core';
import {
  baseName,
  daemonConfigDir,
  duckReaderFor,
  duckdbError,
  humanSize,
  normalizeValue,
} from './s3';
import { loadDuckDB, type DuckDBConnectionLike } from './duckdb';

/** Files indexed before the walk gives up. A folder larger than this is a mount. */
const DEFAULT_MAX_FILES = 20_000;
const CHUNK_ROWS = 500;

const FIELDS: readonly FieldSpec[] = [
  {
    name: 'path',
    type: 'string',
    description: 'Directory to index and query. Everything below it is readable; nothing above it is',
    required: true,
    substitute: true,
    prompt: true,
  },
  {
    name: 'recursive',
    type: 'boolean',
    description: 'Walk subdirectories as well as the top level',
    default: true,
    prompt: true,
  },
  {
    name: 'include',
    type: 'string',
    description: 'Index only files matching this glob, e.g. *.parquet. Empty indexes everything',
    prompt: true,
  },
  {
    name: 'maxFiles',
    type: 'number',
    description: 'Stop indexing after this many files',
    default: DEFAULT_MAX_FILES,
    prompt: false,
  },
];

const KEYWORDS: readonly string[] = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'HAVING', 'ORDER BY', 'LIMIT', 'OFFSET',
  'JOIN', 'LEFT JOIN', 'USING', 'ON', 'AS', 'AND', 'OR', 'NOT', 'IN', 'LIKE',
  'BETWEEN', 'IS NULL', 'IS NOT NULL', 'DISTINCT', 'COUNT', 'SUM', 'AVG', 'MIN',
  'MAX', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'WITH', 'UNION', 'UNION ALL',
  'EXCEPT', 'INTERSECT', 'ASC', 'DESC', 'QUALIFY', 'EXCLUDE', 'REPLACE',
  // The readers, which are the whole point of pointing SQL at a folder.
  'read_parquet', 'read_csv_auto', 'read_json_auto', 'read_avro', 'glob',
  'dbrex_files', 'describe', 'summarize',
];

export const DIR_CAPABILITIES: Capabilities = capabilities({
  limit: 'limit',
  // `run()` materialises the whole result before a row is readable, so the
  // daemon must not be told it can spool an unbounded query safely.
  streams: false,
  // The node-api has no interrupt, and there is no transport to drop.
  cancel: 'none',
  explain: 'plan',
  browse: true,
  validate: false,
  settings: false,
  keywords: KEYWORDS,
});

/* ------------------------------------------------------------------ the index */

export interface IndexedFile {
  /** Path relative to the root, with `/` separators on every platform. */
  readonly relative: string;
  readonly size: number;
  /** Last modification, ISO 8601. */
  readonly modified: string;
}

export interface FileIndex {
  readonly files: readonly IndexedFile[];
  /** True when the walk stopped at `maxFiles` rather than finishing. */
  readonly truncated: boolean;
}

export interface WalkOptions {
  readonly recursive: boolean;
  readonly include?: string | undefined;
  readonly maxFiles: number;
}

/**
 * Turn a glob into a matcher.
 *
 * Only `*` and `?`, matched against the basename. A full glob language here
 * would be a second implementation of what DuckDB's own `glob()` already does
 * better; this is a filter on what gets indexed, not a query facility.
 */
export function includeMatcher(include: string | undefined): (name: string) => boolean {
  if (include === undefined || include.trim().length === 0) return () => true;
  const pattern = include.trim()
    .replace(/[.+^${}()|[\]\\]/g, String.raw`\$&`)
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  const re = new RegExp(`^${pattern}$`, 'i');
  return name => re.test(name);
}

/**
 * Walk a directory into a list of files.
 *
 * Symlinks are listed but never followed. A link out of the root would let the
 * index describe files the confinement below refuses to read, which is a tree
 * that lies; a link into a parent would make the walk circular.
 */
export function walkDirectory(root: string, options: WalkOptions): FileIndex {
  const matches = includeMatcher(options.include);
  const files: IndexedFile[] = [];
  const queue: string[] = [''];
  let truncated = false;

  while (queue.length > 0 && !truncated) {
    const relativeDir = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, relativeDir), { withFileTypes: true });
    } catch {
      // A directory that cannot be read is skipped, not fatal: one unreadable
      // subtree must not cost the whole index.
      continue;
    }

    for (const entry of entries) {
      const relative = relativeDir.length === 0 ? entry.name : `${relativeDir}/${entry.name}`;

      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (options.recursive) queue.push(relative);
        continue;
      }
      if (!entry.isFile() || !matches(entry.name)) continue;

      if (files.length >= options.maxFiles) {
        truncated = true;
        break;
      }
      try {
        const stat = fs.statSync(path.join(root, relative));
        files.push({ relative, size: stat.size, modified: stat.mtime.toISOString() });
      } catch {
        /* vanished between readdir and stat; nothing to report about it */
      }
    }
  }

  files.sort((a, b) => a.relative.localeCompare(b.relative));
  return { files, truncated };
}

/** The extension, lowercased and without the dot. Empty for a file without one. */
export function extensionOf(relative: string): string {
  const name = baseName(relative);
  const at = name.lastIndexOf('.');
  return at <= 0 ? '' : name.slice(at + 1).toLowerCase();
}

/**
 * The statement that makes the index queryable.
 *
 * A view over literal rows rather than DuckDB's own `glob()`: the walk has
 * already been done for the tree, it already honours `include` and `maxFiles`,
 * and having one source of truth means the tree and `SELECT * FROM dbrex_files`
 * cannot disagree about what is in the folder.
 */
export function fileIndexSql(root: string, files: readonly IndexedFile[]): string {
  if (files.length === 0) {
    return `CREATE OR REPLACE VIEW dbrex_files AS
SELECT * FROM (VALUES ('', '', '', 0::BIGINT, NULL::TIMESTAMP))
AS t(path, name, extension, size, modified) WHERE false`;
  }

  const rows = files.map(file => {
    const absolute = path.join(root, file.relative);
    return `(${quote(absolute)}, ${quote(baseName(file.relative))}, `
      + `${quote(extensionOf(file.relative))}, ${file.size}::BIGINT, `
      + `${quote(file.modified)}::TIMESTAMP)`;
  });

  return `CREATE OR REPLACE VIEW dbrex_files AS
SELECT * FROM (VALUES ${rows.join(', ')})
AS t(path, name, extension, size, modified)`;
}

/**
 * Confine DuckDB to one directory.
 *
 * The order is load-bearing and was established by trying it, because two of
 * these three do nothing on their own:
 *
 * - `allowed_directories` alone is stored and ignored. With external access
 *   enabled everything is permitted anyway, so the list never gets consulted —
 *   a statement reading `/etc/passwd` succeeds.
 * - `enable_external_access = false` alone refuses every path, the root
 *   included, which makes the provider useless rather than safe.
 * - Together, in this order, the root is readable and nothing else is.
 *
 * `lock_configuration` is what makes it hold: without it a statement simply
 * widens the list again, since it is running the same session.
 */
export function confinementSql(root: string): string[] {
  return [
    `SET allowed_directories=[${quote(root)}]`,
    'SET enable_external_access=false',
    'SET lock_configuration=true',
  ];
}

/** A single-quoted DuckDB string literal. */
export function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** A ready-to-run SELECT over one indexed file. */
export function readTemplate(absolute: string): string {
  return `SELECT *\nFROM ${duckReaderFor(absolute)}(${quote(absolute)})\nLIMIT 100`;
}

/* ------------------------------------------------------------------ the tree */

/**
 * One level of the tree, from the index.
 *
 * Derived from the flat list rather than by reading the directory again: the
 * index is what the queries see, so the tree has to show the same thing. A
 * folder excluded by `include` therefore does not appear, which is the honest
 * answer — nothing in it is queryable.
 */
export function levelNodes(
  root: string,
  files: readonly IndexedFile[],
  at: readonly string[],
): BrowseNode[] {
  const prefix = at.length === 0 ? '' : `${at.join('/')}/`;
  const directories = new Map<string, number>();
  const here: IndexedFile[] = [];

  for (const file of files) {
    if (!file.relative.startsWith(prefix)) continue;
    const rest = file.relative.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) here.push(file);
    else {
      const name = rest.slice(0, slash);
      directories.set(name, (directories.get(name) ?? 0) + 1);
    }
  }

  const folders: BrowseNode[] = [...directories.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => ({
      kind: 'container' as const,
      name,
      hasChildren: true,
      detail: `${count} file${count === 1 ? '' : 's'}`,
      insert: quote(path.join(root, prefix, name)),
    }));

  const leaves: BrowseNode[] = here.map(file => {
    const absolute = path.join(root, file.relative);
    return {
      kind: 'object' as const,
      name: baseName(file.relative),
      hasChildren: false,
      detail: humanSize(file.size),
      // The path as a SQL literal: a reader takes a string, and a name pasted
      // bare would not run.
      insert: quote(absolute),
      query: readTemplate(absolute),
    };
  });

  return [...folders, ...leaves];
}

/* ------------------------------------------------------------------ session */

interface Config {
  readonly connection: string;
  readonly root: string;
  readonly walk: WalkOptions;
}

class DirSession implements Session {
  private connection: DuckDBConnectionLike | undefined;
  private index: FileIndex;

  constructor(
    private readonly config: Config,
    private readonly io: ProviderIo,
  ) {
    this.index = walkDirectory(config.root, config.walk);
    if (this.index.truncated) {
      io.log('warn', 'directory index stopped at its limit', {
        connection: config.connection, maxFiles: config.walk.maxFiles,
      });
    }
  }

  async *query(sql: string, options: QueryOptions = {}): AsyncGenerator<Chunk, QueryStats, void> {
    const started = Date.now();
    const connection = await this.duckdb();

    let columns: Column[];
    let rows: unknown[][];
    try {
      const result = await connection.run(sql);
      const names = result.columnNames();
      const types = result.columnTypes();
      columns = names.map((name, i) => ({ name, type: String(types[i] ?? 'Unknown') }));
      rows = (await result.getRows()).map(row => row.map(normalizeValue));
    } catch (e) {
      // No secret to redact: a directory connection has no credential.
      throw duckdbError(e, this.config.connection, undefined);
    }

    const limit = options.rowLimit;
    const kept = limit !== undefined && rows.length > limit ? rows.slice(0, limit) : rows;

    let announced = false;
    for (let at = 0; at < kept.length || !announced; at += CHUNK_ROWS) {
      yield announced ? { rows: kept.slice(at, at + CHUNK_ROWS) } : { columns, rows: kept.slice(at, at + CHUNK_ROWS) };
      announced = true;
    }

    return {
      elapsedMs: Date.now() - started,
      truncated: kept.length < rows.length,
      rowsRead: kept.length,
    };
  }

  async browse(at: readonly string[]): Promise<BrowseNode[]> {
    // Re-walked at the root so a file added since the session opened shows up
    // without reconnecting; a tree that needs a restart to see a new file is a
    // tree nobody trusts.
    if (at.length === 0) this.index = walkDirectory(this.config.root, this.config.walk);
    return levelNodes(this.config.root, this.index.files, at);
  }

  validate(): Promise<Diagnostic[]> {
    return Promise.resolve([]);
  }

  async close(): Promise<void> {
    this.connection?.closeSync?.();
    this.connection = undefined;
  }

  /**
   * The DuckDB connection, confined and indexed on first use.
   *
   * Lazy because browsing must work without DuckDB installed at all: the tree
   * is a filesystem walk, and the 70 MB download is a decision made later, on
   * purpose. Asking for it to list files would undo that.
   */
  private async duckdb(): Promise<DuckDBConnectionLike> {
    if (this.connection !== undefined) return this.connection;

    const duckdb = await loadDuckDB({ configDir: daemonConfigDir() });
    const instance = await duckdb.DuckDBInstance.create(':memory:');
    const connection = await instance.connect();

    // The index first: once the configuration is locked, the view can still be
    // created, but nothing about the order is worth risking.
    await connection.run(fileIndexSql(this.config.root, this.index.files));
    for (const statement of confinementSql(this.config.root)) await connection.run(statement);

    this.io.log('info', 'directory session ready', {
      connection: this.config.connection,
      root: this.config.root,
      files: this.index.files.length,
      truncated: this.index.truncated,
    });

    this.connection = connection;
    return connection;
  }
}

export const dirProvider: Provider = {
  id: 'dir',
  displayName: 'Local directory',
  capabilities: DIR_CAPABILITIES,
  fields: FIELDS,

  async open(spec: ConnectionSpec, _endpoint: Endpoint, io: ProviderIo): Promise<Session> {
    const options = new Options(spec.options, spec.name);
    const root = path.resolve(options.reqStr('path'));

    let stat: fs.Stats;
    try {
      stat = fs.statSync(root);
    } catch (e) {
      throw new DbRexError('config', `"${root}" does not exist`, {
        connection: spec.name,
        hint: 'check the "path" option on this connection',
      }, e);
    }
    if (!stat.isDirectory()) {
      throw new DbRexError('config', `"${root}" is not a directory`, {
        connection: spec.name,
        hint: 'point "path" at a folder; a single file is read with read_parquet or read_csv in a statement',
      });
    }

    return new DirSession({
      connection: spec.name,
      root,
      walk: {
        recursive: options.bool('recursive') ?? true,
        include: options.str('include'),
        maxFiles: options.num('maxFiles') ?? DEFAULT_MAX_FILES,
      },
    }, io);
  },
};
