/**
 * Running SQL from the editor.
 *
 * The human path and the agent path are the same request to the same daemon, so
 * there is nothing here for the MCP side to skip: credentials, tunnels, limits
 * and cancellation all happen on the other side of the socket. What is left is
 * deciding which statement the cursor is in and where to show the answer.
 */

import * as vscode from 'vscode';
import { configAt, splitSql, statementAt, type Capabilities, type Statement } from '@dbrex/core';
import type { DbRexClient } from '@dbrex/client';
import { report } from './daemon';
import type { ResultsPanel } from './panel';
import type { Session } from './session';
import { isViewFileFor, loadViews } from './views';
import type { LoadedViews } from './views';

export class Runner {
  /** The request id of the query in flight, so Cancel has something to name. */
  private running: { requestId: number; client: DbRexClient } | undefined;
  /** What the panel is showing, so an edited view can be redrawn without re-running. */
  private shown: {
    readonly document: vscode.TextDocument;
    readonly result: Parameters<ResultsPanel['show']>[0];
  } | undefined;

  constructor(
    private readonly connect: () => Promise<DbRexClient>,
    private readonly session: Session,
    private readonly panel: ResultsPanel,
    private readonly output: vscode.LogOutputChannel,
  ) {}

  async runStatement(editor: vscode.TextEditor): Promise<void> {
    const text = editor.document.getText();
    const statement = statementAt(splitSql(text), editor.document.offsetAt(editor.selection.active));
    if (!statement) {
      void vscode.window.showInformationMessage('DbRex: no statement here.');
      return;
    }
    await this.execute(editor.document, text, [statement]);
  }

  async runFile(editor: vscode.TextEditor): Promise<void> {
    const text = editor.document.getText();
    const statements = splitSql(text);
    if (statements.length === 0) {
      void vscode.window.showInformationMessage('DbRex: nothing to run.');
      return;
    }
    await this.execute(editor.document, text, statements);
  }

  /**
   * Run the statement under the cursor through the engine's EXPLAIN.
   *
   * Which form to use comes from the connection's declared capability, so a new
   * provider gets this command for free and an engine without EXPLAIN says so
   * instead of failing with a syntax error.
   */
  async explain(editor: vscode.TextEditor): Promise<void> {
    const connection = this.session.activeName ?? await this.session.pick();
    if (connection === undefined) return;

    const prefix = explainPrefix(this.session.info(connection)?.capabilities.explain);
    if (prefix === undefined) {
      void vscode.window.showInformationMessage(
        `DbRex: ${connection} does not support EXPLAIN.`,
      );
      return;
    }

    const text = editor.document.getText();
    const statement = statementAt(splitSql(text), editor.document.offsetAt(editor.selection.active));
    if (!statement) return;

    await this.execute(editor.document, text, [{
      ...statement,
      sql: `${prefix} ${statement.sql}`,
    }]);
  }

  /**
   * Redraw the panel when a view file belonging to it is saved.
   *
   * Editing a chart and having to re-run the query to see the change makes
   * every adjustment cost a round trip to the database. The rows have not
   * changed, so only the view code is re-read.
   */
  async reloadViewsAfterSave(saved: vscode.TextDocument): Promise<void> {
    const shown = this.shown;
    if (shown === undefined || saved.uri.scheme !== 'file') return;
    if (!isViewFileFor(shown.document.uri.fsPath, saved.uri.fsPath)) return;

    const views = await this.viewsFor(shown.document);
    const next = {
      ...shown.result,
      views: views.views,
      ...(views.defaultView === undefined ? {} : { defaultView: views.defaultView }),
    };
    this.panel.show(next);
    this.shown = { document: shown.document, result: next };
    this.output.info(`views reloaded for ${shown.document.uri.fsPath}`);
  }

  cancel(): void {
    if (!this.running) return;
    void this.running.client.cancel(this.running.requestId).catch(() => { /* already gone */ });
  }

  private async execute(
    document: vscode.TextDocument,
    text: string,
    statements: readonly Statement[],
  ): Promise<void> {
    const views = await this.viewsFor(document);
    const defaultLimit = vscode.workspace.getConfiguration('dbrex').get<number>('query.defaultLimit', 1000);

    for (const statement of statements) {
      const directives = configAt(text, statement.codeStart);
      const connection = directives.connection ?? this.session.activeName ?? await this.session.pick();
      if (connection === undefined) return;

      const limit = directives.limit ?? defaultLimit;
      const client = await this.connect();

      this.panel.reveal();
      this.panel.running(connection, statement.sql);

      try {
        const result = await client.query(
          {
            op: 'query',
            connection,
            sql: statement.sql,
            ...(limit > 0 ? { rowLimit: limit } : {}),
          },
          requestId => { this.running = { requestId, client }; },
        );

        const shown = {
          resultId: result.resultId,
          connection,
          sql: statement.sql,
          columns: result.columns,
          rowCount: result.rowCount,
          stats: result.stats,
          views: views.views,
          ...(views.defaultView === undefined ? {} : { defaultView: views.defaultView }),
        };
        this.panel.show(shown);
        this.shown = { document, result: shown };
        this.output.info(`${connection}: ${result.rowCount} rows in ${result.stats.elapsedMs}ms`);
      } catch (e) {
        this.panel.failed(
          e instanceof Error ? e.message : String(e),
          hintOf(e),
        );
        report(e, this.output);
        // Stop the run: continuing a script after a failed statement is rarely
        // what anyone wants, and never what they want on a write.
        return;
      } finally {
        this.running = undefined;
      }
    }
  }

  private async viewsFor(document: vscode.TextDocument): Promise<LoadedViews> {
    if (document.uri.scheme !== 'file') return { views: [] };
    return loadViews(document.uri.fsPath, {
      list: async directory => {
        const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(directory));
        return entries.filter(([, kind]) => kind === vscode.FileType.File).map(([name]) => name);
      },
      read: async file => {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(file));
        return Buffer.from(bytes).toString('utf8');
      },
    });
  }
}

/** `undefined` when the engine has no EXPLAIN worth offering. */
export function explainPrefix(support: Capabilities['explain'] | undefined): string | undefined {
  switch (support) {
    case 'analyze': return 'EXPLAIN ANALYZE';
    case 'plan': return 'EXPLAIN';
    // `validate` is a plan-only check with engine-specific syntax; it reaches
    // the user as squiggles through the `validate` capability instead.
    default: return undefined;
  }
}

function hintOf(e: unknown): string | undefined {
  const details = (e as { details?: { hint?: string } } | undefined)?.details;
  return details?.hint;
}
