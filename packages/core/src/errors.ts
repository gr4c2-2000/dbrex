/**
 * One error taxonomy for the whole system.
 *
 * The old codebase stringified every failure with `String(e?.message ?? e)` and
 * identified the single typed error by comparing `e.name` across module
 * boundaries. Callers could not tell "wrong password" from "host unreachable"
 * from "you have a typo in your SQL", so every layer re-guessed by regex.
 *
 * `DbRexError` crosses the socket intact: the daemon classifies once, and every
 * client (VSCode, CLI, MCP) decides what to do from `code` alone.
 */

export type ErrorCode =
  /** Credentials missing, rejected, or expired. Retryable after an interaction. */
  | 'auth'
  /** Interactive auth is required and no client can perform it right now. */
  | 'auth_interaction_required'
  /** Could not reach the server: DNS, TCP, TLS, tunnel. */
  | 'network'
  /** The server understood the statement and rejected it. User's SQL is wrong. */
  | 'sql'
  /** Explicitly cancelled by a client. */
  | 'cancelled'
  /** Exceeded the query deadline. */
  | 'timeout'
  /** Connection file, spec or settings are invalid. */
  | 'config'
  /** Asked for something that does not exist: unknown connection, result, provider. */
  | 'not_found'
  /** The request is well-formed but not allowed for this client role. */
  | 'forbidden'
  /** A bug in DbRex. */
  | 'internal';

export interface ErrorDetails {
  /** Connection name the failure belongs to, when it has one. */
  connection?: string;
  /** Provider-native error code, kept verbatim for the user to search for. */
  nativeCode?: string;
  /** What the user (or agent) can do about it, one sentence. */
  hint?: string;
  /** True when repeating the exact same call could succeed. */
  retryable?: boolean;
}

export class DbRexError extends Error {
  readonly code: ErrorCode;
  readonly details: ErrorDetails;

  constructor(code: ErrorCode, message: string, details: ErrorDetails = {}, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'DbRexError';
    this.code = code;
    this.details = details;
  }

  static is(e: unknown): e is DbRexError {
    return e instanceof DbRexError;
  }

  /** Wrap anything thrown by a driver, keeping the original as `cause`. */
  static wrap(code: ErrorCode, e: unknown, details: ErrorDetails = {}): DbRexError {
    if (DbRexError.is(e)) return e;
    return new DbRexError(code, messageOf(e), details, e);
  }

  toWire(): WireError {
    return { code: this.code, message: this.message, details: this.details };
  }

  static fromWire(w: WireError): DbRexError {
    return new DbRexError(w.code, w.message, w.details ?? {});
  }
}

export interface WireError {
  code: ErrorCode;
  message: string;
  details?: ErrorDetails;
}

/** Best-effort message extraction from an unknown throw. Never throws. */
export function messageOf(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') {
    const m = (e as { message?: unknown }).message;
    if (typeof m === 'string' && m.length > 0) return m;
  }
  return String(e);
}

/** True for aborts raised by `AbortSignal`, which arrive as a DOMException. */
export function isAbortError(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { name?: unknown }).name === 'AbortError';
}
