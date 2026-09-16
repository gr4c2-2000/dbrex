/** Split SQL text into statements, ignoring `;` inside strings and comments. */

import { scanSql } from './scan';

export interface Statement {
  /** The statement with surrounding whitespace trimmed. */
  readonly sql: string;
  /** Offset of `sql[0]` in the source text. */
  readonly start: number;
  /** Offset one past the last character of `sql`. */
  readonly end: number;
  /**
   * Offset of the first character that is actually code.
   *
   * A statement keeps its leading comments, so `start` usually points at a
   * `-- @conn` line rather than at the SQL. Anything asking "which directives
   * apply here" must measure from the code, or the statement's own directives
   * fall on the wrong side of the comparison and are ignored.
   */
  readonly codeStart: number;
}

export function splitSql(text: string): Statement[] {
  const out: Statement[] = [];
  let chunkStart = 0;
  let codeStart: number | undefined;

  const push = (rawEnd: number): void => {
    // A chunk of nothing but comments and whitespace is not a statement. Sending
    // one to an engine gets you a parse error at best.
    if (codeStart !== undefined) {
      const raw = text.slice(chunkStart, rawEnd);
      const leading = raw.length - raw.trimStart().length;
      const sql = raw.trim();
      out.push({
        sql,
        start: chunkStart + leading,
        end: chunkStart + leading + sql.length,
        codeStart,
      });
    }
    chunkStart = rawEnd + 1;  // skip the ';'
    codeStart = undefined;
  };

  for (const ev of scanSql(text)) {
    if (ev.region === 'code' && ev.char === ';') {
      push(ev.at);
      continue;
    }
    if (codeStart === undefined
      && ev.region !== 'line-comment'
      && ev.region !== 'block-comment'
      && !/\s/.test(ev.char)) {
      codeStart = ev.at;
    }
  }
  push(text.length);
  return out;
}

/**
 * The statement the cursor sits in.
 *
 * A cursor in the whitespace between two statements belongs to the one before
 * it — that is what "run the statement I just finished typing" means.
 */
export function statementAt(statements: readonly Statement[], offset: number): Statement | undefined {
  let previous: Statement | undefined;
  for (const s of statements) {
    if (offset >= s.start && offset <= s.end) return s;
    if (s.end < offset) previous = s;
  }
  return previous ?? statements[0];
}
