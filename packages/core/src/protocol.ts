/**
 * Wire protocol between clients and the daemon.
 *
 * Framing is newline-delimited JSON over a Unix domain socket. One connection
 * carries many concurrent requests; every request has an id and every response
 * echoes it. The daemon also pushes unsolicited events, which is the whole
 * point of the design: the daemon owns the database connections but not the
 * human, so when it needs a password or a browser it asks a client that has one.
 *
 * Roles decide who may be asked what. An agent connected over MCP must never
 * receive a password prompt — a secret typed into a chat window ends up in a
 * transcript and in model logs — so `interaction` events of kind `secret` are
 * only ever routed to `ui` and `tty` clients. That rule lives at the protocol
 * level, not in a comment somewhere in the daemon.
 */

import type { BrowseNode, Column, Diagnostic, QueryStats } from './provider';
import type { ConnectionSpec, FieldSpec, SecretSource } from './spec';
import type { Capabilities } from './capabilities';
import type { WireError } from './errors';

/** Bumped on any breaking change. The daemon refuses mismatched majors. */
export const PROTOCOL_VERSION = 1;

export type ClientRole =
  /** A graphical client that can prompt and open a browser. VSCode. */
  | 'ui'
  /** A terminal client attached to a tty. Can prompt and print a URL. */
  | 'tty'
  /** An AI agent over MCP. May relay a URL to a human; may never be asked for a secret. */
  | 'agent'
  /** A script. Never asked for anything; missing credentials are a hard error. */
  | 'headless';

/** True when this role is allowed to answer a secret prompt. */
export function canAnswerSecrets(role: ClientRole): boolean {
  return role === 'ui' || role === 'tty';
}

/** True when this role can put a login URL in front of a human. */
export function canRelayBrowser(role: ClientRole): boolean {
  return role !== 'headless';
}

// ---------------------------------------------------------------- requests

export interface Hello {
  readonly op: 'hello';
  readonly protocol: number;
  readonly role: ClientRole;
  /** For logs and for the "which client answered" audit trail. */
  readonly client: string;
  /** Workspace this client speaks for, if any. Scopes visible connections. */
  readonly workspace?: string;
}

export interface ListConnections {
  readonly op: 'listConnections';
}

export interface DescribeProviders {
  readonly op: 'describeProviders';
}

export interface RunQuery {
  readonly op: 'query';
  readonly connection: string;
  readonly sql: string;
  readonly rowLimit?: number;
  readonly timeoutMs?: number;
  readonly settings?: Readonly<Record<string, string | number | boolean>>;
}

/** Cancel an in-flight request by the id it was sent with. */
export interface Cancel {
  readonly op: 'cancel';
  readonly target: number;
}

export interface ReadRows {
  readonly op: 'readRows';
  readonly resultId: string;
  readonly offset: number;
  readonly limit: number;
}

export interface ListResults {
  readonly op: 'listResults';
  readonly limit?: number;
}

export interface PinResult {
  readonly op: 'pinResult';
  readonly resultId: string;
  readonly pinned: boolean;
}

export interface DeleteResult {
  readonly op: 'deleteResult';
  readonly resultId: string;
}

export interface Browse {
  readonly op: 'browse';
  readonly connection: string;
  readonly path: readonly string[];
}

export interface Validate {
  readonly op: 'validate';
  readonly connection: string;
  readonly sql: string;
}

/** Store a secret for a connection. Refused for roles that cannot answer secrets. */
export interface SetSecret {
  readonly op: 'setSecret';
  readonly connection: string;
  readonly value: string;
}

export interface VaultStatus {
  readonly op: 'vaultStatus';
}

/** Unlock the vault for this daemon's lifetime. Refused for agent/headless roles. */
export interface Unlock {
  readonly op: 'unlock';
  readonly passphrase: string;
}

export interface ReloadConnections {
  readonly op: 'reloadConnections';
}

/**
 * Ask the clients that have a screen to display a stored result.
 *
 * This is how an agent puts what it found in front of a person. It carries a
 * result id and nothing else — the old equivalents let an agent hand the panel
 * JavaScript to execute, which is exactly the hole this design closes.
 */
export interface ShowResult {
  readonly op: 'showResult';
  readonly resultId: string;
}

/** Change daemon settings and apply them now. Refused for agents. */
export interface UpdateSettings {
  readonly op: 'updateSettings';
  readonly settings: SettingsPatch;
}

export interface SettingsPatch {
  readonly identityUser?: string;
  /** Put an agent's query result on screen as soon as it finishes. */
  readonly showAgentResults?: boolean;
  readonly resultsMode?: 'sliding' | 'unlimited';
  readonly resultsMaxBytes?: number;
  readonly logLevel?: 'debug' | 'info' | 'warn' | 'error';
}

export type RequestBody =
  | Hello
  | ListConnections
  | DescribeProviders
  | RunQuery
  | Cancel
  | ReadRows
  | ListResults
  | PinResult
  | DeleteResult
  | Browse
  | Validate
  | SetSecret
  | VaultStatus
  | Unlock
  | ReloadConnections
  | ShowResult
  | UpdateSettings;

export type RequestOp = RequestBody['op'];

export type Request = RequestBody & { readonly id: number };

