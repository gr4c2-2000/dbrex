/**
 * Placing a block of SQL into a file.
 *
 * A `-- @conn` directive only counts at the start of a line — deliberately, or
 * a trailing comment after a statement could hijack which database the next one
 * runs on. That makes *where* a block lands part of its meaning: pasted after
 * something else on the same line, the directive silently stops existing, the
 * statement runs on whatever connection the window had selected, and the error
 * comes back from the wrong engine.
 *
 * Starting a line is necessary and was once assumed to be sufficient. It is
 * not. Statements are separated by `;` and by nothing else, so a block dropped
 * below an unterminated statement is absorbed into it however many newlines
 * precede it — and a directive in the middle of a statement is as inert as one
 * in the middle of a line. The block therefore closes what it lands after.
 */

import { endsOpenStatement } from '@dbrex/core';

export interface Placement {
  /** Text to insert, padded so every line of it starts a line. */
  readonly text: string;
  /** Set when a `;` was added to close the statement this landed after. */
  readonly terminated: boolean;
}

/**
 * Pad a block so it occupies whole lines, and so it begins a statement.
 *
 * `column` is where the insertion starts, `restOfLine` is what already follows
 * it on that line, and `before` is everything in the document up to the
 * insertion point. Nothing is trimmed and nothing is reordered — the caller's
 * text only gains the separators it needs to mean what it says.
 *
 * The `;` is the one character this adds to someone else's SQL. It is added
 * only where the text was already mid-statement, where the alternative is that
 * their statement quietly eats this block and runs it on the wrong database.
 */
export function placeBlock(
  text: string,
  column: number,
  restOfLine: string,
  before = '',
): Placement {
  const needsTerminator = endsOpenStatement(before);
  const needsTrailing = restOfLine.trim().length > 0;
  // A terminator brings its own line break, so it stands in for the padding.
  const lead = needsTerminator ? ';\n' : column > 0 ? '\n' : '';
  return {
    text: `${lead}${text}${needsTrailing ? '\n' : ''}`,
    terminated: needsTerminator,
  };
}
