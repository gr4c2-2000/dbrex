/**
 * The provider contract.
 *
 * Two deliberate departures from the old `DbAdapter`:
 *
 * 1. `query` streams. The old interface returned a fully materialised
 *    `QueryResult`, so `rowLimit` could only be a post-hoc `slice` — the memory
 *    was already spent by the time the limit applied. A generator lets the
 *    daemon spool rows to disk and stop early.
 * 2. Interaction is a dependency, not a caller's problem. The old code ran the
 *    Trino SSO flow in `extension.ts`, so the MCP path silently skipped it and
 *    agents got a raw 401. A provider that needs a human asks `io`, and the
 *    daemon routes that to whichever client can answer.
 */

import type { Capabilities } from './capabilities';
import type { ConnectionSpec, FieldSpec } from './spec';

export interface Column {
  readonly name: string;
  /** Engine-native type name, shown verbatim. */
  readonly type: string;
}

/**
 * One batch of rows. The first chunk of a query carries `columns`; later chunks
 * omit it. Rows are positional to match the columns.
 */
export interface Chunk {
  readonly columns?: readonly Column[];
  readonly rows: readonly (readonly unknown[])[];
}

export interface QueryStats {
  readonly elapsedMs: number;
  /** True when we stopped short of the full result because of `rowLimit`. */
  readonly truncated: boolean;
  readonly rowsRead?: number;
  readonly bytesRead?: number;
  /** Rows a write touched. The only outcome an INSERT or UPDATE has to report. */
  readonly affectedRows?: number;
  /** Engine-native query id, when there is one worth showing. */
  readonly nativeQueryId?: string;
}

export interface QueryOptions {
  /**
   * Stop after this many rows.
   *
   * Shared code has usually already pushed this into the SQL. It is repeated
   * here as a backstop for statements that cannot be rewritten — `SHOW`, or a
   * statement that already carries its own limit.
   */
  readonly rowLimit?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Engine settings passthrough. Ignored unless `capabilities.settings`. */
  readonly settings?: Readonly<Record<string, string | number | boolean>>;
}

/** A node in the browse tree. Uniform across relational engines and object stores. */
export interface BrowseNode {
  readonly kind: 'database' | 'schema' | 'table' | 'view' | 'column' | 'container' | 'object';
  readonly name: string;
  /** Column type, object size — whatever this node's detail line should say. */
  readonly detail?: string;
  readonly hasChildren: boolean;
  /**
   * Text to insert when the user clicks this node. Defaults to `name`: the
   * qualified identifier for a table, the object's URL for a file.
   */
  readonly insert?: string;
  /**
   * A complete statement that reads this node, when one makes sense.
   *
   * Separate from `insert` because the two answer different questions. Halfway
   * through writing a `FROM` clause you want the name; starting from nothing
   * you want a query that runs. A column has a name but no query of its own.
   */
  readonly query?: string;
}

export interface Diagnostic {
  readonly message: string;
  /**
   * Byte offset into the text that was passed to `validate`, when the engine
   * reports a position. The text may hold several statements, so this is an
   * offset into that whole text and not into one statement within it.
   */
  readonly offset?: number;
  readonly severity: 'error' | 'warning';
}

/** What a provider needs from the world. Supplied by the daemon, never by a client. */
export interface ProviderIo {
  /**
   * Resolve a secret for this connection, prompting a human if there is no
   * stored value. The daemon decides where it comes from — command, env, vault,
   * or a prompt routed to an interactive client — and enforces that agents can
   * never answer a password prompt.
   */
  secret(purpose: SecretPurpose): Promise<string>;
  /**
   * The stored value, or undefined. Never prompts.
   *
   * A provider whose credential it can obtain itself — an OAuth token, say —
   * must not trigger a password box just to discover that it has no token yet.
   */
  storedSecret(purpose: SecretPurpose): Promise<string | undefined>;
  /**
   * Persist a credential the provider obtained on its own, so the next session
   * and the next daemon restart start authenticated.
   */
  rememberSecret(purpose: SecretPurpose, value: string): Promise<void>;
  /** Ask a human to do something out of band, e.g. finish a browser login. */
  interactive(request: InteractionRequest): Promise<void>;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>): void;
}

export type SecretPurpose =
  | { readonly kind: 'password' }
  | { readonly kind: 'token'; readonly label: string };

export type InteractionRequest =
  /** Open this URL and come back; the provider polls for completion itself. */
  | { readonly kind: 'browser'; readonly url: string; readonly reason: string };

export interface Session {
  query(sql: string, options?: QueryOptions): AsyncGenerator<Chunk, QueryStats, void>;
  /** Children of a tree path. `[]` is the root. Only when `capabilities.browse`. */
  browse(path: readonly string[]): Promise<BrowseNode[]>;
  /** Check a statement without scanning data. Only when `capabilities.validate`. */
  validate(sql: string): Promise<Diagnostic[]>;
  close(): Promise<void>;
}

export interface Provider {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: Capabilities;
  /** Options this provider accepts, for validation, the wizard and the docs. */
  readonly fields: readonly FieldSpec[];
  /**
   * Open a session. `spec.options` has already been substituted, defaulted and
   * validated against `fields`; `tunnel` has already been established and the
   * host/port in `endpoint` point at the local end of it.
   */
  open(spec: ConnectionSpec, endpoint: Endpoint, io: ProviderIo): Promise<Session>;
}

/**
 * Where to actually connect. Split out from the spec because an SSH tunnel
 * rewrites the address while TLS must still verify the real hostname — a
 * subtlety the old code got right and which is easy to lose in a rewrite.
 */
export interface Endpoint {
  readonly host: string;
  readonly port: number;
  /** Hostname to verify TLS against, when a tunnel moved the address. */
  readonly tlsServerName?: string;
}
