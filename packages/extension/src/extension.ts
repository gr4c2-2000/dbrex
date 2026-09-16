/**
 * Activation.
 *
 * This file wires things together and does nothing else. The old extension's
 * equivalent was six hundred lines holding eleven mutable globals, the whole
 * command surface, the Trino login flow and the query executor, with no
 * exported seam, so none of it could be tested and a throw halfway through
 * activation leaked every disposable created before it.
 *
 * Everything below registers a disposable with `context.subscriptions` as it is
 * created, so a failure part way through still unwinds cleanly.
 */

import * as vscode from 'vscode';
import { configDirFor, type ConnectionInfo, type ResultSummary } from '@dbrex/core';
import { Daemon, report, socketEnvironment, workspacePath } from './daemon';
import { Runner } from './editor';
import { Diagnostics, Schema, registerCompletion } from './lsp';
import { ResultsPanel } from './panel';
import { Session } from './session';
import { ResultsTree, SchemaTree } from './trees';
import { placeBlock } from './insert';
import { addConnection, editConnectionOption } from './wizard';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('DbRex', { log: true });
  context.subscriptions.push(output);

  const session = new Session(context.workspaceState);
  context.subscriptions.push(session);

  const connect = (): Promise<import('@dbrex/client').DbRexClient> => daemon.connected();
  const schema = new Schema(connect);
  const explorer = new SchemaTree(connect, output);
  const results = new ResultsTree(connect, output);

  const openStoredResult = (summary: ResultSummary): void => {
    panel.reveal(false);
    panel.show({
      resultId: summary.resultId,
      connection: summary.connection,
      sql: summary.sql,
      columns: summary.columns,
      rowCount: summary.rowCount,
      stats: { elapsedMs: 0, truncated: summary.truncated },
      views: [],
    });
  };

  const daemon = new Daemon(context, output, {
    onConnectionsChanged: connections => applyConnections(connections),
    onResultsChanged: () => results.refresh(),
    onShowResult: summary => {
      output.info(`agent asked to show result ${summary.resultId}`);
      openStoredResult(summary);
    },
  });
  context.subscriptions.push({ dispose: () => daemon.dispose() });

  const applyConnections = (connections: readonly ConnectionInfo[]): void => {
    session.update(connections);
    explorer.update(connections);
    schema.invalidate();
  };

  /**
   * The editor the user was last working in.
   *
   * `activeTextEditor` is undefined while a webview has focus, and clicking a
   * button in the results panel is exactly that moment — so the panel could
   * never find the editor it was meant to type into.
   */
  let lastEditor = vscode.window.activeTextEditor;
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor !== undefined) lastEditor = editor;
    }),
  );

  const panel = new ResultsPanel(context, {
    requestRows: async (resultId, offset, limit) => {
      const client = await connect();
      const page = await client.call({ op: 'readRows', resultId, offset, limit });
      return page.rows;
    },
    cancel: (): void => runner.cancel(),
  }, output);

  /**
   * Put SQL into the editor the user was last working in.
   *
   * `activeTextEditor` is undefined while the sidebar or a webview has focus,
   * and clicking an action in the results list is exactly that moment — so the
   * obvious implementation never finds an editor to type into.
   */
  const insertIntoEditor = async (text: string): Promise<void> => {
    const editor = lastEditor;
    if (editor === undefined || editor.document.isClosed) {
      void vscode.window.showInformationMessage('DbRex: open a file to insert the query into.');
      return;
    }
    // Replacing the selection covers both cases: with a selection it swaps what
    // is highlighted, without one it inserts at the cursor. The block is padded
    // so its first line starts a line — a `-- @conn` directive only counts
    // there, and pasted mid-line it would quietly stop being one.
    const at = editor.selection.start;
    const line = editor.document.lineAt(at.line);
    const { text: block } = placeBlock(
      text,
      at.character,
      line.text.slice(editor.selection.end.character),
    );
    await editor.edit(edit => edit.replace(editor.selection, block));
    await vscode.window.showTextDocument(editor.document, editor.viewColumn);
  };
  context.subscriptions.push({ dispose: () => panel.dispose() });

  const runner = new Runner(connect, session, panel, output);

  const diagnostics = new Diagnostics(
    connect,
    () => session.activeName,
    name => session.info(name)?.capabilities.validate === true,
  );
  context.subscriptions.push(diagnostics);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('dbrex.explorer', explorer),
    vscode.window.registerTreeDataProvider('dbrex.history', results),
    registerCompletion(schema, () => session.activeName),
  );

  const command = (name: string, run: (...args: never[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(name, async (...args: never[]) => {
      try {
        await run(...args);
      } catch (e) {
        report(e, output);
      }
    }));
  };

  command('dbrex.runStatement', async () => {
    const editor = vscode.window.activeTextEditor;
    if (editor) await runner.runStatement(editor);
  });

  command('dbrex.runFile', async () => {
    const editor = vscode.window.activeTextEditor;
    if (editor) await runner.runFile(editor);
  });

  command('dbrex.cancel', () => runner.cancel());

  command('dbrex.explain', async () => {
    const editor = vscode.window.activeTextEditor;
    if (editor) await runner.explain(editor);
  });

  command('dbrex.editConnection', async () => {
    const name = await session.choose('Change a setting on which connection?');
    const info = name === undefined ? undefined : session.info(name);
    if (!info) return;
    const client = await connect();
    if (await editConnectionOption(client, info, configDirFor(socketEnvironment()))) {
      void vscode.window.showInformationMessage(`DbRex: "${info.name}" updated.`);
    }
  });
  command('dbrex.openResults', () => panel.reveal(false));
  command('dbrex.pickConnection', () => session.pick());
  command('dbrex.refreshExplorer', () => {
    schema.invalidate();
    explorer.refresh();
  });

  command('dbrex.addConnection', async () => {
    const client = await connect();
    const name = await addConnection(client, configDirFor(socketEnvironment()));
    if (name !== undefined) session.setActive(name);
  });

  const setPasswordFor = async (connection: string): Promise<void> => {
    const value = await vscode.window.showInputBox({
      prompt: `Password for "${connection}"`,
      password: true,
      ignoreFocusOut: true,
    });
    if (value === undefined) return;
    const client = await connect();
    await client.call({ op: 'setSecret', connection, value });
    // The stored credential changed, so anything cached from the old one is stale.
    schema.invalidate();
    explorer.refresh();
    void vscode.window.showInformationMessage(`DbRex: password stored for "${connection}".`);
  };

  command('dbrex.setPassword', async () => {
    // Always ask which one. Defaulting to the active connection means a
    // password typed for one database silently lands on another.
    const connection = await session.choose('Store a password for which connection?');
    if (connection !== undefined) await setPasswordFor(connection);
  });

  // Not in the palette: it takes a connection name, and the failure node in the
  // schema tree is what invokes it.
  command('dbrex.setPasswordFor', async (connection: never) => {
    if (typeof connection === 'string') await setPasswordFor(connection);
  });

  command('dbrex.unlockVault', async () => {
    const client = await connect();
    const status = await client.call({ op: 'vaultStatus' });
    if (status.unlocked) {
      void vscode.window.showInformationMessage('DbRex: the vault is already unlocked.');
      return;
    }
    const passphrase = await vscode.window.showInputBox({
      prompt: 'Passphrase for the DbRex secret vault',
      password: true,
      ignoreFocusOut: true,
    });
    if (passphrase === undefined) return;
    await client.call({ op: 'unlock', passphrase });
    void vscode.window.showInformationMessage('DbRex: vault unlocked.');
  });

  command('dbrex.reload', async () => {
    const client = await connect();
    const { connections } = await client.call({ op: 'reloadConnections' });
    applyConnections(connections);
    void vscode.window.showInformationMessage(`DbRex: ${connections.length} connection(s) loaded.`);
  });

  command('dbrex.copyMcpConfig', async () => {
    // The seeded copy, not the one inside the extension directory: an extension
    // path carries a version number and disappears on the next upgrade, while
    // an agent's MCP configuration keeps pointing at whatever it was told once.
    const binary = `${configDirFor(socketEnvironment())}/bin/dbrex.js`;
    const line = `claude mcp add --scope user dbrex -- node ${binary} mcp`;
    await vscode.env.clipboard.writeText(line);
    void vscode.window.showInformationMessage('DbRex: MCP setup command copied to the clipboard.');
  });


  command('dbrex.openResult', (summary: never) => {
    openStoredResult(summary as unknown as ResultSummary);
  });

  command('dbrex.insertSelect', async (item: never) => {
    const node = item as unknown as {
      connection?: string;
      node?: { query?: string; name?: string };
    };
    const query = node.node?.query;
    if (query === undefined || node.connection === undefined) return;

    // The directive rides along so the statement runs against the connection it
    // came from, whatever the window happens to have selected. That is the same
    // rule the editor, the completions and the syntax check all follow.
    await insertIntoEditor(`-- @conn: ${node.connection}\n${query}`);
  });


  command('dbrex.copyResultSql', async (summary: never) => {
    const stored = summary as unknown as ResultSummary;
    await vscode.env.clipboard.writeText(stored.sql);
    void vscode.window.showInformationMessage('DbRex: query copied.');
  });

  command('dbrex.useResultSql', async (summary: never) => {
    await insertIntoEditor((summary as unknown as ResultSummary).sql);
  });

  command('dbrex.pinResult', async (summary: never) => {
    const stored = summary as unknown as { resultId: string; pinned: boolean };
    const client = await connect();
    await client.call({ op: 'pinResult', resultId: stored.resultId, pinned: !stored.pinned });
  });

  command('dbrex.deleteResult', async (summary: never) => {
    const stored = summary as unknown as { resultId: string };
    const client = await connect();
    await client.call({ op: 'deleteResult', resultId: stored.resultId });
  });

  const pushSettings = async (): Promise<void> => {
    const config = vscode.workspace.getConfiguration('dbrex');
    const client = await connect();
    await client.call({
      op: 'updateSettings',
      settings: {
        identityUser: config.get<string>('identity.user', ''),
        resultsMode: config.get<'sliding' | 'unlimited'>('storage.results.mode', 'sliding'),
        resultsMaxBytes: Math.max(1, config.get<number>('storage.results.maxMb', 500)) * 1024 * 1024,
        logLevel: config.get<'debug' | 'info' | 'warn' | 'error'>('log.level', 'info'),
        showAgentResults: config.get<boolean>('mcp.showAgentResults', true),
      },
    });
  };

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(event => {
      // The old extension read every setting once at activation, so changing any
      // of them meant reloading the window.
      if (event.affectsConfiguration('dbrex')) void pushSettings().catch(e => report(e, output));
    }),
    vscode.workspace.onDidChangeTextDocument(event => diagnostics.schedule(event.document)),
    vscode.workspace.onDidSaveTextDocument(saved => {
      void runner.reloadViewsAfterSave(saved).catch(e => report(e, output));
    }),
    vscode.workspace.onDidCloseTextDocument(document => diagnostics.clear(document)),
    session.onDidChangeActive(() => {
      schema.invalidate();
      explorer.refresh();
    }),
  );

  // Connecting is the last thing: everything above is registered whether or not
  // the daemon is reachable, so a failure here degrades the extension instead of
  // disabling it.
  try {
    const client = await daemon.connected();
    await pushSettings();
    const { connections } = await client.call({ op: 'listConnections' });
    applyConnections(connections);
    output.info(`ready: ${connections.length} connection(s), workspace ${workspacePath() ?? 'none'}`);
  } catch (e) {
    report(e, output);
  }
}

export function deactivate(): void {
  // Nothing: `context.subscriptions` owns everything, and the daemon is meant to
  // outlive this window.
}
