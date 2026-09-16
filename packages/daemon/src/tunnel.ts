/**
 * SSH tunnels.
 *
 * Shelling out to the system `ssh` rather than reimplementing it in Node is the
 * old codebase's best decision and it is kept verbatim in spirit: you get
 * `~/.ssh/config`, agent keys, `ProxyJump` and everything else your ssh already
 * knows, for free and without a native dependency.
 *
 * What is new is the in-flight map. The old manager awaited a free port before
 * recording the tunnel, so two connects racing on the same connection — trivial
 * to trigger by expanding the schema tree while a query starts — spawned two
 * `ssh` processes and leaked one.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import { DbRexError, type TunnelSpec } from '@dbrex/core';

export interface OpenTunnel {
  /** Local port forwarded to the remote endpoint. */
  readonly port: number;
  close(): void;
}

/** The ssh argument vector for one forward. Pure, so it can be asserted on. */
export function buildSshArgs(
  tunnel: TunnelSpec,
  localPort: number,
  remoteHost: string,
  remotePort: number,
): string[] {
  const args = [
    '-N',
    // No prompts: a tunnel that needs a password typed would hang the daemon
    // with nobody watching the terminal it was started from.
    '-o', 'BatchMode=yes',
    // Fail loudly instead of sitting there with a dead forward.
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-L', `${localPort}:${remoteHost}:${remotePort}`,
  ];
  if (tunnel.port !== undefined) args.push('-p', String(tunnel.port));
  if (tunnel.identityFile !== undefined) args.push('-i', tunnel.identityFile);
  args.push(tunnel.user !== undefined ? `${tunnel.user}@${tunnel.host}` : tunnel.host);
  return args;
}

interface Entry {
  readonly key: string;
  readonly child: ChildProcess;
  readonly port: number;
  refs: number;
}

export class TunnelManager {
  private open = new Map<string, Entry>();
  private opening = new Map<string, Promise<Entry>>();

  /** Open, or join, a tunnel to `remoteHost:remotePort`. */
  async acquire(tunnel: TunnelSpec, remoteHost: string, remotePort: number): Promise<OpenTunnel> {
    const key = `${tunnel.user ?? ''}@${tunnel.host}:${tunnel.port ?? 22}->${remoteHost}:${remotePort}`;

    const existing = this.open.get(key);
    if (existing) {
      existing.refs++;
      return this.handle(existing);
    }

    let pending = this.opening.get(key);
    if (!pending) {
      pending = this.start(key, tunnel, remoteHost, remotePort);
      this.opening.set(key, pending);
      pending.finally(() => this.opening.delete(key)).catch(() => {});
    }

    const entry = await pending;
    entry.refs++;
    return this.handle(entry);
  }

  closeAll(): void {
    for (const entry of this.open.values()) entry.child.kill();
    this.open.clear();
  }

  private handle(entry: Entry): OpenTunnel {
    let released = false;
    return {
      port: entry.port,
      close: () => {
        if (released) return;
        released = true;
        entry.refs--;
        if (entry.refs <= 0) {
          this.open.delete(entry.key);
          entry.child.kill();
        }
      },
    };
  }

  private async start(
    key: string,
    tunnel: TunnelSpec,
    remoteHost: string,
    remotePort: number,
  ): Promise<Entry> {
    const port = await freePort();
    const args = buildSshArgs(tunnel, port, remoteHost, remotePort);
    const child = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] });

    // ssh writes the reason it failed to stderr and then exits; without this the
    // user gets "connection refused" from the driver and no idea why.
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    const exited = new Promise<never>((_, reject) => {
      child.once('exit', code => {
        this.open.delete(key);
        reject(new DbRexError('network', `ssh tunnel to ${tunnel.host} exited (code ${code ?? 'null'})`, {
          hint: stderr.trim().split('\n').slice(-1)[0] ?? 'no output from ssh',
        }));
      });
      child.once('error', e => {
        reject(DbRexError.wrap('network', e, { hint: `could not run ssh: ${tunnel.host}` }));
      });
    });

    await Promise.race([waitForPort(port, 10_000), exited]);
    const entry: Entry = { key, child, port, refs: 0 };
    this.open.set(key, entry);
    return entry;
  }
}

/** Ask the OS for a free port by binding and releasing one. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('could not find a free port'))));
    });
  });
}

/** Poll until the forwarded port accepts a connection. Polling beats sleeping. */
async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>(resolve => {
      const socket = net.connect({ port, host: '127.0.0.1' });
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => { socket.destroy(); resolve(false); });
    });
    if (open) return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new DbRexError('network', `ssh tunnel did not come up within ${timeoutMs}ms`);
}
