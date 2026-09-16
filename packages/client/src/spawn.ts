/**
 * Starting the daemon on demand.
 *
 * Every client does this the same way, so it lives here rather than in each of
 * them: try to connect, and if nothing answers, launch the daemon and wait for
 * the socket. The first client to need it wins the race; the losers connect to
 * the winner's daemon because binding an occupied socket fails loudly.
 *
 * `execPath` defaults to `process.execPath`, which inside the VSCode extension
 * host is the editor binary running as Node — it already carries
 * `ELECTRON_RUN_AS_NODE` in its environment, so passing that environment along
 * is what makes the spawn work without a system Node installed. That trick is
 * inherited from the old router, and it is the reason installing the extension
 * still installs everything.
 */

import { spawn } from 'node:child_process';
import * as net from 'node:net';
import { DbRexError } from '@dbrex/core';

export interface SpawnOptions {
  readonly socketPath: string;
  /** Path to the built daemon entry point. */
  readonly daemonPath: string;
  readonly execPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

/** True when a daemon is listening on this socket right now. */
export function isListening(socketPath: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect(socketPath);
    const finish = (answer: boolean): void => {
      socket.destroy();
      resolve(answer);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/** Ensure a daemon is listening, starting one if necessary. */
export async function ensureDaemon(options: SpawnOptions): Promise<void> {
  if (await isListening(options.socketPath)) return;

  const child = spawn(options.execPath ?? process.execPath, [options.daemonPath], {
    detached: true,
    stdio: 'ignore',
    env: options.env ?? process.env,
  });
  child.unref();

  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 100));
    if (await isListening(options.socketPath)) return;
  }

  throw new DbRexError('network', 'the daemon did not start', {
    hint: `tried: ${options.execPath ?? process.execPath} ${options.daemonPath}`,
  });
}
