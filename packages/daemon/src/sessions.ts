/**
 * Session pool.
 *
 * One live provider session per connection, shared by every client. This is the
 * piece that makes the daemon worth having: a query typed in VSCode and a query
 * issued by an agent go through the same session, the same credentials and the
 * same tunnel, so they cannot disagree about what "prod" means.
 *
 * Two failures from the old `ConnectionManager` are fixed here:
 *
 * - Opening was not deduplicated. Two concurrent callers each awaited a
 *   resolve, a tunnel and a connect, then both wrote to the cache — leaving one
 *   orphaned adapter and, with an SSH tunnel, a second `ssh` process.
 * - A cancelled MySQL query destroys the socket. The UI path repaired the cache
 *   afterwards; the MCP path did not, so one timed-out agent query poisoned the
 *   connection until the window was reloaded. Invalidation lives in the pool
 *   now, so every caller gets it.
 */

import {
  DbRexError,
  type Endpoint,
  type Provider,
  type ProviderIo,
  type SecretPurpose,
  type Session,
} from '@dbrex/core';
import type { RegisteredConnection } from './connections';
import type { ProviderRegistry } from './providers/registry';
import type { SecretResolver } from './secrets';
import type { Broker } from './broker';
import type { Logger } from './log';
import { TunnelManager, type OpenTunnel } from './tunnel';

/**
 * How many credentials one connect may try.
 *
 * Bounded on purpose: an unbounded loop against a real server is how accounts
 * get locked out.
 */
const MAX_CREDENTIAL_ATTEMPTS = 3;

interface Entry {
  readonly session: Session;
  readonly tunnel?: OpenTunnel;
  readonly provider: Provider;
}

export class SessionPool {
  private readonly open = new Map<string, Entry>();
  private readonly opening = new Map<string, Promise<Entry>>();
  private readonly tunnels = new TunnelManager();

  constructor(
    private readonly providers: ProviderRegistry,
    private readonly secrets: SecretResolver,
    private readonly broker: Broker,
    private readonly logger: Logger,
  ) {}

  async acquire(connection: RegisteredConnection): Promise<{ session: Session; provider: Provider }> {
    const key = this.key(connection);

    const existing = this.open.get(key);
    if (existing) return { session: existing.session, provider: existing.provider };

    let pending = this.opening.get(key);
    if (!pending) {
      pending = this.start(key, connection);
      this.opening.set(key, pending);
      pending.finally(() => this.opening.delete(key)).catch(() => {});
    }
    const entry = await pending;
    return { session: entry.session, provider: entry.provider };
  }

  /** Look up a provider without opening anything. For capability reporting. */
  providerFor(connection: RegisteredConnection): Provider {
    return this.providers.require(connection.spec.kind);
  }

  /**
   * Drop a session so the next caller reconnects. Call this whenever a failure
   * could have left the underlying connection unusable — a cancelled query, a
   * transport error, a credential change.
   */
  async invalidate(connection: RegisteredConnection): Promise<void> {
    await this.close(this.key(connection));
  }

  async invalidateAll(): Promise<void> {
    await Promise.all([...this.open.keys()].map(key => this.close(key)));
    this.tunnels.closeAll();
  }

  private async close(key: string): Promise<void> {
    const entry = this.open.get(key);
    if (!entry) return;
    this.open.delete(key);
    try {
      await entry.session.close();
    } catch (e) {
      this.logger.warn('closing a session failed', { key, error: String(e) });
    }
    entry.tunnel?.close();
  }

  private key(connection: RegisteredConnection): string {
    return `${connection.secretScope}/${connection.spec.name}`;
  }

