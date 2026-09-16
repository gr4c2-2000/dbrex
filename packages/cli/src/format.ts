/**
 * Rendering a result set for a terminal, a pipe, or another program.
 *
 * The old renderer did one thing: pad every cell to the widest value and print
 * it. That is fine until a `payload` column is four kilobytes of JSON, or the
 * result has thirty columns, or someone pipes it into `jq`. So there are two
 * rules here that the old one did not have:
 *
 * - The table never exceeds the terminal, and never silently drops a column to
 *   get there. A dropped column reads as "the query returned no such column",
 *   which is a lie a data tool cannot afford. It shrinks the widest columns
 *   instead and marks what it cut with an ellipsis.
 * - A result that is not going to a terminal defaults to TSV, because the next
 *   thing in the pipe is a program, and box drawing is not data.
 */

import type { Column } from '@dbrex/core';

export const FORMATS = ['table', 'json', 'csv', 'tsv', 'vertical'] as const;
export type Format = (typeof FORMATS)[number];

export function isFormat(value: string): value is Format {
  return (FORMATS as readonly string[]).includes(value);
}

export interface RenderOptions {
  readonly format: Format;
  /** Columns available to the table. Absent means no limit. */
  readonly width?: number;
  /** Dim `NULL` so it cannot be confused with the string "NULL". */
  readonly colour?: boolean;
}

/** Longest a single column may be before it starts to crowd the others out. */
const MAX_COLUMN = 60;
/** Shrinking stops here; below this a column shows nothing useful. */
const MIN_COLUMN = 8;
/** Spaces between columns in a table. */
const GAP = 2;

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

type Rows = readonly (readonly unknown[])[];

export function render(columns: readonly Column[], rows: Rows, options: RenderOptions): string {
  switch (options.format) {
    case 'table': return table(columns, rows, options);
    case 'vertical': return vertical(columns, rows, options);
    case 'json': return json(columns, rows);
    case 'csv': return separated(columns, rows, csvCell, ',');
    case 'tsv': return separated(columns, rows, tsvCell, '\t');
  }
}

/** What a format is called when nobody chose one. A pipe wants data, not a frame. */
export function defaultFormat(isTty: boolean): Format {
  return isTty ? 'table' : 'tsv';
}

function table(columns: readonly Column[], rows: Rows, options: RenderOptions): string {
  if (columns.length === 0) return '';

  const cells = rows.map(row => columns.map((_, i) => text(row[i])));
  const widths = fit(columns.map((c, i) => natural(c.name, cells, i)), options.width, columns.length);
  const right = columns.map((_, i) => numeric(rows, i));

  const out: string[] = [];
  out.push(row(columns.map((c, c2) => clip(c.name, widths[c2] ?? 0)), widths, right));
  out.push(widths.map(w => '-'.repeat(w)).join(' '.repeat(GAP)));
  for (const [r, cell] of cells.entries()) {
    out.push(row(
      cell.map((value, c) => paint(clip(value, widths[c] ?? 0), rows[r]?.[c], options)),
      widths,
      right,
    ));
  }
  return `${out.join('\n')}\n`;
}

/**
 * One record per block, one field per line.
 *
 * For a result that is wide rather than long — a single row of forty columns,
 * which a table renders as an unreadable smear regardless of how it is sized.
 */
function vertical(columns: readonly Column[], rows: Rows, options: RenderOptions): string {
  if (columns.length === 0) return '';
  const label = Math.max(...columns.map(c => width(c.name)));

  const out: string[] = [];
  for (const [r, values] of rows.entries()) {
    const heading = `-[ ${r + 1} ]`;
    out.push(`${heading}${'-'.repeat(Math.max(0, label + 3 - width(heading)))}`);
    for (const [c, column] of columns.entries()) {
      out.push(`${pad(column.name, label, false)} | ${paint(text(values[c]), values[c], options)}`);
    }
  }
  return out.length === 0 ? '' : `${out.join('\n')}\n`;
}

/**
 * Objects, so a consumer can address fields by name.
 *
 * SQL permits two columns with one name and JSON objects do not, so a repeat
 * gets a numeric suffix. Renaming the second `id` to `id_2` loses less than
 * dropping it.
 */
function json(columns: readonly Column[], rows: Rows): string {
  const names = unique(columns.map(c => c.name));
  const records = rows.map(row => Object.fromEntries(
    names.map((name, i) => [name, row[i] === undefined ? null : row[i]]),
  ));
  return `${JSON.stringify(records, replacer, 2)}\n`;
}

