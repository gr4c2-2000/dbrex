/**
 * Client side of the daemon protocol.
 *
 * Shared by the VSCode extension, the CLI and the MCP bridge so there is one
 * implementation of framing, request correlation and interaction handling. A
 * client that answers prompts (VSCode, a terminal) sets an `onInteraction`
 * handler; one that cannot simply leaves it unset and the daemon asks somebody
 * else.
 */

import * as net from 'node:net';
import {
  DbRexError,
  PROTOCOL_VERSION,
  isEvent,
  type ClientRole,
  type ConnectionInfo,
  type DaemonMessage,
  type Event,
  type InteractionDetail,
  type RequestBody,
  type RequestOp,
  type ResponseValues,
  type ResultSummary,
} from '@dbrex/core';

export interface ConnectOptions {
  readonly socketPath: string;
  /**
   * Run before every connection attempt, including reconnections.
   *
   * The bridge uses it to start the daemon. A long-lived client outlives any
   * one daemon — an idle exit, an upgrade, a deploy — so "is it running?" has
   * to be asked again each time, not only at startup.
   */
  readonly ensure?: () => Promise<void>;
  readonly role: ClientRole;
  /** Shown in daemon logs, so make it identifiable: "vscode", "dbrex-cli". */
  readonly client: string;
  readonly workspace?: string;
}

export interface InteractionContext {
  readonly interactionId: number;
  readonly connection: string;
  readonly detail: InteractionDetail;
}

/**
 * Answer an interaction: a string for a secret or a passphrase, `true` to
 * acknowledge a browser request, or `undefined` to decline so the daemon can
 * ask another client.
 */
export type InteractionHandler = (context: InteractionContext) => Promise<string | true | undefined>;

export interface ClientEvents {
  onInteraction?: InteractionHandler;
  onInteractionClosed?: (interactionId: number) => void;
  onConnectionsChanged?: (connections: readonly ConnectionInfo[]) => void;
  onResultsChanged?: (change: 'saved' | 'pinned' | 'deleted', resultId: string, summary?: ResultSummary) => void;
  onQueryProgress?: (requestId: number, rows: number) => void;
  /** An agent asked for this stored result to be put in front of the user. */
  onShowResult?: (resultId: string, summary: ResultSummary) => void;
  onClose?: (error?: Error) => void;
}

type Pending = {
  resolve: (value: never) => void;
  reject: (error: unknown) => void;
};

export class DbRexClient {
  private socket: net.Socket | undefined;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /**
   * Interactions are answered one at a time.
   *
   * An editor shows one input box; asking for a second one dismisses the first,
   * and a dismissed box reads as "this client declined". Expanding a tree with
   * several connections in it asks for several passwords at once, so without
   * this queue all but one of them were answered "no" by the UI itself.
   */
  private queue: Promise<void> = Promise.resolve();
  /** Interactions the daemon has already settled, so a queued one is skipped. */
  private readonly settled = new Set<number>();
  private closed = false;

  private options: ConnectOptions | undefined;
  private connecting: Promise<void> | undefined;

  private constructor(private readonly events: ClientEvents) {}

  static async connect(options: ConnectOptions, events: ClientEvents = {}): Promise<DbRexClient> {
    const client = new DbRexClient(events);
    client.options = options;
    await client.open(options);
    return client;
  }

  /** True while a socket is attached. */
  get connected(): boolean {
    return this.socket !== undefined && !this.closed;
  }

  /**
   * Reopen the socket if it has gone away.
   *
   * Losing the daemon is ordinary: it exits when idle and it is replaced on
   * every upgrade. A client that treats the first disconnection as terminal
   * turns a three-second gap into a dead session that only a restart fixes —
   * which, for an MCP bridge, means restarting the agent.
   */
  private async reopen(): Promise<void> {
    const options = this.options;
    if (options === undefined) {
      throw new DbRexError('internal', 'this client was never connected');
    }
    this.connecting ??= this.open(options).finally(() => { this.connecting = undefined; });
    await this.connecting;
  }

  /** The request id of the most recent call, for cancelling a running query. */
  lastRequestId(): number {
    return this.nextId - 1;
  }

  async call<O extends RequestOp>(body: Extract<RequestBody, { op: O }>): Promise<ResponseValues[O]> {
    return this.send(body);
  }

  /**
   * Run a query and report its request id before it finishes, so the caller can
   * cancel it. The daemon keys cancellation on the id the query was sent with.
   */
  query(
    body: Extract<RequestBody, { op: 'query' }>,
    onId?: (requestId: number) => void,
  ): Promise<ResponseValues['query']> {
    return this.send(body, onId);
  }

