/**
 * Finding DuckDB.
 *
 * DuckDB is how an object-store connection actually runs SQL, and it is a
 * native module: the JavaScript wrapper is half a megabyte, but each platform's
 * binding is about 70 MB. The old extension depended on all seven of them at
 * once, which is the entire reason its `.vsix` weighed 195 MB — a number every
 * user paid, including the ones who never touched a bucket.
 *
 * So DuckDB is not bundled. It is resolved at the moment a query needs it, from
 * whichever of these exists:
 *
 *   1. `DBREX_DUCKDB` — an explicit path, for packagers and for development.
 *   2. `<config dir>/duckdb/node_modules` — where `dbrex install-duckdb` puts it.
 *   3. The daemon's own dependencies — for a platform-specific build that
 *      chooses to bundle it after all.
 *
 * Browsing a bucket never needs any of this; it is plain HTTPS. Only querying
 * does. That split is deliberate: the sidebar works the moment you add a
 * connection, and the 70 MB is a decision you make later, on purpose.
 */

import { createRequire } from 'node:module';
import * as path from 'node:path';
import { DbRexError } from '@dbrex/core';

/** The slice of `@duckdb/node-api` this provider uses. */
export interface DuckDBModule {
  DuckDBInstance: {
    create(path: string): Promise<DuckDBInstanceLike>;
  };
}

export interface DuckDBInstanceLike {
  connect(): Promise<DuckDBConnectionLike>;
}

export interface DuckDBConnectionLike {
  run(sql: string): Promise<DuckDBResultLike>;
  closeSync?(): void;
}

export interface DuckDBResultLike {
  columnNames(): string[];
  columnTypes(): unknown[];
  getRows(): Promise<unknown[][]>;
}

export interface DuckDBLocation {
  readonly configDir: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** Where `install-duckdb` puts its copy. */
export function duckdbInstallDir(configDir: string): string {
  return path.join(configDir, 'duckdb');
}

export function duckdbSearchPaths(location: DuckDBLocation): string[] {
  const env = location.env ?? process.env;
  const explicit = env['DBREX_DUCKDB'];
  return [
    ...(explicit ? [explicit] : []),
    path.join(duckdbInstallDir(location.configDir), 'node_modules', '@duckdb', 'node-api'),
    '@duckdb/node-api',
  ];
}

/**
 * Load DuckDB, or explain precisely how to get it.
 *
 * The failure is a `config` error rather than an `internal` one because it is
 * not a bug: it is a component the user has not installed yet, and the hint
 * says what to run.
 */
export async function loadDuckDB(location: DuckDBLocation): Promise<DuckDBModule> {
  const attempts: string[] = [];

  for (const candidate of duckdbSearchPaths(location)) {
    try {
      // `createRequire` resolves from this file, so a bare specifier still finds
      // the daemon's own dependencies when a build chooses to bundle them.
      const require = createRequire(__filename);
      const loaded = require(candidate) as DuckDBModule;
      if (loaded?.DuckDBInstance) return loaded;
      attempts.push(`${candidate}: loaded but has no DuckDBInstance`);
    } catch (e) {
      attempts.push(`${candidate}: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    }
  }

  throw new DbRexError('config', 'DuckDB is not installed, so object-store queries cannot run', {
    hint: 'run `dbrex install-duckdb` once (about 70 MB); browsing buckets works without it',
    retryable: true,
  }, new Error(attempts.join('; ')));
}
