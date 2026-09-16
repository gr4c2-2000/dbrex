import { describe, expect, it } from 'vitest';
import type { Column } from '@dbrex/core';
import { defaultFormat, isFormat, render } from '../src/format';

function columns(...names: string[]): Column[] {
  return names.map(name => ({ name, type: 'text' }));
}

/** Render and split, so a test asserts on lines rather than on one long string. */
function lines(cols: Column[], rows: readonly (readonly unknown[])[], format = 'table', width?: number) {
  const options = { format: format as never, ...(width === undefined ? {} : { width }) };
  return render(cols, rows, options).split('\n').slice(0, -1);
}

describe('table', () => {
  it('pads every column to its widest value', () => {
    expect(lines(columns('day', 'kind'), [['2026-09-16', 'click'], ['2026-09-15', 'view']]))
      .toEqual([
        'day         kind',
        '----------  -----',
        '2026-09-16  click',
        '2026-09-15  view',
      ]);
  });

  it('right-aligns numbers so the digits line up', () => {
    expect(lines(columns('hits'), [[84210], [102993], [7]])).toEqual([
      '  hits',
      '------',
      ' 84210',
      '102993',
      '     7',
    ]);
  });

  it('right-aligns numeric strings too, because a driver may return them', () => {
    expect(lines(columns('n'), [['10'], ['9']])).toEqual([
      ' n',
      '--',
      '10',
      ' 9',
    ]);
  });

  it('left-aligns a column that mixes numbers and words', () => {
    expect(lines(columns('v'), [[1], ['x']])).toEqual([
      'v',
      '-',
      '1',
      'x',
    ]);
  });

  it('left-aligns a column that is entirely null', () => {
    expect(lines(columns('v'), [[null], [null]])).toEqual([
      'v',
      '----',
      'NULL',
      'NULL',
    ]);
  });

  it('shows a null as NULL', () => {
    expect(lines(columns('a'), [[null]])).toContain('NULL');
  });

  it('renders an object as JSON rather than [object Object]', () => {
    expect(lines(columns('payload'), [[{ a: 1 }]])).toContain('{"a":1}');
  });

  it('renders a bigint, which JSON.stringify alone would throw on', () => {
    expect(lines(columns('n'), [[10n]])).toContain('10');
  });

  it('returns nothing at all when there are no columns', () => {
    expect(render([], [], { format: 'table' })).toBe('');
  });

  it('prints the header even when no rows came back', () => {
    expect(lines(columns('day'), [])).toEqual(['day', '---']);
  });
});

describe('table width', () => {
  it('shrinks the widest column first, leaving narrow ones alone', () => {
    const rows = [['2026-09-16', 'x'.repeat(40)]];
    const out = lines(columns('day', 'payload'), rows, 'table', 30);
    expect(out[2]).toHaveLength(30);
    // The date column survives intact; only the payload was cut.
    expect(out[2]).toMatch(/^2026-09-16 {2}x+…$/);
  });

  it('marks a truncated value with an ellipsis, so a cut is never silent', () => {
    const out = lines(columns('v'), [['abcdefghijklmnop']], 'table', 10);
    expect(out[2]).toBe('abcdefghi…');
  });

  it('never drops a column, even when the terminal cannot fit them', () => {
    const cols = columns(...Array.from({ length: 12 }, (_, i) => `c${i}`));
    const out = lines(cols, [cols.map(() => 'value')], 'table', 20);
    for (const c of cols) expect(out[0]).toContain(c.name);
  });

  it('leaves the table unbounded when no width is given', () => {
    const out = lines(columns('v'), [['y'.repeat(50)]]);
    expect(out[2]).toBe('y'.repeat(50));
  });

  it('caps a single column at 60 even with room to spare', () => {
    const out = lines(columns('v'), [['z'.repeat(200)]]);
    expect(out[2]).toHaveLength(60);
  });
});

describe('display width', () => {
  it('counts a wide character as two columns', () => {
    const out = lines(columns('v', 'w'), [['日本', 'x']]);
    expect(out[2]).toBe('日本  x');
    expect(out[0]).toBe('v     w');
  });

  it('counts an emoji as two columns', () => {
    expect(lines(columns('v', 'w'), [['🔥', 'x']])[2]).toBe('🔥  x');
  });
});

