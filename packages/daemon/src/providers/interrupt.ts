/**
 * Cancellation and deadlines, for providers whose driver offers neither.
 *
 * Both MySQL and PostgreSQL stop a query the same way here: destroy the socket.
 * What matters is that the *reason* is remembered. Once the socket is gone the
 * driver reports a lost connection, and reporting a cancelled query as a
 * network failure is exactly the confusion the error taxonomy exists to end.
 *
 * Shared rather than copied because the subtlety — first reason wins, and the
 * listener has to come off the signal when the query finishes normally — is not
 * something two implementations should be trusted to keep agreeing on.
 */

import type { QueryOptions } from '@dbrex/core';

export type Interruption = 'cancelled' | 'timeout';

export interface Interrupt {
  /** Why the query was stopped, or `undefined` if it was not. */
  readonly reason: () => Interruption | undefined;
  /** Drop the timer and the abort listener. Safe to call more than once. */
  readonly disarm: () => void;
}

export function armInterrupt(
  options: QueryOptions | undefined,
  interrupt: () => void,
): Interrupt {
  let reason: Interruption | undefined;
  const fire = (r: Interruption): void => {
    if (reason !== undefined) return;
    reason = r;
    interrupt();
  };
  const onAbort = (): void => fire('cancelled');
  const signal = options?.signal;
  const timer = options?.timeoutMs === undefined
    ? undefined
    : setTimeout(() => fire('timeout'), options.timeoutMs);
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) fire('cancelled');
  return {
    reason: () => reason,
    disarm: () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}
