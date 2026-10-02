/**
 * The window the connection form lives in.
 *
 * The form replaced a chain of modal pickers. What the host still owns is
 * everything the form must not decide for itself: which names are taken, what a
 * declared field means, where a scope writes to, and whether a password goes to
 * the vault. The form collects; this validates and commits.
 */

import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import type { DbRexClient } from '@dbrex/client';
import { appendConnection } from './connectionsFile';
import { buildEntry, formProvider, scopeOptions, validateSubmission } from './connectionEntry';
import {
  FORM_PROTOCOL,
  type FormBootstrap,
  type FormHostMessage,
  type FormSubmission,
  type FormWebviewMessage,
} from './connectionFormProtocol';

export class ConnectionForm {
  private panel: vscode.WebviewPanel | undefined;
  private ready = false;
  private queued: FormHostMessage[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connect: () => Promise<DbRexClient>,
    private readonly configDir: () => string,
    private readonly workspace: () => string | undefined,
    private readonly output: vscode.LogOutputChannel,
    private readonly onSaved: (name: string) => Promise<void>,
  ) {}

  async open(): Promise<void> {
    const panel = this.ensure();
    panel.reveal(vscode.ViewColumn.Active, false);
    await this.sendBootstrap();
  }

  dispose(): void {
    this.panel?.dispose();
  }

  private async sendBootstrap(): Promise<void> {
    const client = await this.connect();
    const [{ providers }, { connections }] = await Promise.all([
      client.call({ op: 'describeProviders' }),
      client.call({ op: 'listConnections' }),
    ]);

    const data: FormBootstrap = {
      protocol: FORM_PROTOCOL,
      providers: providers.map(formProvider),
      scopes: scopeOptions(this.configDir(), this.workspace()),
      existing: connections.map(c => c.name),
    };
    this.post({ type: 'bootstrap', data });
  }

  private async save(submission: FormSubmission): Promise<void> {
    const client = await this.connect();
    const { providers } = await client.call({ op: 'describeProviders' });
    const provider = providers.find(p => p.id === submission.kind);
    if (provider === undefined) {
      this.post({ type: 'failed', message: `No provider named "${submission.kind}".`, problems: [] });
      return;
    }

    // Re-read rather than trusting what the form was given at open: another
    // window may have added a connection while this one sat on screen.
    const { connections } = await client.call({ op: 'listConnections' });
    const drawn = provider.fields.filter(f => f.prompt !== false);
    const problems = validateSubmission(submission, drawn, connections.map(c => c.name));
    if (problems.length > 0) {
      this.post({
        type: 'failed',
        message: problems.length === 1 ? 'One field needs attention.' : `${problems.length} fields need attention.`,
        problems,
      });
      return;
    }

    const scope = scopeOptions(this.configDir(), this.workspace())
      .find(s => s.scope === submission.scope);
    if (scope === undefined || !scope.available) {
      this.post({
        type: 'failed',
        message: 'That scope is not available. Open a folder, or save it globally.',
        problems: [],
      });
      return;
    }

    const entry = buildEntry(submission, drawn);
    try {
      appendConnection(scope.file, entry);
    } catch (e) {
      this.post({
        type: 'failed',
        message: `Could not write ${scope.file}: ${e instanceof Error ? e.message : String(e)}`,
        problems: [],
      });
      return;
    }

    await client.call({ op: 'reloadConnections' });

    // The password goes after the entry exists: the daemon keys a vault slot by
    // connection name, so storing it first would put it under a name nothing
    // refers to yet.
    if (submission.password.length > 0) {
      try {
        await client.call({ op: 'setSecret', connection: entry['name'] as string, value: submission.password });
      } catch (e) {
        // The connection is saved; only the password failed. Saying so is better
        // than reporting the whole thing as a failure it was not.
        void vscode.window.showWarningMessage(
          `DbRex: "${entry['name'] as string}" was saved, but its password was not stored: `
          + (e instanceof Error ? e.message : String(e)),
        );
      }
    }

    const name = entry['name'] as string;
    this.post({ type: 'saved', name });
    this.output.info(`connection "${name}" written to ${scope.file}`);
    this.panel?.dispose();
    await this.onSaved(name);
  }

  private ensure(): vscode.WebviewPanel {
    if (this.panel) return this.panel;

    const panel = vscode.window.createWebviewPanel(
      'dbrex.connectionForm',
      'New DbRex Connection',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
      },
    );