  private async start(key: string, connection: RegisteredConnection): Promise<Entry> {
    const provider = this.providers.require(connection.spec.kind);
    const spec = connection.spec;

    const host = typeof spec.options['host'] === 'string' ? spec.options['host'] : '127.0.0.1';
    const port = typeof spec.options['port'] === 'number' ? spec.options['port'] : 0;

    let tunnel: OpenTunnel | undefined;
    let endpoint: Endpoint = { host, port };

    // Only a provider that declared a host and a port can be reached through a
    // forwarded socket. An object store addresses itself by endpoint URL and
    // signs requests for that name, so tunnelling it would have produced a
    // forward to `127.0.0.1:0` and a baffling connection error. Asked by what
    // the provider declares, not by which provider it is.
    const tunnelable = provider.fields.some(f => f.name === 'host')
      && provider.fields.some(f => f.name === 'port');

    if (spec.tunnel && !tunnelable) {
      this.logger.warn('ignoring tunnel: this provider is not addressed by host and port', {
        connection: spec.name,
        kind: spec.kind,
      });
    }

    if (spec.tunnel && tunnelable) {
      tunnel = await this.tunnels.acquire(spec.tunnel, host, port);
      // The address moved to localhost but the certificate still names the real
      // host, so TLS has to keep verifying that name. Losing this is the classic
      // way a tunnelled TLS connection ends up either broken or unverified.
      endpoint = { host: '127.0.0.1', port: tunnel.port, tlsServerName: host };
    }

    try {
      const session = await this.openOnce(provider, spec, endpoint, connection);
      const entry: Entry = { session, provider, ...(tunnel ? { tunnel } : {}) };
      this.open.set(key, entry);
      this.logger.info('session opened', { connection: spec.name, kind: spec.kind, tunnelled: !!tunnel });
      return entry;
    } catch (e) {
      tunnel?.close();
      throw DbRexError.wrap('network', e, { connection: spec.name });
    }
  }

  /**
   * Open, and if a stored credential is rejected, discard it and ask once more.
   *
   * Without this a single mistyped password is permanent: it sits in the vault,
   * every later attempt reuses it, and the only way out is knowing that a
   * "Set Password" command exists. One retry turns that dead end into the
   * prompt the user expected in the first place.
   *
   * Exactly one retry, and only when a stored value was actually used — a
   * connection whose secret comes from a command or the environment has an
   * owner elsewhere, and re-prompting for it would be wrong.
   */
  private async openOnce(
    provider: Provider,
    spec: RegisteredConnection['spec'],
    endpoint: Endpoint,
    connection: RegisteredConnection,
  ): Promise<Session> {
    const source = spec.secret?.from ?? 'prompt';
    // A connection whose secret comes from a command or the environment has an
    // owner elsewhere; re-prompting for it would be asking the wrong party.
    const replaceable = source === 'prompt' || source === 'vault';
    let reason: string | undefined;

    for (let attempt = 1; ; attempt++) {
      try {
        return await provider.open(spec, endpoint, this.io(connection, reason));
      } catch (e) {
        const last = attempt >= MAX_CREDENTIAL_ATTEMPTS;
        // `auth_interaction_required` means the human declined or none is
        // attached. Asking again would either be shouting into an empty room or
        // refusing to take no for an answer.
        if (!DbRexError.is(e) || e.code !== 'auth' || !replaceable || last) throw e;

        await this.secrets.forget(connection, { kind: 'password' });
        reason = e.message;
        this.logger.info('credential rejected, asking again', {
          connection: spec.name,
          attempt,
          error: e.message,
        });
      }
    }
  }

  /** The world as a provider sees it: secrets, one human, and a log. */
  private io(connection: RegisteredConnection, reason?: string): ProviderIo {
    return {
      secret: (purpose: SecretPurpose) => this.secrets.require(connection, purpose, reason),
      storedSecret: (purpose: SecretPurpose) => this.secrets.lookup(connection, purpose),
      rememberSecret: (purpose: SecretPurpose, value: string) =>
        this.secrets.remember(connection, purpose, value),
      interactive: request =>
        this.broker.askBrowser(connection.spec.name, request.url, request.reason),
      log: (level, message, fields) =>
        this.logger.write(level, message, { connection: connection.spec.name, ...fields }),
    };
  }
}
