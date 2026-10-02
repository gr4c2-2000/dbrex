/**
 * Editing a connections file.
 *
 * Split out from the wizard and free of `vscode`, so the three operations that
 * touch a file somebody wrote by hand can be tested. Removing an entry is the
 * one that made this worth doing: everything else here adds or changes a value,
 * and that one deletes.
 *
 * None of these rewrites the file wholesale beyond what it must. People put
 * ordering and intent into these by hand, and a wizard that reformats someone's
 * config is a wizard they stop using.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

interface Document {
  connections: Record<string, unknown>[];
}

/**
 * Read a connections file, or `undefined` when it is not one.
 *
 * An unreadable or malformed file is not an empty one. Treating it as empty is
 * how an edit silently discards somebody's connections; the caller has to
 * decide, and for a removal the decision is to refuse.
 */
export function readConnections(file: string): Document | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { connections?: unknown };
    return Array.isArray(parsed.connections)
      ? { connections: parsed.connections as Record<string, unknown>[] }
      : undefined;
  } catch {
    return undefined;
  }
}

function write(file: string, document: Document): void {
  fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
}

/** Add one entry, creating the file if it does not exist yet. */
export function appendConnection(file: string, connection: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // A file that does not parse starts empty here on purpose: this is the create
  // path, and the daemon reports an unreadable file separately.
  const document = readConnections(file) ?? { connections: [] };
  document.connections.push(connection);
  write(file, document);
}

/**
 * Change one option of one entry.
 *
 * An option declared at the top level of the entry stays there, and one inside
 * an `options` block stays inside it: both spellings are accepted by the daemon
 * and moving someone's key between them is an edit they did not ask for.
 */
export function updateConnection(
  file: string,
  name: string,
  option: string,
  value: unknown,
): boolean {
  const document = readConnections(file);
  if (document === undefined) return false;

  const entry = document.connections.find(c => c['name'] === name);
  if (entry === undefined) return false;

  const options = entry['options'];
  if (typeof options === 'object' && options !== null && option in (options as Record<string, unknown>)) {
    (options as Record<string, unknown>)[option] = value;
  } else {
    entry[option] = value;
  }

  write(file, document);
  return true;
}

/**
 * Remove one entry by name.
 *
 * Returns false and changes nothing when the file cannot be read or holds no
 * such entry — a deletion that cannot find its target must not rewrite the file
 * on the way to discovering that.
 */
export function removeConnectionEntry(file: string, name: string): boolean {
  const document = readConnections(file);
  if (document === undefined) return false;

  const remaining = document.connections.filter(c => c['name'] !== name);
  if (remaining.length === document.connections.length) return false;

  write(file, { connections: remaining });
  return true;
}
