/**
 * Shared lexical scanning for SQL text.
 *
 * Splitting statements and finding a top-level `LIMIT` are the same problem
 * seen twice: walk the text while knowing what is a string, an identifier, a
 * comment or a nested group. The old codebase implemented that walk twice, in
 * `splitSql` and in `topLevelMasked`, and the two drifted (one handled
 * backslash escapes, the other handled parentheses). One scanner now serves
 * both.
 */

export type Region = 'code' | 'line-comment' | 'block-comment' | 'quoted';

export interface ScanEvent {
  /** Offset of the character being reported. */
  readonly at: number;
  readonly region: Region;
  /** Parenthesis nesting depth in code regions; 0 at the top level. */
  readonly depth: number;
  readonly char: string;
}

/**
 * Walk `text`, reporting each character with the region it belongs to.
 *
 * Handles: `'...'` and `"..."` with doubled-quote escapes, backticks (no
 * backslash escapes, per MySQL), backslash escapes inside quotes, `-- line`
 * comments and block comments.
 */
export function* scanSql(text: string): Generator<ScanEvent, void, void> {
  const n = text.length;
  let depth = 0;
  let i = 0;

  while (i < n) {
    const c = text[i]!;
    const c2 = text[i + 1];

    if (c === '-' && c2 === '-') {
      while (i < n && text[i] !== '\n') {
        yield { at: i, region: 'line-comment', depth, char: text[i]! };
        i++;
      }
      continue;
    }

    if (c === '/' && c2 === '*') {
      const start = i;
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i = Math.min(i + 2, n);
      for (let k = start; k < i; k++) yield { at: k, region: 'block-comment', depth, char: text[k]! };
      continue;
    }

    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      const start = i;
      i++;
      while (i < n) {
        if (text[i] === quote) {
          if (text[i + 1] === quote) { i += 2; continue; }  // '' escape
          i++;
          break;
        }
        // Backslash escapes apply inside quotes but not inside backticks.
        if (text[i] === '\\' && quote !== '`') { i += 2; continue; }
        i++;
      }
      i = Math.min(i, n);
      for (let k = start; k < i; k++) yield { at: k, region: 'quoted', depth, char: text[k]! };
      continue;
    }

    if (c === '(') depth++;
    yield { at: i, region: 'code', depth, char: c };
    if (c === ')') depth = Math.max(0, depth - 1);
    i++;
  }
}
