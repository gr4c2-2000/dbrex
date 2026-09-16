/**
 * The two sidebar trees.
 *
 * Both are windows onto daemon state and hold none of their own: the schema
 * tree asks `browse` for the children of a path, and the results tree lists
 * what the store actually still has. The old history view listened only for
 * saves, so results evicted by the size cap stayed on screen until something
 * else was saved and clicking one produced an error; the daemon now reports
 * deletions too and this tree refreshes on them.
 */

import * as vscode from 'vscode';
import type { DbRexClient } from '@dbrex/client';
import { DbRexError, messageOf, type BrowseNode, type ConnectionInfo, type ResultSummary } from '@dbrex/core';

/** One line for a tree label: the message, and the hint when there is room. */
function summarise(error: DbRexError): string {
  const hint = error.details.hint;
  return hint === undefined ? error.message : `${error.message} — ${hint}`;
}

type SchemaItem =
  | { readonly kind: 'connection'; readonly connection: ConnectionInfo }
  | { readonly kind: 'node'; readonly connection: string; readonly path: readonly string[]; readonly node: BrowseNode }
  | { readonly kind: 'failure'; readonly connection: string; readonly error: DbRexError };

export class SchemaTree implements vscode.TreeDataProvider<SchemaItem> {
  private readonly changed = new vscode.EventEmitter<SchemaItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  private connections: readonly ConnectionInfo[] = [];
  /** Error codes already reported per connection, so expanding twice does not nag twice. */
  private announced = new Map<string, string>();

  constructor(
    private readonly connect: () => Promise<DbRexClient>,
    private readonly output: vscode.LogOutputChannel,
  ) {}

  update(connections: readonly ConnectionInfo[]): void {
    this.connections = connections;
    this.refresh();
  }

  refresh(): void {
    this.announced.clear();
    this.changed.fire(undefined);
  }

