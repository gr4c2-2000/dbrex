/**
 * The daemon's socket server.
 *
 * Transport is a Unix domain socket, created inside a 0700 directory at mode
 * 0600. That is the whole access-control story, and it is a deliberate
 * replacement for the old router's localhost TCP port plus a shared bearer
 * token in a file: any local process that could read that token could register
 * a workspace and have the router proxy requests to an arbitrary local port.
 * With a socket, the operating system enforces who may connect, and there is no
 * token to leak, rotate or forget.
 *
 * Framing is newline-delimited JSON. One connection multiplexes many requests;
 * responses echo the request id and events arrive unsolicited.
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import {
  DbRexError,
  PROTOCOL_VERSION,
  applyRowLimit,
  isAbortError,
  isInteractionReply,
  type ClientMessage,
  type ConnectionInfo,
  type DaemonMessage,
  type Provider,
  type ProviderInfo,
  type Request,
  type SettingsPatch,
  type ResponseValues,
  type ResultSummary as WireResultSummary,
} from '@dbrex/core';
import type { Broker, ClientHandle } from './broker';
import type { ConnectionRegistry, RegisteredConnection } from './connections';
import type { Logger } from './log';
import type { ProviderRegistry } from './providers/registry';
import type { SecretResolver } from './secrets';
import type { SessionPool } from './sessions';
import type { ResultStore, ResultSummary } from './store/results';
import type { Vault } from './vault';

export interface ServerDeps {
  readonly socketPath: string;
  readonly version: string;
  readonly logger: Logger;
  readonly providers: ProviderRegistry;
  readonly connections: ConnectionRegistry;
  readonly sessions: SessionPool;
  readonly secrets: SecretResolver;
  readonly store: ResultStore;
  readonly broker: Broker;
  readonly vault: Vault;
  /** Called whenever the last client goes away, so the daemon can decide to exit. */
  readonly onIdle?: () => void;
  /** Called when a client speaks for a workspace, so its config file can be watched. */
  readonly onWorkspace?: (workspace: string) => void;
  /** Persist and apply a settings change. */
  readonly onSettings?: (patch: SettingsPatch) => Promise<void>;
  /** Whether an agent's finished query should be put on screen unasked. */
  readonly showAgentResults?: () => boolean;
}

interface Client extends ClientHandle {
  socket: net.Socket;
  greeted: boolean;
  /** In-flight cancellable work, keyed by the request id that started it. */
  running: Map<number, AbortController>;
}

export class Server {
  private readonly server: net.Server;
  private readonly clients = new Map<number, Client>();
  private nextClientId = 1;

  constructor(private readonly deps: ServerDeps) {
    this.server = net.createServer(socket => this.accept(socket));
    this.deps.store.onChange((change, resultId, summary) => {
      this.broadcast({ event: 'resultsChanged', change, resultId, ...(summary ? { summary } : {}) });
    });
  }

