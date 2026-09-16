/**
 * Row-limit rewriting.
 *
 * Only ever applied to statements that read; never to DDL or DML. The rewrite
 * is dialect-aware through `LimitSyntax` rather than assuming `LIMIT n`, which
 * the old code did unconditionally.
 */

import type { LimitSyntax } from '../capabilities';
import { scanSql } from './scan';

/** Text with comments, string literals and parenthesised groups blanked out. */
export function topLevelOnly(sql: string): string {
  let out = '';
  for (const ev of scanSql(sql)) {
    out += ev.region === 'code' && ev.depth === 0 && ev.char !== '(' && ev.char !== ')' ? ev.char : ' ';
  }
  return out;
}

export function isReadStatement(sql: string): boolean {
  return /^\s*(select|with|show|describe|desc|explain)\b/i.test(sql);
}

/** True when the statement already limits its own rows at the top level. */
export function hasRowLimit(sql: string): boolean {
  const top = topLevelOnly(sql);
  return /\blimit\b/i.test(top) || /\bfetch\s+first\b/i.test(top) || /\btop\s+\d+/i.test(top);
}

/**
 * Append a row limit to a read statement that lacks one.
 *
 * Returns the statement unchanged when the limit is off, when the statement
 * writes, when it already limits itself, or when the dialect has no limit
 * clause to append.
 */
export function applyRowLimit(sql: string, limit: number, syntax: LimitSyntax): string {
  if (!Number.isFinite(limit) || limit <= 0) return sql;
  if (syntax === 'none') return sql;
  if (!/^\s*(select|with)\b/i.test(sql)) return sql;
  if (hasRowLimit(sql)) return sql;
  const body = sql.trimEnd().replace(/;\s*$/, '');
  return syntax === 'limit'
    ? `${body} LIMIT ${limit}`
    : `${body} FETCH FIRST ${limit} ROWS ONLY`;
}