describe('vertical', () => {
  it('puts one field per line under a numbered heading', () => {
    expect(lines(columns('day', 'kind'), [['2026-09-16', 'click']], 'vertical')).toEqual([
      '-[ 1 ]-',
      'day  | 2026-09-16',
      'kind | click',
    ]);
  });

  it('numbers each record', () => {
    const out = lines(columns('a'), [['x'], ['y']], 'vertical');
    expect(out[0]).toContain('[ 1 ]');
    expect(out[2]).toContain('[ 2 ]');
  });

  it('is empty when there are no rows', () => {
    expect(render(columns('a'), [], { format: 'vertical' })).toBe('');
  });
});

describe('json', () => {
  it('emits one object per row with null preserved', () => {
    const out = render(columns('a', 'b'), [[1, null]], { format: 'json' });
    expect(JSON.parse(out)).toEqual([{ a: 1, b: null }]);
  });

  it('suffixes a repeated column name instead of dropping it', () => {
    const out = render(columns('id', 'id'), [[1, 2]], { format: 'json' });
    expect(JSON.parse(out)).toEqual([{ id: 1, id_2: 2 }]);
  });

  it('emits a bigint as a string rather than throwing', () => {
    expect(JSON.parse(render(columns('n'), [[9007199254740993n]], { format: 'json' })))
      .toEqual([{ n: '9007199254740993' }]);
  });

  it('emits an empty array for no rows', () => {
    expect(JSON.parse(render(columns('a'), [], { format: 'json' }))).toEqual([]);
  });
});

describe('csv', () => {
  it('writes a header and one line per row', () => {
    expect(lines(columns('a', 'b'), [[1, 2]], 'csv')).toEqual(['a,b', '1,2']);
  });

  it('quotes a value containing a comma and doubles an inner quote', () => {
    expect(lines(columns('v'), [['x,y'], ['say "hi"']], 'csv'))
      .toEqual(['v', '"x,y"', '"say ""hi"""']);
  });

  it('quotes a value containing a comma or a newline', () => {
    const out = render(columns('v'), [['a\nb']], { format: 'csv' });
    expect(out).toBe('v\n"a\nb"\n');
  });

  it('writes a null as empty, not as the word NULL', () => {
    expect(lines(columns('a', 'b'), [[null, 'NULL']], 'csv')).toEqual(['a,b', ',NULL']);
  });
});

describe('tsv', () => {
  it('separates with tabs', () => {
    expect(lines(columns('a', 'b'), [[1, 2]], 'tsv')).toEqual(['a\tb', '1\t2']);
  });

  it('escapes a tab and a newline, so one row stays one line', () => {
    expect(lines(columns('v'), [['a\tb'], ['c\nd']], 'tsv'))
      .toEqual(['v', 'a\\tb', 'c\\nd']);
  });

  it('escapes a backslash, so the escaping is reversible', () => {
    expect(lines(columns('v'), [['a\\tb']], 'tsv')).toEqual(['v', 'a\\\\tb']);
  });

  it('writes a null as empty', () => {
    expect(lines(columns('a'), [[null]], 'tsv')).toEqual(['a', '']);
  });
});

describe('choosing a format', () => {
  it('draws a table for a terminal and tsv for a pipe', () => {
    expect(defaultFormat(true)).toBe('table');
    expect(defaultFormat(false)).toBe('tsv');
  });

  it('recognises exactly the formats it renders', () => {
    for (const name of ['table', 'json', 'csv', 'tsv', 'vertical']) expect(isFormat(name)).toBe(true);
    expect(isFormat('yaml')).toBe(false);
  });
});

describe('colour', () => {
  it('dims a null so it cannot be read as the string NULL', () => {
    const out = render(columns('a', 'b'), [[null, 'NULL']], { format: 'table', colour: true });
    expect(out).toContain('\x1b[2mNULL\x1b[0m');
    // The real string is left alone.
    expect(out.match(/\x1b\[2m/g)).toHaveLength(1);
  });

  it('emits no escape codes when colour is off', () => {
    expect(render(columns('a'), [[null]], { format: 'table' })).not.toContain('\x1b');
  });
});