// --------------------------------------------------------------- responses

/** A connection as clients see it: never carries a secret value. */
export interface ConnectionInfo {
  readonly name: string;
  readonly kind: string;
  readonly reference?: string;
  /** Where this one came from, so "why do I see this?" has an answer. */
  readonly origin: 'global' | 'workspace';
  readonly secretSource: SecretSource['from'] | 'none';
  /** False when the daemon knows it cannot get the secret without a human. */
  readonly ready: boolean;
  readonly capabilities: Capabilities;
}

export interface ProviderInfo {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: Capabilities;
  readonly fields: readonly FieldSpec[];
}

export interface ResultSummary {
  readonly resultId: string;
  readonly connection: string;
  readonly sql: string;
  readonly createdAt: string;
  readonly columns: readonly Column[];
  readonly rowCount: number;
  readonly sizeBytes: number;
  readonly truncated: boolean;
  readonly pinned: boolean;
}

export interface QueryResponse {
  readonly resultId: string;
  readonly columns: readonly Column[];
  readonly stats: QueryStats;
  readonly rowCount: number;
}

export interface RowsResponse {
  readonly resultId: string;
  readonly offset: number;
  readonly rows: readonly (readonly unknown[])[];
  /** Total rows stored, so a client can page without guessing. */
  readonly total: number;
}

export interface VaultState {
  readonly exists: boolean;
  readonly unlocked: boolean;
}

export interface ResponseValues {
  hello: { readonly daemonVersion: string; readonly protocol: number };
  listConnections: { readonly connections: readonly ConnectionInfo[] };
  describeProviders: { readonly providers: readonly ProviderInfo[] };
  query: QueryResponse;
  cancel: Record<string, never>;
  readRows: RowsResponse;
  listResults: { readonly results: readonly ResultSummary[] };
  pinResult: Record<string, never>;
  deleteResult: Record<string, never>;
  browse: { readonly nodes: readonly BrowseNode[] };
  validate: { readonly diagnostics: readonly Diagnostic[] };
  setSecret: Record<string, never>;
  vaultStatus: VaultState;
  unlock: Record<string, never>;
  reloadConnections: { readonly connections: readonly ConnectionInfo[] };
  showResult: { readonly shown: number };
  updateSettings: Record<string, never>;
}

export type Response =
  | { readonly id: number; readonly ok: true; readonly value: ResponseValues[RequestOp] }
  | { readonly id: number; readonly ok: false; readonly error: WireError };

// ------------------------------------------------------------------ events

/**
 * The daemon needs something a human must supply. The client answers with an
 * `interactionReply`, or declines so the daemon can try another client.
 */
export interface InteractionEvent {
  readonly event: 'interaction';
  readonly interactionId: number;
  readonly connection: string;
  readonly detail: InteractionDetail;
}

export type InteractionDetail =
  | { readonly kind: 'secret'; readonly prompt: string }
  | { readonly kind: 'unlock'; readonly prompt: string }
  /** Open this URL. No reply value; the daemon polls the identity provider itself. */
  | { readonly kind: 'browser'; readonly url: string; readonly reason: string };

/** Another client answered first, or the daemon gave up. Stop showing the prompt. */
export interface InteractionClosedEvent {
  readonly event: 'interactionClosed';
  readonly interactionId: number;
}

export interface QueryProgressEvent {
  readonly event: 'queryProgress';
  /** The id of the `query` request this progress belongs to. */
  readonly target: number;
  readonly rows: number;
}

export interface ConnectionsChangedEvent {
  readonly event: 'connectionsChanged';
  readonly connections: readonly ConnectionInfo[];
}

/**
 * A result was stored, pinned or evicted. Carries the summary so a history view
 * never has to poll — the old store only notified on save, so evicted rows
 * stayed on screen until something else was saved.
 */
export interface ResultsChangedEvent {
  readonly event: 'resultsChanged';
  readonly change: 'saved' | 'pinned' | 'deleted';
  readonly resultId: string;
  readonly summary?: ResultSummary;
}

/** A client with a screen is asked to display a stored result. */
export interface ShowResultEvent {
  readonly event: 'showResult';
  readonly resultId: string;
  readonly summary: ResultSummary;
}

export type Event =
  | ShowResultEvent
  | InteractionEvent
  | InteractionClosedEvent
  | QueryProgressEvent
  | ConnectionsChangedEvent
  | ResultsChangedEvent;

/** A client's answer to an `interaction` event. */
export interface InteractionReply {
  readonly op: 'interactionReply';
  readonly interactionId: number;
  /** Present for `secret` and `unlock`; absent for `browser` and for declines. */
  readonly value?: string;
  /** True when this client cannot or will not answer; the daemon asks another. */
  readonly declined?: boolean;
}

export type ClientMessage = Request | InteractionReply;
export type DaemonMessage = Response | Event;

export function isInteractionReply(m: ClientMessage): m is InteractionReply {
  return (m as InteractionReply).op === 'interactionReply';
}

export function isEvent(m: DaemonMessage): m is Event {
  return typeof (m as Event).event === 'string';
}

/** Connection specs as loaded from disk, before secrets or substitution. */
export interface ConnectionFile {
  readonly connections: readonly ConnectionSpec[];
}
