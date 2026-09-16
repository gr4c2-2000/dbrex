/**
 * What a provider can actually do.
 *
 * In the old codebase every consumer switched on the connection kind: the
 * schema query, the SQL validator, the keyword list, the default-LIMIT
 * rewriter, the explorer, and the add-connection wizard each carried their own
 * `switch (kind)`. Adding a fifth data source meant finding all of them.
 *
 * Here a provider declares its capabilities once and shared code reads them.
 * No code outside a provider implementation may branch on a provider id.
 */

/** How this engine spells a row limit, if it has one. */
export type LimitSyntax =
  | 'limit'        // MySQL, ClickHouse, DuckDB, Trino: `... LIMIT n`
  | 'fetch-first'  // SQL standard: `... FETCH FIRST n ROWS ONLY`
  | 'none';        // no row-limiting clause; the caller must slice

/** How far a cancellation actually reaches. */
export type CancelSupport =
  | 'server'     // we can tell the engine to abandon the query (Trino DELETE, ClickHouse KILL)
  | 'transport'  // we can only drop the connection; the server may keep working
  | 'none';      // the query runs to completion no matter what

/** What kind of "check this without running it" the engine offers. */
export type ExplainSupport =
  | 'analyze'   // EXPLAIN ANALYZE — runs the query and reports real timings
  | 'validate'  // parse/plan only, guaranteed not to scan data
  | 'plan'      // EXPLAIN — plan only
  | 'none';

export interface Capabilities {
  readonly limit: LimitSyntax;
  /**
   * True when the provider bounds its own memory: it yields rows as they
   * arrive and never holds the whole result.
   *
   * This is not the same question as whether the engine stops producing rows.
   * A streaming provider that stops reading still leaves the server working —
   * the way to make the server stop is to put the limit in the SQL, which
   * shared code does whenever `limit` is not `'none'`. What this flag governs
   * is whether a client may run a large query without risking the daemon.
   */
  readonly streams: boolean;
  readonly cancel: CancelSupport;
  readonly explain: ExplainSupport;
  /** Supports `browse()` for the schema tree. */
  readonly browse: boolean;
  /** Supports `validate()` for editor diagnostics. */
  readonly validate: boolean;
  /** Accepts per-query engine settings passthrough. */
  readonly settings: boolean;
  /** Completion keywords for this dialect. */
  readonly keywords: readonly string[];
}

/** Conservative defaults: a provider only declares what it genuinely supports. */
export const MINIMAL_CAPABILITIES: Capabilities = {
  limit: 'none',
  streams: false,
  cancel: 'none',
  explain: 'none',
  browse: false,
  validate: false,
  settings: false,
  keywords: [],
};

export function capabilities(over: Partial<Capabilities>): Capabilities {
  return { ...MINIMAL_CAPABILITIES, ...over };
}