  getTreeItem(item: SchemaItem): vscode.TreeItem {
    if (item.kind === 'failure') {
      // A tree that simply stays empty is indistinguishable from a database with
      // nothing in it. The old failure path logged to an output channel nobody
      // had open and returned no children at all.
      const label = item.error.code === 'auth_interaction_required'
        ? 'needs a password — click to enter it'
        : summarise(item.error);
      const element = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
      element.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
      element.tooltip = new vscode.MarkdownString(
        `**${item.error.code}** — ${item.error.message}` +
        (item.error.details.hint ? `\n\n${item.error.details.hint}` : ''),
      );
      element.contextValue = `dbrex.failure.${item.error.code}`;
      if (item.error.code === 'auth' || item.error.code === 'auth_interaction_required') {
        element.command = {
          command: 'dbrex.setPasswordFor',
          title: 'Set password',
          arguments: [item.connection],
        };
      }
      return element;
    }

    if (item.kind === 'connection') {
      const element = new vscode.TreeItem(
        item.connection.name,
        item.connection.capabilities.browse
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None,
      );
      element.description = item.connection.kind;
      element.tooltip = item.connection.reference ?? item.connection.kind;
      element.iconPath = new vscode.ThemeIcon('database');
      element.contextValue = 'dbrex.connection';
      return element;
    }

    const element = new vscode.TreeItem(
      item.node.name,
      item.node.hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    if (item.node.detail !== undefined) element.description = item.node.detail;
    element.iconPath = new vscode.ThemeIcon(iconFor(item.node.kind));
    // Only a node you can actually query does anything when clicked. Pasting
    // the name of a database, a prefix or a column is not a thing anyone asked
    // for, and a tree whose every row types something into your file is a tree
    // you cannot browse without damage.
    if (item.node.query !== undefined) {
      element.command = { command: 'dbrex.insertSelect', title: 'Insert SELECT', arguments: [item] };
    }
    element.contextValue = item.node.query === undefined ? 'dbrex.node' : 'dbrex.node.queryable';
    if (item.node.query !== undefined) {
      element.tooltip = new vscode.MarkdownString(
        `\`\`\`sql\n-- @conn: ${item.connection}\n${item.node.query}\n\`\`\``,
      );
    }
    return element;
  }

  async getChildren(item?: SchemaItem): Promise<SchemaItem[]> {
    if (item === undefined) {
      return this.connections.map(connection => ({ kind: 'connection', connection }));
    }

    // A failure node is a leaf: clicking it offers the fix, expanding it does nothing.
    if (item.kind === 'failure') return [];

    const connection = item.kind === 'connection' ? item.connection.name : item.connection;
    const parentPath = item.kind === 'connection' ? [] : [...item.path, item.node.name];

    try {
      const client = await this.connect();
      const { nodes } = await client.call({ op: 'browse', connection, path: parentPath });
      this.announced.delete(connection);
      return nodes.map(node => ({ kind: 'node', connection, path: parentPath, node }));
    } catch (e) {
      const error = DbRexError.is(e) ? e : new DbRexError('internal', messageOf(e));
      this.output.warn(`browse ${connection} ${parentPath.join('/')}: ${error.code}: ${error.message}`);
      this.notifyOnce(connection, error);
      return [{ kind: 'failure', connection, error }];
    }
  }

  /**
   * Say it out loud once per connection and error.
   *
   * Once, because expanding a tree retries on every click and a modal-free
   * notification per click is its own kind of broken. Out loud at all, because
   * a wrong password should not look like an empty database.
   */
  private notifyOnce(connection: string, error: DbRexError): void {
    if (this.announced.get(connection) === error.code) return;
    this.announced.set(connection, error.code);

    if (error.code === 'auth' || error.code === 'auth_interaction_required') {
      const fix = 'Enter password';
      // A dismissed prompt is a normal thing to do by accident; offer the way
      // back rather than making the user find the command.
      const text = error.code === 'auth'
        ? `DbRex: ${connection} rejected the credentials — ${error.message}`
        : `DbRex: ${connection} still needs a password.`;
      void vscode.window.showErrorMessage(text, fix).then(choice => {
        if (choice === fix) void vscode.commands.executeCommand('dbrex.setPasswordFor', connection);
      });
      return;
    }
    if (error.code === 'cancelled') return;
    void vscode.window.showErrorMessage(`DbRex: ${connection} — ${summarise(error)}`);
  }
}

function iconFor(kind: BrowseNode['kind']): string {
  switch (kind) {
    case 'database': return 'database';
    case 'schema': return 'symbol-namespace';
    case 'table': return 'table';
    case 'view': return 'eye';
    case 'column': return 'symbol-field';
    case 'container': return 'folder';
    case 'object': return 'file';
  }
}

export class ResultsTree implements vscode.TreeDataProvider<ResultSummary> {
  private readonly changed = new vscode.EventEmitter<undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly connect: () => Promise<DbRexClient>,
    private readonly output: vscode.LogOutputChannel,
  ) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(summary: ResultSummary): vscode.TreeItem {
    const element = new vscode.TreeItem(oneLine(summary.sql), vscode.TreeItemCollapsibleState.None);
    element.description = `${summary.rowCount} rows · ${summary.connection}`;
    element.tooltip = new vscode.MarkdownString(
      `\`\`\`sql\n${summary.sql}\n\`\`\`\n\n${summary.createdAt}${summary.truncated ? ' · truncated' : ''}`,
    );
    element.iconPath = new vscode.ThemeIcon(summary.pinned ? 'pinned' : 'output');
    element.contextValue = summary.pinned ? 'dbrex.result.pinned' : 'dbrex.result';
    element.id = summary.resultId;
    element.command = { command: 'dbrex.openResult', title: 'Open', arguments: [summary] };
    return element;
  }

  async getChildren(): Promise<ResultSummary[]> {
    try {
      const client = await this.connect();
      const { results } = await client.call({ op: 'listResults', limit: 100 });
      return [...results];
    } catch (e) {
      this.output.warn(`listing results: ${messageOf(e)}`);
      return [];
    }
  }
}

function oneLine(sql: string): string {
  const flat = sql.replace(/\s+/g, ' ').trim();
  return flat.length > 60 ? `${flat.slice(0, 57)}…` : flat;
}
