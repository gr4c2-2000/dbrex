/**
 * Messages between the extension host and the connection form.
 *
 * Imported by both sides, for the reason the results protocol gives: a union
 * shared across the boundary turns a message one side sends and the other never
 * handles into a type error rather than into silence.
 */

import type { FieldSpec } from '@dbrex/core';

export const FORM_PROTOCOL = 1;

/** Where a connection is written. */
export type Scope = 'global' | 'workspace';

/** A provider as the form needs it: a label, and the fields to draw. */
export interface FormProvider {
  readonly id: string;
  readonly displayName: string;
  readonly fields: readonly FieldSpec[];
  /** True when the engine takes a password, so the form offers one. */
  readonly takesSecret: boolean;
}

export interface ScopeOption {
  readonly scope: Scope;
  /** The file this scope writes to, shown so the choice is not abstract. */
  readonly file: string;
  /** False when there is no folder open to write a workspace file into. */
  readonly available: boolean;
}

/** Everything the form needs to draw itself. */
export interface FormBootstrap {
  readonly protocol: number;
  readonly providers: readonly FormProvider[];
  readonly scopes: readonly ScopeOption[];
  /** Names already taken, so a clash is caught before the file is written. */
  readonly existing: readonly string[];
}

/** What the user filled in. Values are raw strings; the host coerces them. */
export interface FormSubmission {
  readonly name: string;
  readonly kind: string;
  readonly reference: string;
  readonly scope: Scope;
  readonly options: Readonly<Record<string, string>>;
  /** Stored in the vault after the entry is written, when given. */
  readonly password: string;
}

/** One thing wrong, addressed to the field it belongs to. */
export interface FormProblem {
  readonly field: string;
  readonly message: string;
}

export type FormHostMessage =
  | { readonly type: 'bootstrap'; readonly data: FormBootstrap }
  /**
   * A save was refused; the form stays open with what it got wrong.
   *
   * The problems travel in the message rather than being inferred, so each one
   * lands on the field it is about instead of in a banner the user then has to
   * map back onto a form.
   */
  | { readonly type: 'failed'; readonly message: string; readonly problems: readonly FormProblem[] }
  | { readonly type: 'saved'; readonly name: string };

export type FormWebviewMessage =
  | { readonly type: 'ready'; readonly protocol: number }
  | { readonly type: 'submit'; readonly submission: FormSubmission }
  | { readonly type: 'cancel' };