  cancel(requestId: number): Promise<ResponseValues['cancel']> {
    return this.call({ op: 'cancel', target: requestId });
  }

  close(): void {
    this.closed = true;
    this.socket?.end();
  }

  private async open(options: ConnectOptions): Promise<void> {
    await options.ensure?.();

    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect(options.socketPath);
      s.once('connect', () => resolve(s));
      s.once('error', e => reject(DbRexError.wrap('network', e, {
        hint: `no daemon is listening on ${options.socketPath}`,
      })));
    });

    socket.setEncoding('utf8');
    socket.on('data', (chunk: string | Buffer) => this.consume(chunk.toString()));
    socket.on('close', () => this.fail(new DbRexError('network', 'the daemon closed the connection')));
    socket.on('error', e => this.fail(DbRexError.wrap('network', e)));
    this.socket = socket;
    this.buffer = '';
    this.settled.clear();

    await this.send({
      op: 'hello',
      protocol: PROTOCOL_VERSION,
      role: options.role,
      client: options.client,
      ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    });
  }

  private async send<O extends RequestOp>(
    body: Extract<RequestBody, { op: O }>,
    onId?: (requestId: number) => void,
  ): Promise<ResponseValues[O]> {
    if (this.closed) {
      return Promise.reject(new DbRexError('network', 'this client has been closed'));
    }
    // `hello` is the handshake itself; reconnecting from inside it would loop.
    if (this.socket === undefined && body.op !== 'hello') await this.reopen();

    const socket = this.socket;
    if (!socket) {
      return Promise.reject(new DbRexError('network', 'not connected to the daemon'));
    }
    const id = this.nextId++;
    onId?.(id);
    return new Promise<ResponseValues[O]>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: never) => void, reject });
      socket.write(JSON.stringify({ id, ...body }) + '\n');
    });
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim().length > 0) this.handle(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  private handle(line: string): void {
    let message: DaemonMessage;
    try {
      message = JSON.parse(line) as DaemonMessage;
    } catch {
      return;
    }

    if (isEvent(message)) {
      this.dispatchEvent(message);
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.ok) pending.resolve(message.value as never);
    else pending.reject(DbRexError.fromWire(message.error));
  }

  private dispatchEvent(event: Event): void {
    switch (event.event) {
      case 'interaction':
        this.queue = this.queue.then(() => this.answer(event));
        return;
      case 'interactionClosed':
        this.settled.add(event.interactionId);
        this.events.onInteractionClosed?.(event.interactionId);
        return;
      case 'connectionsChanged':
        this.events.onConnectionsChanged?.(event.connections);
        return;
      case 'resultsChanged':
        this.events.onResultsChanged?.(event.change, event.resultId, event.summary);
        return;
      case 'queryProgress':
        this.events.onQueryProgress?.(event.target, event.rows);
        return;
      case 'showResult':
        this.events.onShowResult?.(event.resultId, event.summary);
        return;
    }
  }

  private async answer(event: Extract<Event, { event: 'interaction' }>): Promise<void> {
    // Someone else answered, or it timed out, while this one waited its turn.
    if (this.settled.delete(event.interactionId)) return;

    const handler = this.events.onInteraction;
    // Declining is not a failure: it tells the daemon to ask somebody else
    // straight away instead of waiting out the interaction timeout.
    if (!handler) {
      this.reply(event.interactionId, undefined, true);
      return;
    }
    try {
      const answer = await handler({
        interactionId: event.interactionId,
        connection: event.connection,
        detail: event.detail,
      });
      if (answer === undefined) this.reply(event.interactionId, undefined, true);
      else this.reply(event.interactionId, answer === true ? 'ok' : answer, false);
    } catch {
      this.reply(event.interactionId, undefined, true);
    }
  }

  private reply(interactionId: number, value: string | undefined, declined: boolean): void {
    this.socket?.write(JSON.stringify({
      op: 'interactionReply',
      interactionId,
      ...(value === undefined ? {} : { value }),
      ...(declined ? { declined: true } : {}),
    }) + '\n');
  }

  /**
   * The socket went away.
   *
   * In-flight requests cannot be replayed — the daemon may well have run them —
   * so they fail. The client itself stays usable: the next request reconnects.
   * Only `close()` makes that final.
   */
  private fail(error: Error): void {
    const wasConnected = this.socket !== undefined;
    this.socket = undefined;
    this.buffer = '';
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (wasConnected && !this.closed) this.events.onClose?.(error);
  }
}

export { ensureDaemon, isListening, type SpawnOptions } from './spawn';
