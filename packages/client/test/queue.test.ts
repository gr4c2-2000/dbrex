import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DaemonMessage } from '@dbrex/core';
import { DbRexClient } from '../src/index';

/**
 * A stand-in daemon: it completes the handshake and then sends whatever the
 * test tells it to, so the client's interaction handling can be exercised
 * without the real thing.
 */
async function fakeDaemon(): Promise<{
  socketPath: string;
  send: (message: DaemonMessage) => void;
  received: unknown[];
  /** Drop the attached client without shutting down, as a restart would. */
  drop: () => void;
  close: () => void;
}> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbrex-queue-'));
  const socketPath = path.join(dir, 's.sock');
  const received: unknown[] = [];
  let live: net.Socket | undefined;

  const server = net.createServer(socket => {
    live = socket;
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      let at = buffer.indexOf('\n');
      while (at >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        const message = JSON.parse(line) as { id?: number; op?: string };
        received.push(message);
        if (message.op === 'hello') {
          socket.write(JSON.stringify({ id: message.id, ok: true, value: {} }) + '\n');
        }
        at = buffer.indexOf('\n');
      }
    });
  });

  await new Promise<void>(resolve => server.listen(socketPath, resolve));

  return {
    socketPath,
    send: message => live?.write(JSON.stringify(message) + '\n'),
    received,
    drop: () => live?.destroy(),
    close: () => {
      live?.destroy();
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Comfortably longer than the queued handlers take, so timing is not the test. */
const settle = (): Promise<void> => new Promise(r => setTimeout(r, 200));

describe('interaction queue', () => {
  it('answers one prompt at a time', async () => {
    const daemon = await fakeDaemon();
    let showing = 0;
    let overlapped = false;

    const client = await DbRexClient.connect(
      { socketPath: daemon.socketPath, role: 'ui', client: 'test' },
      {
        onInteraction: async () => {
          showing++;
          // An editor shows one input box; a second dismisses the first.
          if (showing > 1) overlapped = true;
          await new Promise(r => setTimeout(r, 15));
          showing--;
          return 'answer';
        },
      },
    );

    for (let id = 1; id <= 3; id++) {
      daemon.send({
        event: 'interaction',
        interactionId: id,
        connection: `conn-${id}`,
        detail: { kind: 'secret', prompt: `Password ${id}` },
      });
    }
    await settle();

    expect(overlapped).toBe(false);
    const replies = daemon.received.filter((m): m is { op: string; interactionId: number } =>
      (m as { op?: string }).op === 'interactionReply');
    expect(replies.map(r => r.interactionId)).toEqual([1, 2, 3]);

    client.close();
    daemon.close();
  });

  it('skips a queued prompt the daemon has already settled', async () => {
    const daemon = await fakeDaemon();
    const asked: number[] = [];

    const client = await DbRexClient.connect(
      { socketPath: daemon.socketPath, role: 'ui', client: 'test' },
      {
        onInteraction: async ({ interactionId }) => {
          asked.push(interactionId);
          await new Promise(r => setTimeout(r, 25));
          return 'answer';
        },
      },
    );

    daemon.send({
      event: 'interaction', interactionId: 1, connection: 'a',
      detail: { kind: 'secret', prompt: 'first' },
    });
    daemon.send({
      event: 'interaction', interactionId: 2, connection: 'b',
      detail: { kind: 'secret', prompt: 'second' },
    });
    // While the first box is open, the daemon gets its answer elsewhere.
    daemon.send({ event: 'interactionClosed', interactionId: 2 });
    await settle();

    expect(asked).toEqual([1]);

    client.close();
    daemon.close();
  });
});

describe('losing the daemon', () => {
  it('reconnects on the next request instead of staying dead', async () => {
    const daemon = await fakeDaemon();
    let ensured = 0;

    const client = await DbRexClient.connect({
      socketPath: daemon.socketPath,
      role: 'agent',
      client: 'test',
      ensure: async () => { ensured++; },
    });
    expect(client.connected).toBe(true);

    // The daemon exits when idle and is replaced on every upgrade. An MCP
    // bridge outlives many daemons; treating the first disconnection as
    // terminal ended the agent's database access until the agent restarted.
    daemon.drop();
    await settle();
    expect(client.connected).toBe(false);

    void client.call({ op: 'listConnections' }).catch(() => { /* the fake answers only hello */ });
    await settle();

    expect(client.connected).toBe(true);
    // Asked again: the replacement daemon may still need starting.
    expect(ensured).toBe(2);
    const hellos = daemon.received.filter(m => (m as { op?: string }).op === 'hello');
    expect(hellos).toHaveLength(2);

    client.close();
    daemon.close();
  });

  it('stays closed once the caller closes it', async () => {
    const daemon = await fakeDaemon();
    const client = await DbRexClient.connect({
      socketPath: daemon.socketPath, role: 'tty', client: 'test',
    });

    client.close();
    await expect(client.call({ op: 'listConnections' }))
      .rejects.toMatchObject({ message: expect.stringContaining('closed') });

    daemon.close();
  });
});
