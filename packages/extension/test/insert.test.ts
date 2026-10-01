import { describe, expect, it } from 'vitest';
import { placeBlock } from '../src/insert';
import { configAt, splitSql } from '@dbrex/core';

const block = "-- @conn: sigma s3\nSELECT * FROM read_json_auto('s3://b/k.json') LIMIT 100";

describe('placeBlock', () => {
  it('leaves a block alone at the start of an empty line', () => {
    expect(placeBlock(block, 0, '').text).toBe(block);
  });

  it('breaks the line first when the cursor sits after other text', () => {
    // Without this the `-- @conn` lands mid-line, stops being a directive, and
    // the statement runs on whichever connection the window had selected — a
    // DuckDB function arriving at ClickHouse, with ClickHouse's error to match.
    expect(placeBlock(block, 12, '').text).toBe(`\n${block}`);
  });

  it('breaks the line after the block when something follows on it', () => {
    expect(placeBlock(block, 0, 'SELECT 1;').text).toBe(`${block}\n`);
  });

  it('breaks on both sides when the cursor is inside a line of text', () => {
    expect(placeBlock(block, 5, ' AND x').text).toBe(`\n${block}\n`);
  });

  it('ignores trailing whitespace when deciding if anything follows', () => {
    expect(placeBlock(block, 0, '   ').text).toBe(block);
  });
});

describe('placeBlock closing an open statement', () => {
  const block = '-- @conn: commonAZ\nSELECT *\nFROM "topic"\nLIMIT 100';

  it('closes a statement the block would otherwise be absorbed into', () => {
    const before = 'SELECT id\nFROM users\nWHERE id = 1\n\n';
    const { text, terminated } = placeBlock(block, 0, '', before);
    expect(terminated).toBe(true);
    expect(text).toBe(`;\n${block}`);
  });

  it('leaves a terminated statement alone', () => {
    const { text, terminated } = placeBlock(block, 0, '', 'SELECT 1;\n\n');
    expect(terminated).toBe(false);
    expect(text).toBe(block);
  });

  it('adds nothing to an empty file', () => {
    const { text, terminated } = placeBlock(block, 0, '', '');
    expect(terminated).toBe(false);
    expect(text).toBe(block);
  });

  it('does not treat a leading comment as something to close', () => {
    const { terminated } = placeBlock(block, 0, '', '-- scratch file\n');
    expect(terminated).toBe(false);
  });

  it('uses the terminator as the line break when landing mid-line', () => {
    const { text } = placeBlock(block, 15, '', 'SELECT 1 FROM x');
    expect(text).toBe(`;\n${block}`);
  });

  it('still breaks the line when there is nothing to close', () => {
    const { text } = placeBlock(block, 5, '', '-- abc');
    expect(text).toBe(`\n${block}`);
  });

  it('keeps padding the end when text follows on the line', () => {
    const { text } = placeBlock(block, 0, 'SELECT 2;', 'SELECT 1');
    expect(text).toBe(`;\n${block}\n`);
  });

  /** The whole point: what comes out has to split into separate statements. */
  it('produces a file the splitter separates', () => {
    const before = 'SELECT id FROM users WHERE id = 1';
    const { text } = placeBlock(block, before.length, '', before);
    const statements = splitSql(before + text);
    expect(statements).toHaveLength(2);
    expect(configAt(before + text, statements[1]!.codeStart).connection).toBe('commonAZ');
  });
});
