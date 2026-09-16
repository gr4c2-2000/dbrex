/**
 * Interaction broker.
 *
 * The daemon owns the database connections; it does not own a human. When a
 * connection needs a password typed or a browser opened, the broker asks the
 * clients that are attached right now and takes the first real answer.
 *
 * The rule that matters: a password prompt is only ever offered to clients that
 * may answer one — a VSCode window or a terminal. An AI agent connected over
 * MCP is never asked, because a secret typed into a chat lands in a transcript
 * and in model logs. A login URL is different: it is public and single-use, so
 * an agent may relay it to its human. Both rules come from `@dbrex/core`'s role
 * predicates rather than from an `if` written here, so client code and daemon
 * code cannot disagree about them.
 */

import {
  DbRexError,
  canAnswerSecrets,
  canRelayBrowser,
  type ClientRole,
  type DaemonMessage,
  type InteractionDetail,
} from '@dbrex/core';

export interface ClientHandle {
  readonly id: number;
  readonly role: ClientRole;
  readonly label: string;
  readonly workspace?: string;
  send(message: DaemonMessage): void;
}

interface Pending {
  readonly id: number;
  readonly detail: InteractionDetail;
  readonly connection: string;
  readonly asked: Set<number>;
  readonly resolve: (value: string) => void;
  readonly reject: (error: unknown) => void;
  readonly declined: Set<number>;
  timer?: NodeJS.Timeout;
}

export interface BrokerOptions {
  /** How long a human has to answer before the request fails. */
  readonly timeoutMs: number;
}

export class Broker {
  private clients = new Map<number, ClientHandle>();
  private pending = new Map<number, Pending>();
  private nextId = 1;

  constructor(private readonly options: BrokerOptions = { timeoutMs: 180_000 }) {}

  attach(client: ClientHandle): void {
    this.clients.set(client.id, client);
  }

  /**
   * Drop a client. Any interaction that only it could answer fails now rather
   * than hanging until the timeout — a closed VSCode window should not leave an
   * agent waiting three minutes for a password box that no longer exists.
   */
  detach(clientId: number): void {
    this.clients.delete(clientId);
    for (const pending of [...this.pending.values()]) {
      if (!pending.asked.has(clientId)) continue;
      pending.asked.delete(clientId);
      if (pending.asked.size === 0) {
        this.fail(pending, new DbRexError('auth_interaction_required',
          `nobody is available to answer: ${describe(pending.detail)}`, {
            connection: pending.connection,
            hint: 'open the workspace in VSCode, or run `dbrex unlock`',
            retryable: true,
          }));
      }
    }
  }

  /** Ask for a secret. Only `ui` and `tty` clients are offered the prompt. */
  askSecret(connection: string, prompt: string): Promise<string> {
    return this.ask(connection, { kind: 'secret', prompt }, canAnswerSecrets);
  }

  /** Ask for the vault passphrase. Same audience as a secret. */
  askUnlock(prompt: string): Promise<string> {
    return this.ask('', { kind: 'unlock', prompt }, canAnswerSecrets);
  }

  /**
   * Ask a human to visit a URL. Resolves once some client has taken it on —
   * the provider then polls the identity provider itself.
   */
  async askBrowser(connection: string, url: string, reason: string): Promise<void> {
    await this.ask(connection, { kind: 'browser', url, reason }, canRelayBrowser);
  }

  /** A client answered, or declined and passed the request on. */
  reply(clientId: number, interactionId: number, value?: string, declined?: boolean): void {
    const pending = this.pending.get(interactionId);
    if (!pending || !pending.asked.has(clientId)) return;

    if (declined || value === undefined) {
      pending.declined.add(clientId);
      if (pending.declined.size >= pending.asked.size) {
        this.fail(pending, new DbRexError('auth_interaction_required',
          `every attached client declined: ${describe(pending.detail)}`, {
            connection: pending.connection,
            retryable: true,
          }));
      }
      return;
    }

    this.settle(pending, () => pending.resolve(value));
  }

  /** Clients currently able to answer a secret prompt. For diagnostics. */
  interactiveClients(): ClientHandle[] {
    return [...this.clients.values()].filter(c => canAnswerSecrets(c.role));
  }

  private ask(
    connection: string,
    detail: InteractionDetail,
    eligible: (role: ClientRole) => boolean,
  ): Promise<string> {
    const audience = [...this.clients.values()].filter(c => eligible(c.role));
    if (audience.length === 0) {
      return Promise.reject(new DbRexError('auth_interaction_required',
        `no client can answer: ${describe(detail)}`, {
          connection,
          hint: detail.kind === 'browser'
            ? 'attach a client that can show a login URL'
            : 'open this workspace in VSCode, or run `dbrex unlock` in a terminal',
          retryable: true,
        }));
    }

    const id = this.nextId++;
    return new Promise<string>((resolve, reject) => {
      const pending: Pending = {
        id,
        detail,
        connection,
        asked: new Set(audience.map(c => c.id)),
        declined: new Set(),
        resolve,
        reject,
      };
      pending.timer = setTimeout(() => {
        this.fail(pending, new DbRexError('timeout', `timed out waiting for: ${describe(detail)}`, {
          connection,
          retryable: true,
        }));
      }, this.options.timeoutMs);
      pending.timer.unref?.();
      this.pending.set(id, pending);

      for (const client of audience) {
        client.send({ event: 'interaction', interactionId: id, connection, detail });
      }
    });
  }

  private fail(pending: Pending, error: DbRexError): void {
    this.settle(pending, () => pending.reject(error));
  }

  /** Resolve or reject exactly once, and tell every other client to stop asking. */
  private settle(pending: Pending, finish: () => void): void {
    if (!this.pending.delete(pending.id)) return;
    if (pending.timer) clearTimeout(pending.timer);
    for (const clientId of pending.asked) {
      this.clients.get(clientId)?.send({ event: 'interactionClosed', interactionId: pending.id });
    }
    finish();
  }
}

function describe(detail: InteractionDetail): string {
  switch (detail.kind) {
    case 'secret': return detail.prompt;
    case 'unlock': return detail.prompt;
    case 'browser': return detail.reason;
  }
}
