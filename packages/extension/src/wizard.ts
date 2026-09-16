/**
 * Adding a connection.
 *
 * The form is generated from what the daemon says each provider accepts. The
 * old wizard hard-coded a list of kinds, a default port per kind and a
 * per-kind chain of `if` statements, which is why S3 connections — added later —
 * could not be created through it at all and had to be written into JSON by
 * hand. Here a provider that declares its fields gets a working wizard for free.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DbRexClient } from '@dbrex/client';
import type { ConnectionInfo, FieldSpec, ProviderInfo } from '@dbrex/core';

export async function addConnection(client: DbRexClient, configDir: string): Promise<string | undefined> {
  const { providers } = await client.call({ op: 'describeProviders' });
  if (providers.length === 0) {
    void vscode.window.showErrorMessage('DbRex: the daemon reports no providers.');
    return undefined;
  }

  const provider = await pickProvider(providers);
  if (!provider) return undefined;

  const name = await vscode.window.showInputBox({
    prompt: 'Name for this connection',
    placeHolder: 'prod',
    ignoreFocusOut: true,
    validateInput: value => (value.trim().length === 0 ? 'a name is required' : undefined),
  });
  if (name === undefined) return undefined;

  const options: Record<string, unknown> = {};
  for (const field of provider.fields) {
    if (field.prompt === false) continue;
    const value = await askField(field, provider.displayName);
    if (value === undefined && field.required === true) return undefined;
    if (value !== undefined) options[field.name] = value;
  }

  const reference = await vscode.window.showInputBox({
    prompt: 'What is this connection for? Shown to the AI before it queries.',
    placeHolder: 'Production orders. Schema docs: https://…',
    ignoreFocusOut: true,
  });

  const where = await vscode.window.showQuickPick(
    [
      { label: 'Just for me', description: '~/.dbrex/connections.json', target: 'global' as const },
      { label: 'This workspace', description: '.dbrex/connections.json — commit it if you like', target: 'workspace' as const },
    ],
    { placeHolder: 'Where should this connection live?' },
  );
  if (!where) return undefined;

  const file = where.target === 'global'
    ? path.join(configDir, 'connections.json')
    : path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? configDir, '.dbrex', 'connections.json');

  append(file, {
    name: name.trim(),
    kind: provider.id,
    ...(reference && reference.trim().length > 0 ? { reference: reference.trim() } : {}),
    ...options,
  });

  await client.call({ op: 'reloadConnections' });
  const document = await vscode.workspace.openTextDocument(file);
  await vscode.window.showTextDocument(document, { preview: false });
  return name.trim();
}

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

  if (!updateEntry(file, connection.name, field.field.name, value)) {
    void vscode.window.showErrorMessage(`DbRex: "${connection.name}" is not in ${file}.`);
    return false;
  }

  // The daemon watches these files, but asking explicitly means the user sees
  // the result immediately rather than a third of a second later.
  await client.call({ op: 'reloadConnections' });
  return true;
}

function fileHolding(connection: ConnectionInfo, configDir: string): string | undefined {
  if (connection.origin === 'global') return path.join(configDir, 'connections.json');
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return workspace === undefined ? undefined : path.join(workspace, '.dbrex', 'connections.json');
}

/** Rewrite one field of one entry, leaving every other byte of the file alone. */
function updateEntry(file: string, name: string, option: string, value: unknown): boolean {
  let document: { connections: Record<string, unknown>[] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { connections?: unknown };
    if (!Array.isArray(parsed.connections)) return false;
    document = { connections: parsed.connections as Record<string, unknown>[] };
  } catch {
    return false;
  }

  const entry = document.connections.find(c => c['name'] === name);
  if (!entry) return false;

  if (typeof entry['options'] === 'object' && entry['options'] !== null
      && option in (entry['options'] as Record<string, unknown>)) {
    (entry['options'] as Record<string, unknown>)[option] = value;
  } else {
    entry[option] = value;
  }

  fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
  return true;
}

async function pickProvider(providers: readonly ProviderInfo[]): Promise<ProviderInfo | undefined> {
  const picked = await vscode.window.showQuickPick(
    providers.map(provider => ({
      label: provider.displayName,
      description: provider.id,
      detail: summarise(provider),
      provider,
    })),
    { placeHolder: 'What are you connecting to?' },
  );
  return picked?.provider;
}

function summarise(provider: ProviderInfo): string {
  const parts = [`limit: ${provider.capabilities.limit}`];
  if (provider.capabilities.browse) parts.push('schema tree');
  if (provider.capabilities.validate) parts.push('live syntax checking');
  if (provider.capabilities.cancel !== 'none') parts.push(`cancel: ${provider.capabilities.cancel}`);
  return parts.join(' · ');
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

/**
 * Add one entry to a connections file, creating it if necessary.
 *
 * Deliberately not a rewrite of the file: people put comments and ordering in
 * these by hand, and a wizard that reformats someone's config is a wizard they
 * stop using.
 */
function append(file: string, connection: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  let document: { connections: unknown[] } = { connections: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { connections?: unknown };
    if (Array.isArray(parsed.connections)) document = { connections: parsed.connections };
  } catch {
    /* a new or unreadable file starts empty; the daemon reports unreadable ones */
  }

  document.connections.push(connection);
  fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
}
