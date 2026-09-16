/**
 * Placing a block of SQL into a file.
 *
 * A `-- @conn` directive only counts at the start of a line — deliberately, or
 * a trailing comment after a statement could hijack which database the next one
 * runs on. That makes *where* a block lands part of its meaning: pasted after
 * something else on the same line, the directive silently stops existing, the
 * statement runs on whatever connection the window had selected, and the error
 * comes back from the wrong engine.
 */

export interface Placement {
  /** Text to insert, padded so every line of it starts a line. */
  readonly text: string;
}

/**
 * Pad a block so it occupies whole lines.
 *
 * `column` is where the insertion starts; `restOfLine` is what already follows
 * it on that line. Nothing is trimmed and nothing is reordered — the caller's
 * text only gains the newlines it needs to keep its own first line first.
 */
export function placeBlock(text: string, column: number, restOfLine: string): Placement {
  const needsLeading = column > 0;
  const needsTrailing = restOfLine.trim().length > 0;
  return {
    text: `${needsLeading ? '\n' : ''}${text}${needsTrailing ? '\n' : ''}`,
  };
}
