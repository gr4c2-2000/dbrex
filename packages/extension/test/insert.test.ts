import { describe, expect, it } from 'vitest';
import { placeBlock } from '../src/insert';

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
