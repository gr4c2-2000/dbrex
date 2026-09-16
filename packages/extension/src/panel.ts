/**
 * The results panel.
 *
 * Rows are not shipped with the result. The webview asks for the window it is
 * about to draw and the host reads that page from the daemon, which reads it by
 * seeking into the stored file. The old panel pushed a fixed 500 rows with
 * every result — including on a pure re-render — declared a paging message it
 * never sent, and handled a paging request nothing ever made, so 500 rows was
 * the hard ceiling of what a human could ever see.
 *
 * Custom view code never runs in this document. It runs in a nested frame with
 * `sandbox="allow-scripts"` and no `allow-same-origin`, which gives it an
 * opaque origin: no access to this DOM, no `acquireVsCodeApi`, and its own
 * content policy denying network access. The old panel ran the same code
 * through `new Function` in the panel document itself, with scripts enabled and
 * no content policy at all — and the MCP tool surface let an agent supply that
 * code.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import type { Column, QueryStats } from '@dbrex/core';
import { WEBVIEW_PROTOCOL, type HostMessage, type ViewDefinition, type WebviewMessage } from './webviewProtocol';

export interface PanelHandlers {
  requestRows(resultId: string, offset: number, limit: number): Promise<readonly (readonly unknown[])[]>;
  cancel(): void;
}

export class ResultsPanel {
  private panel: vscode.WebviewPanel | undefined;
  private ready = false;
  private queued: HostMessage[] = [];
  private resultId: string | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly handlers: PanelHandlers,
    private readonly output: vscode.LogOutputChannel,
  ) {}

  reveal(preserveFocus = true): void {
    this.ensure().reveal(vscode.ViewColumn.Beside, preserveFocus);
  }

  running(connection: string, sql: string): void {
    this.ensure();
    this.post({ type: 'running', connection, sql });
  }

  progress(rows: number): void {
    if (this.panel) this.post({ type: 'progress', rows });
  }

  failed(message: string, hint?: string): void {
    this.ensure();
    this.post({ type: 'failed', message, ...(hint === undefined ? {} : { hint }) });
  }

  show(result: {
    resultId: string;
    connection: string;
    sql: string;
    columns: readonly Column[];
    rowCount: number;
    stats: QueryStats;
    views: readonly ViewDefinition[];
    defaultView?: string;
  }): void {
    this.ensure();
    this.resultId = result.resultId;
    this.post({ type: 'result', ...result });
  }

  dispose(): void {
    this.panel?.dispose();
  }

  private ensure(): vscode.WebviewPanel {
    if (this.panel) return this.panel;

    const panel = vscode.window.createWebviewPanel(
      'dbrex.results',
      'DbRex Results',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
      },
    );

    panel.webview.html = this.render(panel.webview);
    panel.webview.onDidReceiveMessage((message: WebviewMessage) => void this.receive(message));
    panel.onDidDispose(() => {
      this.panel = undefined;
      // The webview document is gone; a new one will say hello again. The old
      // panel latched this flag on first ready and never reset it, so a panel
      // dragged to another editor group stopped receiving anything.
      this.ready = false;
      this.queued = [];
    });

    this.panel = panel;
    return panel;
  }

  private async receive(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready': {
        if (message.protocol !== WEBVIEW_PROTOCOL) {
          // Only reachable when a webview document survives an extension upgrade.
          void vscode.window.showWarningMessage(
            'DbRex: the results panel is from an older version — close and reopen it.',
          );
        }
        this.ready = true;
        const queued = this.queued.splice(0);
        for (const item of queued) this.post(item);
        return;
      }
      case 'requestRows': {
        if (this.resultId === undefined) return;
        const rows = await this.handlers.requestRows(this.resultId, message.offset, message.limit);
        this.post({ type: 'rows', offset: message.offset, rows });
        return;
      }
      case 'cancel':
        this.handlers.cancel();
        return;
      case 'copy':
        await vscode.env.clipboard.writeText(message.text);
        return;

      case 'viewFailed':
        // The webview already shows this where the chart would be. A
        // notification on top of that interrupts someone who is looking
        // straight at the problem, and a view that fails once tends to fail on
        // every redraw.
        this.output.warn(`view "${message.view}": ${message.message}`);
        return;
    }
  }

  private post(message: HostMessage): void {
    if (!this.ready) {
      this.queued.push(message);
      return;
    }
    void this.panel?.webview.postMessage(message);
  }

  private render(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'));
    const sandboxSource = this.sandboxSource();

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="
  default-src 'none';
  script-src 'nonce-${nonce}' ${webview.cspSource};
  style-src 'nonce-${nonce}';
  img-src ${webview.cspSource} data:;
  frame-src 'self';
  connect-src 'none';
">
<title>DbRex Results</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" type="application/json" id="sandbox-bootstrap">${
  // The nonce travels with the source: a srcdoc frame inherits this document's
  // policy, and the effective one is the intersection of the two. Without the
  // nonce the frame's own `'unsafe-inline'` intersects to nothing and its script
  // never runs — which is exactly how every custom view silently did nothing.
  JSON.stringify({ code: sandboxSource, nonce })
}</script>
<script nonce="${nonce}" src="${script.toString()}"></script>
</body>
</html>`;
  }

  /** The bundled script that runs inside the sandboxed frame, as source text. */
  private sandboxSource(): string {
    const file = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'sandbox.js').fsPath;
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  }
}