    panel.webview.html = this.render(panel.webview);
    panel.webview.onDidReceiveMessage((message: FormWebviewMessage) => void this.receive(message));
    panel.onDidDispose(() => {
      this.panel = undefined;
      // The document is gone; a new one says hello again. Latching this would
      // leave a reopened form never receiving its bootstrap.
      this.ready = false;
      this.queued = [];
    });

    this.panel = panel;
    return panel;
  }

  private async receive(message: FormWebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready': {
        if (message.protocol !== FORM_PROTOCOL) {
          this.output.error(`connection form speaks protocol ${message.protocol}, host speaks ${FORM_PROTOCOL}`);
          return;
        }
        this.ready = true;
        for (const queued of this.queued.splice(0)) this.post(queued);
        return;
      }
      case 'submit':
        try {
          await this.save(message.submission);
        } catch (e) {
          this.post({
            type: 'failed',
            message: e instanceof Error ? e.message : String(e),
            problems: [],
          });
        }
        return;
      case 'cancel':
        this.panel?.dispose();
        return;
    }
  }

  private post(message: FormHostMessage): void {
    if (!this.ready) {
      this.queued.push(message);
      return;
    }
    void this.panel?.webview.postMessage(message);
  }

  private render(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'connectionForm.js'),
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="
  default-src 'none';
  script-src 'nonce-${nonce}' ${webview.cspSource};
  style-src 'nonce-${nonce}';
  connect-src 'none';
">
<title>New DbRex Connection</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script.toString()}"></script>
</body>
</html>`;
  }
}

/**
 * The form's appearance.
 *
 * Every colour is a VSCode theme variable, so the form belongs to whatever
 * theme is in use rather than to one someone picked while writing it.
 */
const STYLE = `
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
}
.form { max-width: 620px; margin: 0 auto; padding: 24px 20px 40px; }
h1 { font-size: 1.4em; font-weight: 600; margin: 0 0 20px; }
h2 {
  font-size: .85em; font-weight: 600; text-transform: uppercase; letter-spacing: .06em;
  opacity: .7; margin: 28px 0 12px; padding-bottom: 6px;
  border-bottom: 1px solid var(--vscode-panel-border);
}
.loading { padding: 24px 20px; opacity: .7; }

.field { margin-bottom: 16px; }
.label { display: block; margin-bottom: 4px; font-weight: 600; }
.required { color: var(--vscode-errorForeground); }
.hint { margin-top: 4px; font-size: .9em; opacity: .65; line-height: 1.4; }
.problem { margin-top: 4px; font-size: .9em; color: var(--vscode-errorForeground); }

input[type="text"], input[type="password"] {
  width: 100%; padding: 6px 8px; font: inherit;
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 2px;
}
input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
input.invalid { border-color: var(--vscode-errorForeground); }

.checkbox { display: flex; align-items: center; gap: 8px; }
.checkbox-label { font-weight: 600; }

.choices { display: flex; flex-wrap: wrap; gap: 8px; }
.choice {
  display: flex; flex-direction: column; gap: 2px; align-items: flex-start;
  padding: 8px 12px; font: inherit; text-align: left; cursor: pointer;
  color: var(--vscode-foreground);
  background: var(--vscode-editorWidget-background);
  border: 1px solid var(--vscode-panel-border); border-radius: 4px;
}
.choice:hover:not(:disabled) { border-color: var(--vscode-focusBorder); }
.choice.selected {
  border-color: var(--vscode-focusBorder);
  background: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
}
.choice:disabled { opacity: .45; cursor: default; }
.choice-name { font-weight: 600; }
.choice-detail { font-size: .85em; opacity: .7; font-family: var(--vscode-editor-font-family); }
.scopes .choice { flex: 1 1 240px; }

.banner {
  padding: 8px 12px; margin-bottom: 16px; border-radius: 3px;
  background: var(--vscode-inputValidation-errorBackground);
  border: 1px solid var(--vscode-inputValidation-errorBorder);
}

.actions { display: flex; gap: 8px; margin-top: 28px; }
button.primary, button.secondary {
  padding: 6px 16px; font: inherit; cursor: pointer; border: none; border-radius: 2px;
}
button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
button.primary:hover { background: var(--vscode-button-hoverBackground); }
button.secondary {
  color: var(--vscode-button-secondaryForeground);
  background: var(--vscode-button-secondaryBackground);
}
`;
