/**
 * What the text around a cursor is asking the schema for.
 *
 * This is the half of completion that needs no editor and no connection: given
 * the text and where the cursor sits, decide which `browse` call would answer.
 * Resolving that call, caching it and rendering the candidates belong to
 * whoever is asking — the extension builds `CompletionItem`s, the terminal
 * client feeds readline a string array.
 *
 * Keeping the decision here is what stops the two from drifting. The rules are
 * small but they are not obvious, and a second copy would answer `FROM` and a
 * trailing dot slightly differently within a month.
 */

import type { BrowseNode } from '../provider';
import { splitSql, statementAt } from './split';

/** A `browse` path to list, and why it was asked for. */
export type CompletionRequest =
  /** After a trailing dot: exactly the children of this path. */
  | { readonly kind: 'children'; readonly path: readonly string[] }
  /** After `FROM`, `JOIN`, `INTO`, `UPDATE`, `TABLE`: the top of the tree. */
  | { readonly kind: 'roots' }
  /** Anywhere else in a statement: the columns of the tables it names. */
  | { readonly kind: 'columns'; readonly tables: readonly string[] };

/** A dotted identifier ending at the cursor, with the dot. */
const QUALIFIED = /([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)*)\.$/;
/** A clause that is about to name a relation. */
const NAMING = /\b(?:from|join|into|update|table)\s+[\w$]*$/i;
/** Relations the statement already names. */
const RELATIONS = /\b(?:from|join)\s+([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)*)/gi;

/**
 * Tables consulted for column candidates.
 *
 * A join of twenty tables is a statement nobody is completing their way
 * through, and each name costs a round trip.
 */
const MAX_RELATIONS = 4;

/**
 * Decide what to list for a cursor at `offset` in `text`.
 *
 * Returns `undefined` when the cursor is not inside a statement at all, which
 * is the caller's signal to offer nothing rather than to offer everything.
 */
export function completionAt(text: string, offset: number): CompletionRequest | undefined {
  const line = lineUpTo(text, offset);

  const qualified = QUALIFIED.exec(line);
  if (qualified) return { kind: 'children', path: qualified[1]!.split('.') };

  if (NAMING.test(line)) return { kind: 'roots' };

  const statement = statementAt(splitSql(text), offset);
  if (statement === undefined) return undefined;

  const tables = [...statement.sql.matchAll(RELATIONS)]
    .map(match => match[1]!)
    .slice(0, MAX_RELATIONS);
  return tables.length === 0 ? undefined : { kind: 'columns', tables };
}

/**
 * The identifier fragment the cursor sits at the end of.
 *
 * An editor filters the candidate list against the document itself; readline
 * does not, so the terminal client has to know what the user has typed so far.
 * A trailing dot yields `''`: everything below that path is a candidate.
 */
export function prefixAt(text: string, offset: number): string {
  return /([A-Za-z_][\w$]*)$/.exec(lineUpTo(text, offset))?.[1] ?? '';
}

function lineUpTo(text: string, offset: number): string {
  const at = Math.max(0, Math.min(offset, text.length));
  return text.slice(text.lastIndexOf('\n', at - 1) + 1, at);
}

/**
 * Children of a browse path. Whoever supplies this owns the caching and the
 * connection; a failure is theirs to swallow into an empty list.
 */
export type ChildrenSource = (path: readonly string[]) => Promise<readonly BrowseNode[]>;

/** Resolve a request into the nodes to offer. */
export async function completionNodes(
  request: CompletionRequest,
  children: ChildrenSource,
): Promise<readonly BrowseNode[]> {
  switch (request.kind) {
    case 'children':
      return children(request.path);
    case 'roots':
      return children([]);
    case 'columns':
      return columnsOf(request.tables, children);
  }
}

async function columnsOf(
  tables: readonly string[],
  children: ChildrenSource,
): Promise<readonly BrowseNode[]> {
  const out: BrowseNode[] = [];
  for (const name of tables) {
    const path = name.split('.');
    out.push(...(path.length === 1 ? await unqualified(name, children) : await children(path)));
  }
  return out.filter(node => node.kind === 'column');
}

/**
 * Columns of a table named without its database.
 *
 * We do not know which database the session is in, so ask each root for a table
 * of this name and take the first that has one. Guessing the first root instead
 * would silently complete the wrong table's columns.
 */
async function unqualified(name: string, children: ChildrenSource): Promise<readonly BrowseNode[]> {
  for (const root of await children([])) {
    const tables = await children([root.name]);
    if (tables.some(table => table.name === name)) return children([root.name, name]);
  }
  return [];
}
