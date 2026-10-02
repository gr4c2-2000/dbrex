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

/**
 * The statement's first word of actual code.
 *
 * Measured past comments, because a statement keeps its leading ones: a query
 * sitting under `-- @conn: prod` is this tool's own idiom and what the schema
 * tree writes. Testing the raw text instead made every statement carrying a
 * directive look like something that was not a SELECT.
 */
function leadingKeyword(sql: string): string {
  return /^\s*([a-z]+)/i.exec(topLevelOnly(sql))?.[1]?.toLowerCase() ?? '';
}

export function isReadStatement(sql: string): boolean {
  return ['select', 'with', 'show', 'describe', 'desc', 'explain'].includes(leadingKeyword(sql));
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
  // Past the comments: a statement under its own `-- @conn:` directive would
  // otherwise never get a limit, and the engine would be asked for everything.
  if (!['select', 'with'].includes(leadingKeyword(sql))) return sql;
  if (hasRowLimit(sql)) return sql;
  const body = sql.trimEnd().replace(/;\s*$/, '');
  if (syntax === 'top') return applyTop(body, limit);
  return syntax === 'limit'
    ? `${body} LIMIT ${limit}`
    : `${body} FETCH FIRST ${limit} ROWS ONLY`;
}

/** Set operators, past which a `TOP` would bind to one branch instead of the whole. */
const SET_OPERATOR = /\b(?:union|except|intersect)\b/i;

/**
 * `SELECT TOP n`, inserted where T-SQL's grammar puts it.
 *
 * Two things decide the position. `TOP` follows `ALL` or `DISTINCT` rather than
 * preceding it, so `SELECT DISTINCT TOP 10 x` is the legal spelling and
 * `SELECT TOP 10 DISTINCT x` is not. And it belongs to the outermost query: a
 * CTE's own `SELECT` sits inside parentheses, which `topLevelOnly` blanks, so
 * the first one left is the one that returns the rows.
 *
 * A statement with a set operator is returned unchanged. `TOP` would attach to a
 * single branch and quietly limit the wrong thing, and limiting the whole would
 * mean wrapping the statement in a derived table — a rewrite large enough that
 * reading fewer rows client-side is the smaller lie.
 */
function applyTop(sql: string, limit: number): string {
  const top = topLevelOnly(sql);
  if (SET_OPERATOR.test(top)) return sql;

  const select = /\bselect\b/i.exec(top);
  if (select === null) return sql;

  let at = select.index + select[0].length;
  const qualifier = /^\s+(?:all|distinct)\b/i.exec(top.slice(at));
  if (qualifier !== null) at += qualifier[0].length;

  // Offsets from `topLevelOnly` address the original text: it replaces each
  // character it hides with a space, so the two stay the same length.
  return `${sql.slice(0, at)} TOP ${limit}${sql.slice(at)}`;
}
