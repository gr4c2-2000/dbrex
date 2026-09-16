import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Column, QueryStats } from '@dbrex/core';
import { DbRexError } from '@dbrex/core';
import { ResultStore, normalizeValue, type StoreChange } from '../src/store/results';

const COLUMNS: Column[] = [{ name: 'id', type: 'Int64' }, { name: 'name', type: 'String' }];
const STATS: QueryStats = { elapsedMs: 1, truncated: false };

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dbrex-store-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

let clock = 1_000;
const tick = (): number => (clock += 1_000);

function store(maxBytes = 10_000_000, mode: 'sliding' | 'unlimited' = 'sliding'): ResultStore {
  return new ResultStore(root, { mode, maxBytes }, tick);
}

async function save(
  s: ResultStore,
  rows: unknown[][],
  connection = 'prod',
  sql = 'SELECT 1',
): Promise<string> {
  const writer = s.begin(connection, sql);
  for (const row of rows) await writer.append([row]);
  await writer.finish(COLUMNS, STATS);
  return writer.resultId;
}

describe('write and read', () => {
  it('round-trips rows and reports the row count', async () => {
    const s = store();
    const id = await save(s, [[1, 'a'], [2, 'b'], [3, 'c']]);
    expect(s.summary(id)?.rowCount).toBe(3);
    expect(await s.readRows(id, 0, 10)).toEqual([[1, 'a'], [2, 'b'], [3, 'c']]);
  });

  it('pages by seeking, including the final partial page', async () => {
    const s = store();
    const rows = Array.from({ length: 250 }, (_, i) => [i, `row-${i}`]);
    const id = await save(s, rows);

    expect(await s.readRows(id, 0, 100)).toHaveLength(100);
    expect(await s.readRows(id, 100, 100)).toEqual(rows.slice(100, 200));
    expect(await s.readRows(id, 200, 100)).toEqual(rows.slice(200));
    expect(await s.readRows(id, 250, 100)).toEqual([]);
    expect(await s.readRows(id, 1000, 10)).toEqual([]);
  });

  it('handles rows containing newlines, quotes and unicode', async () => {
    const s = store();
    const rows = [['a\nb', 'quote " and \\ backslash'], ['zażółć', 'gęślą jaźń']];
    const id = await save(s, rows);
    expect(await s.readRows(id, 0, 10)).toEqual(rows);
  });

  it('accepts rows arriving in many chunks', async () => {
    const s = store();
    const writer = s.begin('prod', 'SELECT 1');
    await writer.append([[1, 'a'], [2, 'b']]);
    await writer.append([[3, 'c']]);
    await writer.append([]);
    const summary = await writer.finish(COLUMNS, STATS);
    expect(summary.rowCount).toBe(3);
    expect(await s.readRows(summary.resultId, 1, 2)).toEqual([[2, 'b'], [3, 'c']]);
  });

  it('stores an empty result without breaking paging', async () => {
    const s = store();
    const id = await save(s, []);
    expect(s.summary(id)?.rowCount).toBe(0);
    expect(await s.readRows(id, 0, 10)).toEqual([]);
  });

  it('keeps columns and stats in the metadata', async () => {
    const s = store();
    const id = await save(s, [[1, 'a']]);
    const meta = s.meta(id);
    expect(meta.columns).toEqual(COLUMNS);
    expect(meta.connection).toBe('prod');
    expect(meta.sql).toBe('SELECT 1');
  });
});

