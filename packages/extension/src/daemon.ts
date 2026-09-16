/**
 * The extension's link to the daemon.
 *
 * This is the whole of the extension's relationship with a database: it holds a
 * socket and answers questions a human has to answer. No drivers, no
 * credentials, no connection pool, no result cache — all of that lives in the
 * daemon, which is why closing this window does not stop an agent from working.
 *
 * The extension also seeds the daemon and the CLI into the config directory on
 * activation, so an agent can start them on a machine where VSCode has since
 * been closed, or was never opened at that moment. Installing the extension
 * installs the whole system; that property is worth the twenty lines it costs.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { DbRexClient, ensureDaemon } from '@dbrex/client';
import {
  DbRexError,
  configDirFor,
  messageOf,
  resolveSocketPath,
  shimSource,
  type ConnectionInfo,
  type ResultSummary,
  type SocketEnvironment,
} from '@dbrex/core';

export interface DaemonEvents {
  onConnectionsChanged(connections: readonly ConnectionInfo[]): void;
  onResultsChanged(change: 'saved' | 'pinned' | 'deleted', resultId: string, summary?: ResultSummary): void;
  onShowResult(summary: ResultSummary): void;
}

export function socketEnvironment(): SocketEnvironment {
  return {
    dbrexSocket: process.env['DBREX_SOCKET'],
    dbrexHome: process.env['DBREX_HOME'],
    home: os.homedir(),
    tmpDir: os.tmpdir(),
    uid: typeof process.getuid === 'function' ? process.getuid() : 0,
  };
}

export class Daemon {
  private client: DbRexClient | undefined;
  private connecting: Promise<DbRexClient> | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.LogOutputChannel,
    private readonly events: DaemonEvents,
  ) {}

  /**
   * The connected client, connecting or reconnecting as needed.
   *
   * Reconnection is not a special mode: the daemon can restart under us (an
   * idle exit, an upgrade) and every call simply reopens the socket. There is
   * no "disconnected" state for the rest of the extension to handle.
   */
  async connected(): Promise<DbRexClient> {
    if (this.client) return this.client;
    this.connecting ??= this.open().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  dispose(): void {
    this.client?.close();
    this.client = undefined;
  }

  private async open(): Promise<DbRexClient> {
    const location = resolveSocketPath(socketEnvironment());
    const daemonPath = this.seed();

    await ensureDaemon({ socketPath: location.socketPath, daemonPath });
    this.output.info(`connected to daemon on ${location.socketPath}`);

    const client = await DbRexClient.connect(
      {
        socketPath: location.socketPath,
        role: 'ui',
        client: `vscode/${vscode.version}`,
        ...(workspacePath() === undefined ? {} : { workspace: workspacePath()! }),
      },
      {
        onInteraction: request => this.ask(request),
        onConnectionsChanged: connections => this.events.onConnectionsChanged(connections),
        onResultsChanged: (change, resultId, summary) =>
          this.events.onResultsChanged(change, resultId, summary),
        onShowResult: (_resultId, summary) => this.events.onShowResult(summary),
        onClose: error => {
          this.client = undefined;
          if (error) this.output.warn(`daemon connection lost: ${error.message}`);
        },
      },
    );

    this.client = client;
    return client;
  }

  /** Answer the daemon's questions. This is the extension's real job. */
  private async ask(
    request: { connection: string; detail: { kind: string; prompt?: string; url?: string; reason?: string } },
  ): Promise<string | true | undefined> {
    switch (request.detail.kind) {
      case 'secret': {
        const value = await vscode.window.showInputBox({
          prompt: request.detail.prompt ?? `Secret for "${request.connection}"`,
          password: true,
          ignoreFocusOut: true,
        });
        // Cancelling declines, so the daemon can ask another window instead of
        // treating an empty box as "this connection has no password".
        return value === undefined ? undefined : value;
      }
      case 'unlock': {
        const value = await vscode.window.showInputBox({
          prompt: request.detail.prompt ?? 'Passphrase for the DbRex secret vault',
          password: true,
          ignoreFocusOut: true,
        });
        return value === undefined ? undefined : value;
      }
      case 'browser': {
        const open = 'Open in browser';
        const choice = await vscode.window.showInformationMessage(
          `DbRex: ${request.detail.reason ?? 'a login is required'}`,
          open,
        );
        if (choice !== open) return undefined;
        await vscode.env.openExternal(vscode.Uri.parse(request.detail.url ?? ''));
        return true;
      }
      default:
        return undefined;
    }
  }

  /**
   * Copy the daemon and the CLI into the config directory.
   *
   * They ship inside the extension, but an extension directory is versioned and
   * disappears on uninstall or upgrade while an agent's MCP configuration keeps
   * pointing at it. A stable path under the config directory survives both.
   */
  private seed(): string {
    const dir = path.join(configDirFor(socketEnvironment()), 'bin');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    let daemonTarget = path.join(this.context.extensionPath, 'dist', 'dbrexd.js');
    for (const name of ['dbrexd.js', 'dbrex.js']) {
      const source = path.join(this.context.extensionPath, 'dist', name);
      const target = path.join(dir, name);
      try {
        if (!fs.existsSync(source)) continue;
        if (!fs.existsSync(target) || fs.statSync(source).mtimeMs > fs.statSync(target).mtimeMs) {
          fs.copyFileSync(source, target);
        }
        if (name === 'dbrexd.js') daemonTarget = target;
        if (name === 'dbrex.js') this.seedShim(dir, target);
      } catch (e) {
        // A read-only or unwritable home is survivable: we fall back to running
        // the copy inside the extension directory.
        this.output.warn(`could not seed ${name}: ${messageOf(e)}`);
      }
    }
    return daemonTarget;
  }

  /**
   * Write the `dbrex` command next to the CLI it runs.
   *
   * Seeding a `.js` file is not the same as having a command: it needs an
   * interpreter chosen for it, and `node` on a machine with nvm is as likely to
   * be version 11 as anything current. The shim picks one and is rewritten on
   * every activation, so it follows the extension.
   */
  private seedShim(dir: string, cliPath: string): void {
    const shim = path.join(dir, 'dbrex');
    try {
      fs.writeFileSync(shim, shimSource(cliPath), { mode: 0o755 });
    } catch (e) {
      this.output.warn(`could not write the dbrex command: ${messageOf(e)}`);
    }
  }
}

export function workspacePath(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Show a failure the way its code deserves, with the hint the daemon supplied. */
export function report(e: unknown, output: vscode.LogOutputChannel): void {
  if (DbRexError.is(e)) {
    output.error(`${e.code}: ${e.message}`);
    const detail = e.details.hint ? `${e.message} — ${e.details.hint}` : e.message;
    if (e.code === 'cancelled') return;
    void vscode.window.showErrorMessage(`DbRex: ${detail}`);
    return;
  }
  output.error(messageOf(e));
  void vscode.window.showErrorMessage(`DbRex: ${messageOf(e)}`);
}