  async listen(): Promise<void> {
    const dir = path.dirname(this.deps.socketPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // A socket left behind by a killed daemon would make bind fail; a socket a
    // *live* daemon owns must not be removed, so probe before clearing it.
    if (fs.existsSync(this.deps.socketPath)) {
      if (await isAlive(this.deps.socketPath)) {
        throw new DbRexError('config', `another daemon is already listening on ${this.deps.socketPath}`);
      }
      fs.unlinkSync(this.deps.socketPath);
    }

    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.deps.socketPath, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
    fs.chmodSync(this.deps.socketPath, 0o600);
    this.deps.logger.info('listening', { socket: this.deps.socketPath, version: this.deps.version });
  }

  async close(): Promise<void> {
    for (const client of this.clients.values()) client.socket.destroy();
    this.clients.clear();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
    try {
      fs.unlinkSync(this.deps.socketPath);
    } catch {
      /* already gone */
    }
  }

  clientCount(): number {
    return this.clients.size;
  }

  /**
   * Re-read the connection files and tell every client.
   *
   * Each client is told its own view, because two windows speaking for
   * different workspaces do not see the same list.
   */
  async reload(): Promise<void> {
    this.deps.connections.reloadAll();
    await this.deps.sessions.invalidateAll();
    for (const problem of this.deps.connections.loadProblems()) {
      this.deps.logger.warn('connection config problem', { problem });
    }
    for (const client of this.clients.values()) {
      if (!client.greeted) continue;
      client.send({ event: 'connectionsChanged', connections: this.connectionInfo(client) });
    }
  }

  private accept(socket: net.Socket): void {
    const id = this.nextClientId++;
    const client: Client = {
      id,
      role: 'headless',
      label: 'unidentified',
      socket,
      greeted: false,
      running: new Map(),
      send: (message: DaemonMessage) => {
        if (!socket.destroyed) socket.write(JSON.stringify(message) + '\n');
      },
    };
    this.clients.set(id, client);

    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim().length > 0) void this.handleLine(client, line);
        newline = buffer.indexOf('\n');
      }
    });

    const drop = (): void => {
      if (!this.clients.delete(id)) return;
      for (const controller of client.running.values()) controller.abort();
      this.deps.broker.detach(id);
      this.deps.logger.debug('client gone', { client: client.label });
      if (this.clients.size === 0) this.deps.onIdle?.();
    };
    socket.on('close', drop);
    socket.on('error', drop);
  }

  private async handleLine(client: Client, line: string): Promise<void> {
    let message: ClientMessage;
    try {
      message = JSON.parse(line) as ClientMessage;
    } catch {
      client.send({ id: 0, ok: false, error: { code: 'internal', message: 'malformed JSON' } });
      return;
    }

    if (isInteractionReply(message)) {
      this.deps.broker.reply(client.id, message.interactionId, message.value, message.declined);
      return;
    }

    const request = message;
    try {
      const value = await this.dispatch(client, request);
      client.send({ id: request.id, ok: true, value });
    } catch (e) {
      const error = DbRexError.wrap('internal', e);
      this.deps.logger.warn('request failed', {
        op: request.op,
        client: client.label,
        code: error.code,
        error: error.message,
      });
      client.send({ id: request.id, ok: false, error: error.toWire() });
    }
  }

  private async dispatch(client: Client, request: Request): Promise<ResponseValues[Request['op']]> {
    if (!client.greeted && request.op !== 'hello') {
      throw new DbRexError('forbidden', 'say hello before anything else');
    }

    switch (request.op) {
      case 'hello': {
        if (Math.trunc(request.protocol) !== PROTOCOL_VERSION) {
          throw new DbRexError('config',
            `protocol mismatch: client speaks ${request.protocol}, daemon speaks ${PROTOCOL_VERSION}`,
            { hint: 'update whichever side is older' });
        }
        Object.assign(client, {
          greeted: true,
          role: request.role,
          label: request.client,
          ...(request.workspace === undefined ? {} : { workspace: request.workspace }),
        });
        this.deps.broker.attach(client);
        this.deps.logger.info('client attached', {
          client: request.client, role: request.role, workspace: request.workspace,
        });
        if (request.workspace !== undefined) this.deps.onWorkspace?.(request.workspace);
        return { daemonVersion: this.deps.version, protocol: PROTOCOL_VERSION };
      }

      case 'listConnections':
        return { connections: this.connectionInfo(client) };

      case 'describeProviders':
        return { providers: this.deps.providers.all().map(toProviderInfo) };

      case 'reloadConnections': {
        await this.reload();
        return { connections: this.connectionInfo(client) };
      }

      case 'query':
        return this.runQuery(client, request);

      case 'cancel': {
        client.running.get(request.target)?.abort();
        return {};
      }

      case 'readRows': {
        const rows = await this.deps.store.readRows(request.resultId, request.offset, request.limit);
        const summary = this.deps.store.summary(request.resultId);
        return {
          resultId: request.resultId,
          offset: request.offset,
          rows,
          total: summary?.rowCount ?? rows.length,
        };
      }

      case 'listResults':
        return { results: this.deps.store.list(request.limit).map(toSummary) };

      case 'pinResult': {
        this.deps.store.pin(request.resultId, request.pinned);
        return {};
      }

      case 'deleteResult': {
        this.deps.store.delete(request.resultId);
        return {};
      }

      case 'browse': {
        const connection = this.resolve(client, request.connection);
        const { session, provider } = await this.deps.sessions.acquire(connection);
        if (!provider.capabilities.browse) {
          throw new DbRexError('config', `${provider.displayName} connections cannot be browsed`);
        }
        return { nodes: await session.browse(request.path) };
      }

      case 'validate': {
        const connection = this.resolve(client, request.connection);
        const { session, provider } = await this.deps.sessions.acquire(connection);
        if (!provider.capabilities.validate) return { diagnostics: [] };
        return { diagnostics: await session.validate(request.sql) };
      }

      case 'setSecret': {
        this.requireSecretRole(client, 'store a secret');
        const connection = this.resolve(client, request.connection);
        await this.deps.secrets.remember(connection, { kind: 'password' }, request.value);
        // The live session still holds the old credential.
        await this.deps.sessions.invalidate(connection);
        return {};
      }

      case 'vaultStatus':
        return { exists: this.deps.vault.exists, unlocked: this.deps.vault.unlocked };

      case 'unlock': {
        this.requireSecretRole(client, 'unlock the vault');
        this.deps.vault.unlock(request.passphrase);
        this.deps.logger.info('vault unlocked', { client: client.label });
        return {};
      }

      case 'showResult': {
        const summary = this.deps.store.summary(request.resultId);
        if (!summary) {
          throw new DbRexError('not_found', `result ${request.resultId} is no longer stored`);
        }
        return { shown: this.display(request.resultId) };
      }

      case 'updateSettings': {
        this.requireSecretRole(client, 'change daemon settings');
        await this.deps.onSettings?.(request.settings);
        return {};
      }
    }
  }

  private async runQuery(client: Client, request: Extract<Request, { op: 'query' }>): Promise<ResponseValues['query']> {
    const connection = this.resolve(client, request.connection);
    const { session, provider } = await this.deps.sessions.acquire(connection);

    // Putting the limit in the SQL is the only way to make the *engine* stop;
    // a streaming provider that stops reading leaves the server working. So the
    // limit goes into the statement whenever the dialect can express one, and
    // is passed to the provider as well for the statements `applyRowLimit`
    // refuses to touch.
    const sql = request.rowLimit === undefined
      ? request.sql
      : applyRowLimit(request.sql, request.rowLimit, provider.capabilities.limit);

    const controller = new AbortController();
    client.running.set(request.id, controller);

    const writer = this.deps.store.begin(connection.spec.name, request.sql);
    let columns: ResponseValues['query']['columns'] = [];
    let reported = 0;

    try {
      const stream = session.query(sql, {
        ...(request.rowLimit === undefined ? {} : { rowLimit: request.rowLimit }),
        ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
        ...(request.settings === undefined ? {} : { settings: request.settings }),
        signal: controller.signal,
      });

      let step = await stream.next();
      while (!step.done) {
        const chunk = step.value;
        if (chunk.columns) columns = chunk.columns;
        await writer.append(chunk.rows);
        if (writer.rowCount - reported >= 1000) {
          reported = writer.rowCount;
          client.send({ event: 'queryProgress', target: request.id, rows: reported });
        }
        step = await stream.next();
      }

      const summary = await writer.finish(columns, step.value);
      // An agent working on your database while you watch is the point of this
      // design; a result you never see is a result you cannot check. The old
      // tool pushed these into the panel by default too — the difference is
      // that this carries a result id and nothing executable.
      if (client.role === 'agent' && this.deps.showAgentResults?.() !== false) {
        this.display(summary.resultId);
      }
      return {
        resultId: summary.resultId,
        columns,
        stats: step.value,
        rowCount: summary.rowCount,
      };
    } catch (e) {
      await writer.abort();
      // A provider may report an abort as a driver error, an AbortError, or a
      // plain "query cancelled". The signal is the authority on what happened,
      // so the client never has to guess why its own cancel came back as an
      // internal error.
      const error = controller.signal.aborted || isAbortError(e)
        ? new DbRexError('cancelled', 'query cancelled', { connection: connection.spec.name })
        : DbRexError.wrap('internal', e, { connection: connection.spec.name });
      // A cancelled or broken query can leave the underlying connection in a
      // state the driver will not recover from — mysql2's cancellation destroys
      // the socket outright. Drop the session so the next caller reconnects.
      if (error.code === 'cancelled' || error.code === 'timeout' || error.code === 'network') {
        await this.deps.sessions.invalidate(connection);
      }
      throw error;
    } finally {
      client.running.delete(request.id);
    }
  }

  /**
   * Put a stored result in front of whoever has a screen.
   *
   * Only `ui` and `tty` clients: sending this to another agent would be noise,
   * and to a script, meaningless.
   */
  private display(resultId: string): number {
    const summary = this.deps.store.summary(resultId);
    if (!summary) return 0;
    let shown = 0;
    for (const target of this.clients.values()) {
      if (!target.greeted || (target.role !== 'ui' && target.role !== 'tty')) continue;
      target.send({ event: 'showResult', resultId, summary: toSummary(summary) });
      shown++;
    }
    return shown;
  }

  private resolve(client: Client, name: string): RegisteredConnection {
    return this.deps.connections.find(name, client.workspace);
  }

  private requireSecretRole(client: Client, action: string): void {
    if (client.role === 'ui' || client.role === 'tty') return;
    throw new DbRexError('forbidden', `a ${client.role} client may not ${action}`, {
      hint: 'secrets are only accepted from a VSCode window or a terminal, never over MCP',
    });
  }

  private connectionInfo(client: Client): ConnectionInfo[] {
    return this.deps.connections.visible(client.workspace).map(connection => {
      const provider = this.deps.sessions.providerFor(connection);
      const source = connection.spec.secret?.from ?? 'prompt';
      return {
        name: connection.spec.name,
        kind: connection.spec.kind,
        ...(connection.spec.reference === undefined ? {} : { reference: connection.spec.reference }),
        origin: connection.origin,
        secretSource: source,
        // "Ready" means no human is needed to make the next query work.
        ready: source !== 'prompt' || this.deps.vault.unlocked,
        capabilities: provider.capabilities,
      };
    });
  }

  private broadcast(message: DaemonMessage): void {
    for (const client of this.clients.values()) {
      if (client.greeted) client.send(message);
    }
  }
}

function toProviderInfo(provider: Provider): ProviderInfo {
  return {
    id: provider.id,
    displayName: provider.displayName,
    capabilities: provider.capabilities,
    fields: provider.fields,
  };
}

/** Drop `accessedAt`: it drives eviction and is nobody else's business. */
function toSummary(summary: ResultSummary): WireResultSummary {
  const { accessedAt: _accessedAt, ...wire } = summary;
  return wire;
}

/** True when something is listening on this socket right now. */
function isAlive(socketPath: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect(socketPath);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
  });
}