describe('atomicity', () => {
  it('does not publish an aborted result', async () => {
    const s = store();
    const writer = s.begin('prod', 'SELECT 1');
    await writer.append([[1, 'a']]);
    await writer.abort();

    expect(s.list()).toHaveLength(0);
    expect(fs.readdirSync(path.join(root, 'tmp'))).toHaveLength(0);
  });

  it('clears temporary directories left by a crashed write on startup', async () => {
    fs.mkdirSync(path.join(root, 'tmp', 'half-written'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tmp', 'half-written', 'rows.ndjson'), '[1]\n');
    const s = store();
    expect(fs.readdirSync(path.join(root, 'tmp'))).toHaveLength(0);
    expect(s.list()).toHaveLength(0);
  });

  it('forgets index entries whose directory vanished', async () => {
    const first = store();
    const id = await save(first, [[1, 'a']]);
    fs.rmSync(path.join(root, 'results', id), { recursive: true, force: true });

    const second = store();
    expect(second.summary(id)).toBeUndefined();
    await expect(second.readRows(id, 0, 1)).rejects.toThrow(/no longer stored/);
  });

  it('deletes result directories the index does not know about', async () => {
    fs.mkdirSync(path.join(root, 'results', 'stray'), { recursive: true });
    store();
    expect(fs.existsSync(path.join(root, 'results', 'stray'))).toBe(false);
  });
});

describe('eviction', () => {
  it('drops least-recently-used results first, not oldest-created', async () => {
    const s = store();
    const rows = Array.from({ length: 20 }, (_, i) => [i, 'x'.repeat(20)]);

    const first = await save(s, rows, 'prod', 'first');
    await save(s, rows, 'prod', 'second');
    await save(s, rows, 'prod', 'third');
    // Reading `first` makes it the most recently used, so tightening the cap to
    // fit two results must drop `second` — the oldest *use*. Eviction by
    // creation time, which is what the old store actually did, would drop
    // `first` here.
    await s.readRows(first, 0, 1);

    const size = s.summary(first)!.sizeBytes;
    s.setOptions({ mode: 'sliding', maxBytes: Math.floor(size * 2.4) });

    expect(s.list().map(r => r.sql).sort()).toEqual(['first', 'third']);
  });

  it('keeps pinned results even when over the cap', async () => {
    const s = store(1_200);
    const rows = Array.from({ length: 20 }, (_, i) => [i, 'x'.repeat(20)]);
    const pinned = await save(s, rows, 'prod', 'pinned');
    s.pin(pinned, true);

    for (let i = 0; i < 4; i++) await save(s, rows, 'prod', `filler-${i}`);
    expect(s.summary(pinned)).toBeDefined();
  });

  it('keeps everything in unlimited mode', async () => {
    const s = store(10, 'unlimited');
    const rows = Array.from({ length: 20 }, (_, i) => [i, 'x'.repeat(20)]);
    for (let i = 0; i < 3; i++) await save(s, rows, 'prod', `q-${i}`);
    expect(s.list()).toHaveLength(3);
  });

  it('applies a tightened cap as soon as options change', async () => {
    const s = store();
    const rows = Array.from({ length: 20 }, (_, i) => [i, 'x'.repeat(20)]);
    for (let i = 0; i < 3; i++) await save(s, rows, 'prod', `q-${i}`);
    expect(s.list()).toHaveLength(3);

    s.setOptions({ mode: 'sliding', maxBytes: 1 });
    expect(s.list()).toHaveLength(0);
  });
});

describe('change notifications', () => {
  it('reports saves, pins and deletes', async () => {
    const s = store();
    const seen: StoreChange[] = [];
    s.onChange(change => seen.push(change));

    const id = await save(s, [[1, 'a']]);
    s.pin(id, true);
    s.delete(id);

    expect(seen).toEqual(['saved', 'pinned', 'deleted']);
  });

  it('reports eviction as a delete, so history views do not show dead rows', async () => {
    const s = store(1_200);
    const rows = Array.from({ length: 20 }, (_, i) => [i, 'x'.repeat(20)]);
    await save(s, rows);

    const deleted: string[] = [];
    s.onChange((change, resultId) => { if (change === 'deleted') deleted.push(resultId); });
    for (let i = 0; i < 3; i++) await save(s, rows);

    expect(deleted.length).toBeGreaterThan(0);
  });

  it('survives a listener that throws', async () => {
    const s = store();
    s.onChange(() => { throw new Error('bad listener'); });
    await expect(save(s, [[1, 'a']])).resolves.toBeTypeOf('string');
  });
});

describe('index persistence', () => {
  it('reloads summaries after a restart', async () => {
    const first = store();
    const id = await save(first, [[1, 'a']]);
    first.pin(id, true);

    const second = store();
    expect(second.summary(id)?.pinned).toBe(true);
    expect(await second.readRows(id, 0, 1)).toEqual([[1, 'a']]);
  });

  it('reports a missing result as not_found, not as an internal error', async () => {
    const s = store();
    try {
      s.meta('nope');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(DbRexError.is(e)).toBe(true);
      expect((e as DbRexError).code).toBe('not_found');
    }
  });
});

describe('normalizeValue', () => {
  it('converts what drivers actually return', () => {
    expect(normalizeValue(10n)).toBe('10');
    expect(normalizeValue(new Date('2026-01-02T03:04:05.000Z'))).toBe('2026-01-02T03:04:05.000Z');
    expect(normalizeValue(Buffer.from('hi'))).toBe('aGk=');
    expect(normalizeValue(undefined)).toBeNull();
    expect(normalizeValue(Number.NaN)).toBe('NaN');
    expect(normalizeValue(Number.POSITIVE_INFINITY)).toBe('Infinity');
  });

  it('recurses into arrays and objects', () => {
    expect(normalizeValue({ a: [1n, new Date(0)], b: { c: 2n } }))
      .toEqual({ a: ['1', '1970-01-01T00:00:00.000Z'], b: { c: '2' } });
  });

  it('leaves ordinary scalars untouched', () => {
    expect(normalizeValue('x')).toBe('x');
    expect(normalizeValue(1.5)).toBe(1.5);
    expect(normalizeValue(true)).toBe(true);
    expect(normalizeValue(null)).toBeNull();
  });
});