const STYLE = `
:root { color-scheme: light dark; }
body {
  margin: 0;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
}
#app { display: flex; flex-direction: column; height: 100vh; }
.bar {
  display: flex; align-items: center; gap: 12px;
  padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border);
  flex: 0 0 auto; white-space: nowrap; overflow-x: auto;
}
.bar .sql { opacity: .75; font-family: var(--vscode-editor-font-family); overflow: hidden; text-overflow: ellipsis; }
.bar .spacer { flex: 1 1 auto; }
button {
  font: inherit; color: var(--vscode-button-foreground); background: var(--vscode-button-background);
  border: none; padding: 3px 10px; border-radius: 2px; cursor: pointer;
}
button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
button[aria-pressed="true"] { outline: 1px solid var(--vscode-focusBorder); }
.scroll { flex: 1 1 auto; overflow: auto; position: relative; }
table { border-collapse: collapse; width: max-content; min-width: 100%; }
th, td {
  text-align: left; padding: 2px 10px; border-bottom: 1px solid var(--vscode-panel-border);
  font-family: var(--vscode-editor-font-family); font-size: 12px;
  max-width: 480px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
th { position: sticky; top: 0; background: var(--vscode-editor-background); z-index: 1; }
th .type { opacity: .55; font-weight: normal; margin-left: 6px; }
td.null { opacity: .45; font-style: italic; }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
tr:hover td { background: var(--vscode-list-hoverBackground); }
.pad { height: 0; }
.message { padding: 16px; }
.message.error { color: var(--vscode-errorForeground); }
.hint { opacity: .8; margin-top: 6px; }
iframe { border: 0; width: 100%; height: 100%; background: transparent; }
.dino { height: 18px; width: 20px; vertical-align: -4px; fill: currentColor; margin-right: 6px; }
.dino-eye { fill: var(--vscode-editor-background); }
.dino-step-a { animation: dino-step 260ms steps(1) infinite; }
.dino-step-b { animation: dino-step 260ms steps(1) infinite reverse; }
.running-label { animation: pulse 1.4s ease-in-out infinite; }
@keyframes dino-step { 0%, 49% { opacity: 1 } 50%, 100% { opacity: 0 } }
@keyframes pulse { 0%,100% { opacity: .45 } 50% { opacity: 1 } }
@media (prefers-reduced-motion: reduce) {
  .dino-step-a, .dino-step-b, .running-label { animation: none }
  .dino-step-b { opacity: 0 }
}
`;
