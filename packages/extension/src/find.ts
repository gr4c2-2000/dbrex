/**
 * "Where is the thing called roughly this?"
 *
 * A warehouse has more tables than anyone remembers the database of, and the
 * schema tree only answers that if you already know which node to expand. This
 * searches every connection at once and says which connection and which
 * database each hit lives in — the two things the tree makes you navigate to
 * find out.
 *
 * Matching is VSCode's own, deliberately. A quick pick filters and ranks its
 * items against what is typed and offers no way to turn that off, so a custom
 * matcher here would be overruled on ordering and duplicated on behaviour. The
 * label is the qualified name, which is what makes `anev` reach
 * `analytics.events` and `userid` reach the column inside it.
 *
 * It searches what the tree has already loaded, and says so. Walking every
 * database on every connection instead would be a round trip per node against
 * live servers, which is the cost the browse cache exists to stop paying.
 */

import * as vscode from 'vscode';
import type { BrowseNode } from '@dbrex/core';
import { qualifiedName, type KnownObject, type Schema } from './lsp';

/** Kinds worth offering. A database or a schema is a place, not an answer. */
const SEARCHABLE: readonly BrowseNode['kind'][] = ['table', 'view', 'column', 'object'];

interface Item extends vscode.QuickPickItem {
  readonly found: KnownObject;
}

export function registerFind(
  schema: Schema,
  insert: (text: string) => Promise<void>,
): vscode.Disposable {
  return vscode.commands.registerCommand('dbrex.findInSchema', async () => {
    const known = schema.known().filter(k => SEARCHABLE.includes(k.node.kind));
    if (known.length === 0) {
      void vscode.window.showInformationMessage(
        'DbRex: nothing indexed yet. Expand a connection in the Schema view, then search again.',
      );
      return;
    }

    const items: Item[] = known.map(found => ({
      found,
      label: qualifiedName(found),
      description: `${found.node.kind}  ·  ${found.connection}`,
      ...(found.node.detail === undefined ? {} : { detail: found.node.detail }),
    }));

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: `Search ${items.length} indexed objects — table, view, column`,
      // The kind and the connection are part of what is being searched for:
      // "the events table on staging" is a description match, not a label one.
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (picked === undefined) return;

    // The name, not a whole statement: the cursor is usually already inside a
    // FROM or a SELECT list. The tree's own command inserts a full SELECT.
    await insert(picked.found.node.insert ?? picked.found.node.name);
  });
}
