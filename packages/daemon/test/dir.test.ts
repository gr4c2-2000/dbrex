import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DIR_CAPABILITIES,
  confinementSql,
  dirProvider,
  extensionOf,
  fileIndexSql,
  includeMatcher,
  levelNodes,
  quote,
  readTemplate,
  walkDirectory,
  type IndexedFile,
} from '../src/providers/dir';

let root: string;

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'dbrex-dir-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function put(relative: string, body = 'a,b\n1,2\n'): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

const walk = (over: Partial<Parameters<typeof walkDirectory>[1]> = {}) =>
  walkDirectory(root, { recursive: true, maxFiles: 1_000, ...over });

const relatives = (over = {}) => walk(over).files.map(f => f.relative);

describe('walking a directory', () => {
  it('finds files at the top level', () => {
    put('a.csv');
    put('b.csv');
    expect(relatives()).toEqual(['a.csv', 'b.csv']);
  });

  it('descends into subdirectories', () => {
    put('top.csv');
    put('sub/deep/nested.parquet');
    expect(relatives()).toEqual(['sub/deep/nested.parquet', 'top.csv']);
  });

  it('stays at the top level when told not to descend', () => {
    put('top.csv');
    put('sub/nested.csv');
    expect(relatives({ recursive: false })).toEqual(['top.csv']);
  });

  it('uses forward slashes, so a path reads the same on every platform', () => {
    put('sub/nested.csv');
    expect(relatives()[0]).toBe('sub/nested.csv');
  });

  it('records a size and a modification time', () => {
    put('a.csv', 'hello');
    const [file] = walk().files;
    expect(file?.size).toBe(5);
    expect(file?.modified).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('sorts by path, so the tree and the index agree on order', () => {
    put('z.csv');
    put('a.csv');
    put('m/b.csv');
    expect(relatives()).toEqual(['a.csv', 'm/b.csv', 'z.csv']);
  });

  it('never follows a symlink out of the root', () => {
    // A link out would make the index describe files the confinement refuses to
    // read, which is a tree that lies about what can be queried.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dbrex-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'private.csv'), 'x');
      fs.symlinkSync(outside, path.join(root, 'escape'));
      put('mine.csv');
      expect(relatives()).toEqual(['mine.csv']);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('stops at maxFiles and says that it did', () => {
    for (let i = 0; i < 10; i++) put(`f${i}.csv`);
    const index = walk({ maxFiles: 4 });
    expect(index.files).toHaveLength(4);
    expect(index.truncated).toBe(true);
  });

  it('does not claim truncation when the walk finished', () => {
    put('a.csv');
    expect(walk({ maxFiles: 10 }).truncated).toBe(false);
  });

  it('survives a directory it cannot read', () => {
    put('fine.csv');
    const locked = path.join(root, 'locked');
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(locked, 'hidden.csv'), 'x');
    fs.chmodSync(locked, 0o000);
    try {
      // One unreadable subtree must not cost the whole index.
      expect(relatives()).toContain('fine.csv');
    } finally {
      fs.chmodSync(locked, 0o700);
    }
  });

  it('returns nothing for an empty directory', () => {
    expect(walk().files).toEqual([]);
  });
});

describe('the include filter', () => {
  it('matches everything when it is empty', () => {
    for (const empty of [undefined, '', '   ']) {
      expect(includeMatcher(empty)('anything.txt')).toBe(true);
    }
  });

  it('matches an extension glob', () => {
    const m = includeMatcher('*.parquet');
    expect(m('data.parquet')).toBe(true);
    expect(m('data.csv')).toBe(false);
  });

  it('matches a single character with ?', () => {
    const m = includeMatcher('part-?.csv');
    expect(m('part-1.csv')).toBe(true);
    expect(m('part-12.csv')).toBe(false);
  });

  it('ignores case, because file systems differ about it', () => {
    expect(includeMatcher('*.PARQUET')('data.parquet')).toBe(true);
  });

  it('treats a dot as a literal rather than as any character', () => {
    expect(includeMatcher('*.csv')('datacsv')).toBe(false);
  });

  it('filters the walk itself', () => {
    put('keep.parquet');
    put('drop.csv');
    expect(relatives({ include: '*.parquet' })).toEqual(['keep.parquet']);
  });
});

describe('extensions', () => {
  it('reads the extension, lowercased and without the dot', () => {
    expect(extensionOf('a/b/data.PARQUET')).toBe('parquet');
  });

  it('is empty for a file with no extension', () => {
    expect(extensionOf('sub/README')).toBe('');
  });

  it('is empty for a dotfile, which has a name rather than an extension', () => {
    expect(extensionOf('.gitignore')).toBe('');
  });

  it('takes the last extension of a double one', () => {
    expect(extensionOf('data.csv.gz')).toBe('gz');
  });
});

describe('the statement over one file', () => {
  it('picks the parquet reader', () => {
    expect(readTemplate('/d/data.parquet')).toContain("read_parquet('/d/data.parquet')");
  });

  it('picks the JSON reader', () => {
    expect(readTemplate('/d/events.ndjson')).toContain('read_json_auto(');
  });

  it('falls back to sniffing a delimited file', () => {
    expect(readTemplate('/d/whatever.txt')).toContain('read_csv_auto(');
  });

  it('bounds itself, so clicking a huge file does not read all of it', () => {
    expect(readTemplate('/d/a.parquet')).toContain('LIMIT 100');
  });

  it('escapes a quote in the path rather than breaking the statement', () => {
    expect(readTemplate("/d/it's.csv")).toContain("'/d/it''s.csv'");
  });
});

describe('quoting', () => {
  it('doubles an embedded quote', () => {
    expect(quote("it's")).toBe("'it''s'");
  });

  it('leaves an ordinary path alone', () => {
    expect(quote('/a/b')).toBe("'/a/b'");
  });
});

describe('the queryable index', () => {
  const files: IndexedFile[] = [
    { relative: 'top.csv', size: 12, modified: '2026-10-02T10:00:00.000Z' },
    { relative: 'sub/deep.parquet', size: 2048, modified: '2026-10-01T10:00:00.000Z' },
  ];

  it('names the columns a person would ask for', () => {
    const sql = fileIndexSql('/root', files);
    expect(sql).toContain('AS t(path, name, extension, size, modified)');
  });

  it('carries the absolute path, the basename and the extension', () => {
    const sql = fileIndexSql('/root', files);
    expect(sql).toContain("'/root/sub/deep.parquet'");
    expect(sql).toContain("'deep.parquet'");
    expect(sql).toContain("'parquet'");
  });

  it('produces an empty but valid view for an empty directory', () => {
    const sql = fileIndexSql('/root', []);
    expect(sql).toContain('WHERE false');
    expect(sql).toContain('AS t(path, name, extension, size, modified)');
  });

  it('escapes a quote in a filename', () => {
    const sql = fileIndexSql('/root', [{ relative: "it's.csv", size: 1, modified: '2026-10-02T10:00:00.000Z' }]);
    expect(sql).toContain("''s.csv'");
  });
});

describe('confinement', () => {
  /**
   * The order is the whole point and is verified against a real DuckDB in the
   * end-to-end run. These assert the order itself, because getting it wrong
   * fails open: the allow list alone is stored and never consulted.
   */
  it('names the root, cuts external access, then locks, in that order', () => {
    const sql = confinementSql('/data');
    expect(sql).toEqual([
      "SET allowed_directories=['/data']",
      'SET enable_external_access=false',
      'SET lock_configuration=true',
    ]);
  });

  it('locks last, or a statement would simply widen the list again', () => {
    const sql = confinementSql('/data');
    expect(sql.indexOf('SET lock_configuration=true')).toBe(sql.length - 1);
  });

  it('escapes a quote in the root', () => {
    expect(confinementSql("/it's")[0]).toBe("SET allowed_directories=['/it''s']");
  });
});

describe('the tree', () => {
  const files: IndexedFile[] = [
    { relative: 'a.csv', size: 10, modified: '2026-10-02T10:00:00.000Z' },
    { relative: 'sub/b.csv', size: 20, modified: '2026-10-02T10:00:00.000Z' },
    { relative: 'sub/deeper/c.parquet', size: 30, modified: '2026-10-02T10:00:00.000Z' },
  ];

  it('shows folders before files at the root', () => {
    expect(levelNodes('/r', files, []).map(n => `${n.kind}:${n.name}`))
      .toEqual(['container:sub', 'object:a.csv']);
  });

  it('counts what is under a folder, recursively', () => {
    expect(levelNodes('/r', files, [])[0]?.detail).toBe('2 files');
  });

  it('counts one file in the singular', () => {
    expect(levelNodes('/r', files, ['sub'])[0]?.detail).toBe('1 file');
  });

  it('descends', () => {
    expect(levelNodes('/r', files, ['sub']).map(n => n.name)).toEqual(['deeper', 'b.csv']);
    expect(levelNodes('/r', files, ['sub', 'deeper']).map(n => n.name)).toEqual(['c.parquet']);
  });

  it('gives a file a statement that runs and a folder none', () => {
    const [folder, file] = levelNodes('/r', files, []);
    expect(folder?.query).toBeUndefined();
    expect(file?.query).toContain('read_csv_auto');
  });

  it('shows a human size on a file', () => {
    expect(levelNodes('/r', files, [])[1]?.detail).toBe('10 B');
  });

  it('inserts a quoted path, because a reader takes a string', () => {
    expect(levelNodes('/r', files, [])[1]?.insert).toBe("'/r/a.csv'");
  });

  it('is empty where there is nothing', () => {
    expect(levelNodes('/r', files, ['nowhere'])).toEqual([]);
  });

  it('does not mistake a sibling prefix for a child', () => {
    const tricky: IndexedFile[] = [
      { relative: 'sub/a.csv', size: 1, modified: '2026-10-02T10:00:00.000Z' },
      { relative: 'subsidiary/b.csv', size: 1, modified: '2026-10-02T10:00:00.000Z' },
    ];
    expect(levelNodes('/r', tricky, ['sub']).map(n => n.name)).toEqual(['a.csv']);
  });
});

describe('opening a connection', () => {
  const io = {
    log: () => { /* nothing to record in a test */ },
  } as never;
  const spec = (options: Record<string, unknown>) =>
    ({ name: 'files', kind: 'dir', options }) as never;
  const endpoint = { host: '', port: 0 } as never;

  it('refuses a path that does not exist, and says which option to fix', async () => {
    await expect(dirProvider.open(spec({ path: path.join(root, 'nope') }), endpoint, io))
      .rejects.toThrow(/does not exist/);
  });

  it('refuses a file where a directory was expected', async () => {
    put('a.csv');
    await expect(dirProvider.open(spec({ path: path.join(root, 'a.csv') }), endpoint, io))
      .rejects.toThrow(/not a directory/);
  });

  it('requires a path at all', async () => {
    await expect(dirProvider.open(spec({}), endpoint, io)).rejects.toThrow(/path/);
  });

  it('opens on a real directory and lists it without DuckDB', async () => {
    // Browsing is a filesystem walk; the 70 MB download is for querying only.
    put('a.csv');
    put('sub/b.parquet');
    const session = await dirProvider.open(spec({ path: root }), endpoint, io);
    try {
      expect((await session.browse([])).map(n => n.name)).toEqual(['sub', 'a.csv']);
    } finally {
      await session.close();
    }
  });
});

describe('what the provider declares', () => {
  it('cannot stream, because the driver materialises a whole result', () => {
    expect(DIR_CAPABILITIES.streams).toBe(false);
  });

  it('cannot cancel, because the node API has no interrupt and there is no socket', () => {
    expect(DIR_CAPABILITIES.cancel).toBe('none');
  });

  it('limits with LIMIT and browses', () => {
    expect(DIR_CAPABILITIES.limit).toBe('limit');
    expect(DIR_CAPABILITIES.browse).toBe(true);
  });

  it('requires only a path', () => {
    const required = dirProvider.fields.filter(f => f.required === true).map(f => f.name);
    expect(required).toEqual(['path']);
  });

  it('is not addressed by host and port, so it is never tunnelled', () => {
    // `sessions.ts` decides tunnelability from the declared fields, and a local
    // directory reached through an SSH forward would be nonsense.
    const names = dirProvider.fields.map(f => f.name);
    expect(names).not.toContain('host');
    expect(names).not.toContain('port');
  });
});