function separated(
  columns: readonly Column[],
  rows: Rows,
  escape: (value: string) => string,
  sep: string,
): string {
  const out = [columns.map(c => escape(c.name)).join(sep)];
  for (const row of rows) {
    // Empty, not "NULL": a null and the string "NULL" must not arrive at the
    // next program looking the same.
    out.push(columns.map((_, i) => (nullish(row[i]) ? '' : escape(text(row[i])))).join(sep));
  }
  return `${out.join('\n')}\n`;
}

/* ---------- widths ---------- */

function natural(name: string, cells: readonly (readonly string[])[], column: number): number {
  let widest = width(name);
  for (const row of cells) widest = Math.max(widest, width(row[column] ?? ''));
  return Math.min(MAX_COLUMN, widest);
}

/**
 * Shrink the widest columns until the row fits.
 *
 * Widest-first keeps a `payload` column from crushing a `day` column that was
 * already the right size. When everything has reached `MIN_COLUMN` and it still
 * does not fit, the row is returned too wide and the terminal wraps it — that
 * is visibly broken, which is the honest outcome, unlike a column that silently
 * disappeared.
 */
function fit(widths: number[], available: number | undefined, columns: number): number[] {
  if (available === undefined) return widths;
  const gaps = GAP * Math.max(0, columns - 1);

  let total = widths.reduce((sum, w) => sum + w, 0) + gaps;
  while (total > available) {
    const widest = widths.reduce((best, w, i) => (w > (widths[best] ?? 0) ? i : best), 0);
    if ((widths[widest] ?? 0) <= MIN_COLUMN) break;
    widths[widest] = (widths[widest] ?? 0) - 1;
    total -= 1;
  }
  return widths;
}

function row(values: readonly string[], widths: readonly number[], right: readonly boolean[]): string {
  return values
    .map((v, i) => pad(v, widths[i] ?? 0, right[i] ?? false))
    .join(' '.repeat(GAP))
    .trimEnd();
}

/**
 * Right-align a column only when every value in it is a number.
 *
 * Decided from the values rather than the engine's declared type, because the
 * type name for an integer is `int` on one engine, `Int64` on another and
 * `NUMBER(38,0)` on a third, and a column of numeric strings should still line
 * up on its digits.
 */
function numeric(rows: Rows, column: number): boolean {
  let seen = false;
  for (const row of rows) {
    const value = row[column];
    if (nullish(value)) continue;
    seen = true;
    if (typeof value === 'number' || typeof value === 'bigint') continue;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) continue;
    return false;
  }
  return seen;
}

/* ---------- cells ---------- */

function text(value: unknown): string {
  if (nullish(value)) return 'NULL';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value, replacer) ?? String(value);
  return String(value);
}

function paint(rendered: string, value: unknown, options: RenderOptions): string {
  return options.colour === true && nullish(value) ? `${DIM}${rendered}${RESET}` : rendered;
}

function nullish(value: unknown): boolean {
  return value === null || value === undefined;
}

/** `JSON.stringify` throws on a bigint; a row of them should still print. */
function replacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** One row per line is the whole contract of TSV, so a newline inside one escapes. */
function tsvCell(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\r?\n/g, '\\n');
}

function unique(names: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return names.map(name => {
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    return count === 1 ? name : `${name}_${count}`;
  });
}

/* ---------- display width ---------- */

function pad(value: string, to: number, right: boolean): string {
  const fill = ' '.repeat(Math.max(0, to - width(value)));
  return right ? `${fill}${value}` : `${value}${fill}`;
}

function clip(value: string, to: number): string {
  if (width(value) <= to) return value;
  let out = '';
  for (const ch of value) {
    if (width(out) + charWidth(ch) > to - 1) break;
    out += ch;
  }
  return `${out}…`;
}

function width(value: string): number {
  let total = 0;
  for (const ch of value) total += charWidth(ch);
  return total;
}

/**
 * Columns one character occupies.
 *
 * Enough to keep a table of CJK or emoji aligned; not a full `wcwidth`. Zero
 * for combining marks, two for the wide ranges, one for everything else.
 */
function charWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  if (code >= 0x0300 && code <= 0x036f) return 0;
  if (code >= 0x1100 && (
    code <= 0x115f
    || (code >= 0x2e80 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x1f300 && code <= 0x1f64f)
    || (code >= 0x1f900 && code <= 0x1f9ff)
    || (code >= 0x20000 && code <= 0x3fffd)
  )) return 2;
  return 1;
}
