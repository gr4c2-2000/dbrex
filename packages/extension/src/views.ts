/**
 * Custom views that sit next to a `.sql` file.
 *
 *   queries/sales.sql
 *   queries/sales.chart.js          -> one view called "chart"
 *   queries/sales.view.weekly.js    -> a view called "weekly"
 *   queries/sales.config.json       -> optional: labels, order, default, css
 *
 * Convention over configuration, kept from the old design because it is
 * genuinely good: the diagram lives next to the query it draws and travels with
 * it in git.
 *
 * What changed is where the code runs — a sandboxed frame rather than the panel
 * document — and that every path in the manifest is resolved *inside* the
 * query's own directory. The old loader let a manifest point a view at an
 * absolute path, or at `~/anything`, which turned "open this .sql file" into
 * "run this arbitrary file from my disk".
 */

import * as path from 'node:path';
import type { ViewDefinition } from './webviewProtocol';

export interface FileReader {
  list(directory: string): Promise<string[]>;
  read(file: string): Promise<string>;
}

/** `<base>.config.json`, as far as we are willing to trust it. */
export interface ViewManifest {
  readonly views?: readonly { readonly name: string; readonly file: string; readonly label?: string }[];
  readonly defaultView?: string;
  /** Stylesheet applied inside the sandboxed frame, relative to the query. */
  readonly css?: string;
}

export interface LoadedViews {
  readonly views: readonly ViewDefinition[];
  /** Name of the view to open first, when the manifest asks for one. */
  readonly defaultView?: string;
}

/** Parse a sibling file name into a view name, or undefined if it is not one. */
export function viewNameFor(sqlBase: string, fileName: string): string | undefined {
  if (fileName === `${sqlBase}.chart.js`) return 'chart';
  const prefix = `${sqlBase}.view.`;
  if (fileName.startsWith(prefix) && fileName.endsWith('.js')) {
    const name = fileName.slice(prefix.length, -'.js'.length);
    return name.length > 0 ? name : undefined;
  }
  return undefined;
}

/**
 * Resolve a manifest path against the query's directory, refusing anything that
 * escapes it.
 *
 * Returns undefined for an absolute path, a `~` path, or any amount of `..`
 * that climbs out. A `.sql` file arriving from a repository or a colleague must
 * not be able to name a file elsewhere on the machine.
 */
export function resolveWithin(directory: string, candidate: string): string | undefined {
  if (candidate.length === 0) return undefined;
  if (path.isAbsolute(candidate) || candidate.startsWith('~')) return undefined;
  const resolved = path.resolve(directory, candidate);
  const base = path.resolve(directory);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return undefined;
  return resolved;
}

/** True when saving `savedPath` should redraw the views of `sqlPath`. */
export function isViewFileFor(sqlPath: string, savedPath: string): boolean {
  if (path.dirname(sqlPath) !== path.dirname(savedPath)) return false;
  const base = path.basename(sqlPath, path.extname(sqlPath));
  const saved = path.basename(savedPath);
  return saved === `${base}.config.json` || viewNameFor(base, saved) !== undefined;
}

export async function loadViews(sqlPath: string, reader: FileReader): Promise<LoadedViews> {
  const directory = path.dirname(sqlPath);
  const base = path.basename(sqlPath, path.extname(sqlPath));

  let names: string[];
  try {
    names = await reader.list(directory);
  } catch {
    return { views: [] };
  }

  const manifest = await readManifest(directory, base, names, reader);
  const views: ViewDefinition[] = [];

  // Manifest entries come first and in their own order: choosing the order of
  // the tabs is most of the reason to write one.
  for (const entry of manifest?.views ?? []) {
    const file = resolveWithin(directory, entry.file);
    if (file === undefined) continue;
    const code = await readOrSkip(reader, file);
    if (code === undefined) continue;
    views.push({ name: entry.name, label: entry.label ?? labelFor(entry.name), code });
  }

  for (const fileName of names.sort()) {
    const name = viewNameFor(base, fileName);
    if (name === undefined || views.some(view => view.name === name)) continue;
    const code = await readOrSkip(reader, path.join(directory, fileName));
    if (code === undefined) continue;
    views.push({ name, label: labelFor(name), code });
  }

  const css = manifest?.css === undefined ? undefined : resolveWithin(directory, manifest.css);
  const style = css === undefined ? undefined : await readOrSkip(reader, css);
  const withStyle = style === undefined
    ? views
    : views.map(view => ({ ...view, css: style }));

  const defaultView = manifest?.defaultView !== undefined
    && withStyle.some(view => view.name === manifest.defaultView)
    ? manifest.defaultView
    : undefined;

  return {
    views: withStyle,
    ...(defaultView === undefined ? {} : { defaultView }),
  };
}

async function readManifest(
  directory: string,
  base: string,
  names: readonly string[],
  reader: FileReader,
): Promise<ViewManifest | undefined> {
  const fileName = `${base}.config.json`;
  if (!names.includes(fileName)) return undefined;
  try {
    const parsed = JSON.parse(await reader.read(path.join(directory, fileName))) as ViewManifest;
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    // A broken manifest falls back to the naming convention rather than hiding
    // every view the query has.
    return undefined;
  }
}

async function readOrSkip(reader: FileReader, file: string): Promise<string | undefined> {
  try {
    return await reader.read(file);
  } catch {
    return undefined;
  }
}

function labelFor(name: string): string {
  const spaced = name.replace(/[-_]+/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
