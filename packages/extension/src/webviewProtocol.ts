/**
 * Messages between the extension host and the results webview.
 *
 * Imported by both sides. The old panel declared its message shapes on the host
 * only and the webview duck-typed `m?.type` off the wire, so three message
 * kinds were declared and never sent, one was sent and never handled, and a
 * field was plumbed end-to-end through the whole tool surface without anything
 * ever reading it. A shared union makes that class of drift a type error.
 */

import type { Column, QueryStats } from '@dbrex/core';

/** Bumped when a shape changes; the webview refuses a version it does not know. */
export const WEBVIEW_PROTOCOL = 2;

/**
 * Which half of the panel a message belongs to.
 *
 * An agent and a person share one panel, and before this they shared one slot:
 * an agent exploring a schema replaced the result someone was reading, several
 * times a minute. Two lanes, so neither can overwrite the other's work.
 */
export type Lane = 'user' | 'agent';

export interface ViewDefinition {
  readonly name: string;
  readonly label: string;
  /** `render(data, ctx)` source, run inside the sandboxed frame. */
  readonly code: string;
  /** Stylesheet from the manifest, applied inside the frame and nowhere else. */
  readonly css?: string;
}

export type HostMessage =
  | { readonly type: 'hello'; readonly protocol: number }
  | {
      readonly type: 'result';
      readonly lane: Lane;
      readonly resultId: string;
      readonly connection: string;
      readonly sql: string;
      readonly columns: readonly Column[];
      readonly rowCount: number;
      readonly stats: QueryStats;
      readonly views: readonly ViewDefinition[];
      /** Tab to open, when the query's manifest asks for one. */
      readonly defaultView?: string;
    }
  | {
      readonly type: 'rows';
      readonly lane: Lane;
      readonly offset: number;
      readonly rows: readonly (readonly unknown[])[];
    }
  | { readonly type: 'running'; readonly lane: Lane; readonly connection: string; readonly sql: string }
  | { readonly type: 'progress'; readonly lane: Lane; readonly rows: number }
  | { readonly type: 'failed'; readonly lane: Lane; readonly message: string; readonly hint?: string };

export type WebviewMessage =
  | { readonly type: 'ready'; readonly protocol: number }
  | { readonly type: 'requestRows'; readonly lane: Lane; readonly offset: number; readonly limit: number }
  // Only a user lane can cancel: an agent's query is cancelled through MCP.
  | { readonly type: 'cancel' }
  | { readonly type: 'copy'; readonly text: string }
  | { readonly type: 'viewFailed'; readonly view: string; readonly message: string };
