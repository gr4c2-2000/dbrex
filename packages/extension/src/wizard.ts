/**
 * Changing and removing a connection, one prompt at a time.
 *
 * Creating one is a form now (`connectionForm.ts`), because eight sequential
 * pickers could not be reviewed or revisited. What is left here is the two
 * operations that genuinely are one question: which setting to change, and
 * whether to delete.
 *
 * The question a change asks is still generated from what the provider declares.
 * The original wizard hard-coded a list of kinds and a per-kind chain of `if`
 * statements, which is why S3 — added later — could not be configured through it
 * at all.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DbRexClient } from '@dbrex/client';
import type { ConnectionInfo, FieldSpec } from '@dbrex/core';
import { removeConnectionEntry, updateConnection } from './connectionsFile';

/**
 * Change one declared option on an existing connection.
 *
 * The old tool had a Trino-only "Select Catalog/Schema" command, which meant
 * every other engine's settings could only be changed by hand-editing JSON, and
 * a new provider had to ship its own command to be usable. This asks the
 * provider what it accepts and edits that field in the file it came from.
 */
export async function editConnectionOption(
  client: DbRexClient,
  connection: ConnectionInfo,
  configDir: string,
): Promise<boolean> {
  const { providers } = await client.call({ op: 'describeProviders' });
  const provider = providers.find(p => p.id === connection.kind);
  if (!provider) {
    void vscode.window.showErrorMessage(`DbRex: no provider named "${connection.kind}".`);
    return false;
  }

  const field = await vscode.window.showQuickPick(
    provider.fields.map(f => ({
      label: f.name,
      description: f.type,
      detail: f.description,
      field: f,
    })),
    { placeHolder: `Which setting of "${connection.name}" should change?` },
  );
  if (!field) return false;

  const value = await askField(field.field, provider.displayName);
  if (value === undefined) return false;

  const file = fileHolding(connection, configDir);
  if (file === undefined) {
    void vscode.window.showErrorMessage('DbRex: could not find the file this connection came from.');
    return false;
  }

  if (!updateConnection(file, connection.name, field.field.name, value)) {
    void vscode.window.showErrorMessage(`DbRex: "${connection.name}" is not in ${file}.`);
    return false;
  }

  // The daemon watches these files, but asking explicitly means the user sees
  // the result immediately rather than a third of a second later.
  await client.call({ op: 'reloadConnections' });
  return true;
}

/**
 * The file an entry lives in, or `undefined` when there is none.
 *
 * An inline connection is declared in a `.sql` file by its own directives and
 * was never written to a connections file, so there is nothing here to edit or
 * remove — the statement that defines it is.
 */
function fileHolding(connection: ConnectionInfo, configDir: string): string | undefined {
  if (connection.origin === 'inline') return undefined;
  if (connection.origin === 'global') return path.join(configDir, 'connections.json');
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return workspace === undefined ? undefined : path.join(workspace, '.dbrex', 'connections.json');
}

/**
 * Delete a connection, after asking.
 *
 * Modal, because this edits a file the user wrote and the undo for it is "type
 * it again". The name is in the prompt so a misclick on the wrong row is visible
 * before it is irreversible.
 */
export async function removeConnection(
  client: DbRexClient,
  connection: ConnectionInfo,
  configDir: string,
): Promise<boolean> {
  if (connection.origin === 'inline') {
    void vscode.window.showWarningMessage(
      `DbRex: "${connection.name}" is defined by directives in a .sql file. `
      + 'Remove them from the file instead.',
    );
    return false;
  }

  const file = fileHolding(connection, configDir);
  if (file === undefined) {
    void vscode.window.showErrorMessage('DbRex: could not find the file this connection came from.');
    return false;
  }

  const confirmed = await vscode.window.showWarningMessage(
    `Delete the connection "${connection.name}"?`,
    { modal: true, detail: `It will be removed from ${file}. Stored passwords are left alone.` },
    'Delete',
  );
  if (confirmed !== 'Delete') return false;

  if (!removeConnectionEntry(file, connection.name)) {
    void vscode.window.showErrorMessage(`DbRex: "${connection.name}" is not in ${file}.`);
    return false;
  }

  await client.call({ op: 'reloadConnections' });
  return true;
}

async function askField(field: FieldSpec, provider: string): Promise<unknown> {
  if (field.type === 'boolean') {
    const picked = await vscode.window.showQuickPick(['no', 'yes'], {
      placeHolder: `${field.description} (${field.name})`,
      ignoreFocusOut: true,
    });
    return picked === undefined ? undefined : picked === 'yes';
  }

  const value = await vscode.window.showInputBox({
    title: `${provider} — ${field.name}`,
    prompt: field.description + (field.substitute === true ? '  ($user, $home and $env:NAME work here)' : ''),
    value: field.default === undefined ? '' : String(field.default),
    ignoreFocusOut: true,
    validateInput: input => {
      if (input.trim().length === 0) {
        return field.required === true ? `${field.name} is required` : undefined;
      }
      if (field.type === 'number' && !Number.isFinite(Number(input))) return 'expected a number';
      return undefined;
    },
  });

  if (value === undefined || value.trim().length === 0) return undefined;
  return field.type === 'number' ? Number(value) : value;
}
