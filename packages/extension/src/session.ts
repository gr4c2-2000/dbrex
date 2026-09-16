/**
 * Which connection the editor is pointed at.
 *
 * The daemon is the source of truth for what connections exist; this only
 * remembers which one this window is using and shows it in the status bar.
 */

import * as vscode from 'vscode';
import type { ConnectionInfo } from '@dbrex/core';

const STATE_KEY = 'dbrex.activeConnection';

export class Session {
  private connections: readonly ConnectionInfo[] = [];
  private active: string | undefined;
  private readonly status: vscode.StatusBarItem;
  private readonly changed = new vscode.EventEmitter<string | undefined>();

  readonly onDidChangeActive = this.changed.event;

  constructor(private readonly memento: vscode.Memento) {
    this.active = memento.get<string>(STATE_KEY);
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.status.command = 'dbrex.pickConnection';
    this.render();
  }

  get activeName(): string | undefined {
    return this.active;
  }

  get all(): readonly ConnectionInfo[] {
    return this.connections;
  }

  info(name: string): ConnectionInfo | undefined {
    return this.connections.find(c => c.name === name);
  }

  update(connections: readonly ConnectionInfo[]): void {
    this.connections = connections;
    // A remembered connection that no longer exists must not linger in the
    // status bar pretending to work.
    if (this.active !== undefined && !connections.some(c => c.name === this.active)) {
      this.setActive(connections[0]?.name);
      return;
    }
    if (this.active === undefined && connections.length === 1) {
      this.setActive(connections[0]?.name);
      return;
    }
    this.render();
  }

  setActive(name: string | undefined): void {
    this.active = name;
    void this.memento.update(STATE_KEY, name);
    this.render();
    this.changed.fire(name);
  }

  /**
   * Ask which connection, without making it the active one.
   *
   * Separate from `pick` because choosing a connection to act *on* — storing a
   * password, editing a setting — should not silently change which connection
   * the editor runs against.
   */
  async choose(placeHolder: string): Promise<string | undefined> {
    const picked = await this.quickPick(placeHolder);
    return picked;
  }

  /** Ask the user to choose, showing what each connection is for. */
  async pick(): Promise<string | undefined> {
    if (this.connections.length === 0) {
      const add = 'Add connection';
      const choice = await vscode.window.showInformationMessage('DbRex: no connections configured.', add);
      if (choice === add) await vscode.commands.executeCommand('dbrex.addConnection');
      return undefined;
    }

    const picked = await this.quickPick('Connection to use in this window');
    if (picked !== undefined) this.setActive(picked);
    return picked;
  }

  private async quickPick(placeHolder: string): Promise<string | undefined> {
    const picked = await vscode.window.showQuickPick(
      this.connections.map(c => {
        const detail = c.reference ?? (c.ready ? '' : 'needs a password before it can run');
        return {
          label: c.name,
          description: `${c.kind}${c.origin === 'workspace' ? ' · workspace' : ''}`
            + (c.name === this.active ? ' · active' : ''),
          ...(detail.length > 0 ? { detail } : {}),
        };
      }),
      { placeHolder },
    );
    return picked?.label;
  }

  dispose(): void {
    this.status.dispose();
    this.changed.dispose();
  }

  private render(): void {
    if (this.active === undefined) {
      this.status.text = '$(database) DbRex: no connection';
      this.status.tooltip = 'Choose a connection';
    } else {
      const info = this.info(this.active);
      this.status.text = `$(database) ${this.active}`;
      this.status.tooltip = info?.reference ?? `${info?.kind ?? 'unknown'} connection`;
    }
    this.status.show();
  }
}
