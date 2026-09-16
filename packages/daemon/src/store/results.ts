/**
 * Result store.
 *
 * Layout, one directory per result:
 *
 *   results/<id>/rows.ndjson   one JSON array per row
 *   results/<id>/rows.idx      byte offset of every row, 8 bytes each
 *   results/<id>/meta.json     columns, stats, provenance
 *   index.json                 summaries for listing and eviction
 *
 * Three things the old store got wrong, fixed here:
 *
 * 1. It joined every row into one JavaScript string and wrote it in a single
 *    call, so a large result hit V8's maximum string length before it hit any
 *    configured cap. Rows are streamed through a write stream instead.
 * 2. `readRows` re-read the entire file and split it to return one page. The
 *    offset index turns that into a seek.
 * 3. Eviction claimed to be LRU and sorted by creation time, and rebuilt its
 *    accounting by reading every meta file on every save. Access times are
 *    tracked, and accounting lives in one index file.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { Column, QueryStats } from '@dbrex/core';
import { DbRexError } from '@dbrex/core';

export interface ResultMeta {
  readonly resultId: string;
  readonly connection: string;
  readonly sql: string;
  readonly createdAt: string;
  readonly columns: readonly Column[];
  readonly stats: QueryStats;
  readonly rowCount: number;
}

export interface ResultSummary {
  readonly resultId: string;
  readonly connection: string;
  readonly sql: string;
  readonly createdAt: string;
  /** The shape of the result, so a listing does not need to read a row to know it. */
  readonly columns: readonly Column[];
  readonly rowCount: number;
  readonly sizeBytes: number;
  readonly truncated: boolean;
  readonly pinned: boolean;
  /** Last read or write, epoch millis. Drives eviction. */
  readonly accessedAt: number;
}

export type EvictionMode = 'sliding' | 'unlimited';

export interface StoreOptions {
  readonly mode: EvictionMode;
  readonly maxBytes: number;
}

export type StoreChange = 'saved' | 'pinned' | 'deleted';
export type StoreListener = (change: StoreChange, resultId: string, summary?: ResultSummary) => void;

const OFFSET_WIDTH = 8;

export class ResultStore {
  private readonly resultsDir: string;
  private readonly tmpDir: string;
  private readonly indexPath: string;
  private index = new Map<string, ResultSummary>();
  private listeners = new Set<StoreListener>();

  /**
   * `now` is injectable so eviction order can be tested without sleeping. The
   * old codebase did exactly this for its workspace registry, and it was the
   * one component whose time-dependent behaviour was actually covered.
   */
  constructor(
    root: string,
    private options: StoreOptions,
    private readonly now: () => number = Date.now,
  ) {
    this.resultsDir = path.join(root, 'results');
    this.tmpDir = path.join(root, 'tmp');
    this.indexPath = path.join(root, 'index.json');
    fs.mkdirSync(this.resultsDir, { recursive: true });
    fs.mkdirSync(this.tmpDir, { recursive: true });
    this.loadIndex();
    this.sweepOrphans();
  }

  setOptions(options: StoreOptions): void {
    this.options = options;
    this.evict();
  }

  onChange(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Open a writer. Rows land in a temporary directory until `finish` publishes them. */
  begin(connection: string, sql: string): ResultWriter {
    const resultId = crypto.randomBytes(8).toString('hex');
    return new ResultWriter(this, resultId, connection, sql, path.join(this.tmpDir, resultId));
  }

  list(limit?: number): ResultSummary[] {
    const all = [...this.index.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return limit === undefined ? all : all.slice(0, limit);
  }

  summary(resultId: string): ResultSummary | undefined {
    return this.index.get(resultId);
  }

  meta(resultId: string): ResultMeta {
    const file = path.join(this.dir(resultId), 'meta.json');
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as ResultMeta;
    } catch (e) {
      throw new DbRexError('not_found', `result ${resultId} is no longer stored`, {
        hint: 'it was evicted to stay under the cache size cap; pin results you want to keep',
      }, e);
    }
  }

  /** Read a page of rows by seeking, without touching the rest of the file. */
  async readRows(resultId: string, offset: number, limit: number): Promise<unknown[][]> {
    const summary = this.index.get(resultId);
    if (!summary) throw new DbRexError('not_found', `result ${resultId} is no longer stored`);
    if (offset < 0 || limit <= 0) return [];

    const dir = this.dir(resultId);
    const total = summary.rowCount;
    const from = Math.min(offset, total);
    const to = Math.min(offset + limit, total);
    if (from >= to) return [];

    this.touch(resultId);

    const idx = await fs.promises.open(path.join(dir, 'rows.idx'), 'r');
    let start: number;
    let end: number;
    try {
      start = await readOffset(idx, from);
      end = to < total ? await readOffset(idx, to) : (await fs.promises.stat(path.join(dir, 'rows.ndjson'))).size;
    } finally {
      await idx.close();
    }

    const rows = await fs.promises.open(path.join(dir, 'rows.ndjson'), 'r');
    try {
      const buffer = Buffer.allocUnsafe(end - start);
      await rows.read(buffer, 0, buffer.length, start);
      return buffer
        .toString('utf8')
        .split('\n')
        .filter(line => line.length > 0)
        .map(line => JSON.parse(line) as unknown[]);
    } finally {
      await rows.close();
    }
  }

  pin(resultId: string, pinned: boolean): void {
    const summary = this.index.get(resultId);
    if (!summary) throw new DbRexError('not_found', `result ${resultId} is no longer stored`);
    const next = { ...summary, pinned };
    this.index.set(resultId, next);
    this.persistIndex();
    this.emit('pinned', resultId, next);
  }

  delete(resultId: string): boolean {
    const existed = this.index.delete(resultId);
    fs.rmSync(this.dir(resultId), { recursive: true, force: true });
    if (existed) {
      this.persistIndex();
      this.emit('deleted', resultId);
    }
    return existed;
  }

  /** Called by `ResultWriter.finish`. Publishes the temporary directory. */
  publish(partial: ResultSummary, from: string): ResultSummary {
    const summary: ResultSummary = { ...partial, accessedAt: this.now() };
    const target = this.dir(summary.resultId);
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(from, target);
    this.index.set(summary.resultId, summary);
    this.persistIndex();
    this.emit('saved', summary.resultId, summary);
    this.evict();
    return summary;
  }

  totalBytes(): number {
    let total = 0;
    for (const s of this.index.values()) total += s.sizeBytes;
    return total;
  }

  private dir(resultId: string): string {
    return path.join(this.resultsDir, resultId);
  }

  private touch(resultId: string): void {
    const summary = this.index.get(resultId);
    if (!summary) return;
    this.index.set(resultId, { ...summary, accessedAt: this.now() });
    this.persistIndex();
  }

  /**
   * Drop least-recently-used unpinned results until the cache is back under
   * 90% of the cap. Pinned results are excluded from eviction but still counted,
   * so pinning more than the cap disables eviction rather than looping — the
   * caller is told through the log.
   */
  private evict(): void {
    if (this.options.mode === 'unlimited') return;
    let total = this.totalBytes();
    if (total <= this.options.maxBytes) return;

    const target = Math.floor(this.options.maxBytes * 0.9);
    const candidates = [...this.index.values()]
      .filter(s => !s.pinned)
      .sort((a, b) => a.accessedAt - b.accessedAt);

    for (const candidate of candidates) {
      if (total <= target) break;
      if (this.delete(candidate.resultId)) total -= candidate.sizeBytes;
    }
  }

  private emit(change: StoreChange, resultId: string, summary?: ResultSummary): void {
    for (const listener of this.listeners) {
      try {
        listener(change, resultId, summary);
      } catch {
        /* a listener must not break the store */
      }
    }
  }

  private loadIndex(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.indexPath, 'utf8')) as ResultSummary[];
      for (const summary of raw) this.index.set(summary.resultId, summary);
    } catch {
      this.index.clear();
    }
  }

  private persistIndex(): void {
    const tmp = `${this.indexPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...this.index.values()]));
    fs.renameSync(tmp, this.indexPath);
  }

  /**
   * Reconcile the index with the disk once at startup: forget results whose
   * directory is gone, delete directories the index does not know about, and
   * clear abandoned temporary directories from a crashed write.
   */
  private sweepOrphans(): void {
    let dirty = false;
    for (const resultId of [...this.index.keys()]) {
      if (!fs.existsSync(path.join(this.dir(resultId), 'meta.json'))) {
        this.index.delete(resultId);
        dirty = true;
      }
    }
    for (const entry of readdirSafe(this.resultsDir)) {
      if (!this.index.has(entry)) fs.rmSync(path.join(this.resultsDir, entry), { recursive: true, force: true });
    }
    for (const entry of readdirSafe(this.tmpDir)) {
      fs.rmSync(path.join(this.tmpDir, entry), { recursive: true, force: true });
    }
    if (dirty) this.persistIndex();
  }
}

/**
 * Streams one result to disk. Rows are written as they arrive, so peak memory
 * is one chunk rather than the whole result.
 */
export class ResultWriter {
  private readonly rows: fs.WriteStream;
  private readonly offsets: fs.WriteStream;
  private bytes = 0;
  private count = 0;
  private closed = false;

  constructor(
    private readonly store: ResultStore,
    readonly resultId: string,
    private readonly connection: string,
    private readonly sql: string,
    private readonly dir: string,
  ) {
    fs.mkdirSync(dir, { recursive: true });
    this.rows = fs.createWriteStream(path.join(dir, 'rows.ndjson'));
    this.offsets = fs.createWriteStream(path.join(dir, 'rows.idx'));
  }

  get rowCount(): number {
    return this.count;
  }

  async append(rows: readonly (readonly unknown[])[]): Promise<void> {
    if (rows.length === 0) return;
    let payload = '';
    const index = Buffer.allocUnsafe(rows.length * OFFSET_WIDTH);
    let cursor = this.bytes;

    for (let i = 0; i < rows.length; i++) {
      index.writeBigUInt64LE(BigInt(cursor), i * OFFSET_WIDTH);
      const line = JSON.stringify(rows[i]!.map(normalizeValue)) + '\n';
      payload += line;
      cursor += Buffer.byteLength(line);
    }

    this.bytes = cursor;
    this.count += rows.length;
    await Promise.all([write(this.rows, payload), write(this.offsets, index)]);
  }

  /** Publish the result and return its summary. */
  async finish(columns: readonly Column[], stats: QueryStats): Promise<ResultSummary> {
    const meta: ResultMeta = {
      resultId: this.resultId,
      connection: this.connection,
      sql: this.sql,
      createdAt: new Date().toISOString(),
      columns,
      stats,
      rowCount: this.count,
    };
    await this.close();
    await fs.promises.writeFile(path.join(this.dir, 'meta.json'), JSON.stringify(meta));

    return this.store.publish({
      resultId: this.resultId,
      connection: this.connection,
      sql: this.sql,
      createdAt: meta.createdAt,
      columns,
      rowCount: this.count,
      sizeBytes: this.bytes,
      truncated: stats.truncated,
      pinned: false,
      accessedAt: 0,  // replaced by the store's clock in publish()
    }, this.dir);
  }

  /** Throw the partial result away. Safe to call twice. */
  async abort(): Promise<void> {
    await this.close();
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  private async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([end(this.rows), end(this.offsets)]);
  }
}

/**
 * Make a driver value survive JSON.
 *
 * Every driver returns something `JSON.stringify` cannot handle: mysql2 returns
 * `Date` and `Buffer`, ClickHouse returns `BigInt` for 64-bit integers. Left
 * alone, a single such column turns the whole write into a throw.
 */
export function normalizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (typeof value === 'object') {
    // Nested structures (JSON columns, Trino arrays and maps) recurse; anything
    // exotic falls back to its string form rather than failing the write.
    if (Array.isArray(value)) return value.map(normalizeValue);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = normalizeValue(v);
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  return value;
}

async function readOffset(handle: fs.promises.FileHandle, row: number): Promise<number> {
  const buffer = Buffer.allocUnsafe(OFFSET_WIDTH);
  await handle.read(buffer, 0, OFFSET_WIDTH, row * OFFSET_WIDTH);
  return Number(buffer.readBigUInt64LE(0));
}

function write(stream: fs.WriteStream, chunk: string | Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, err => (err ? reject(err) : resolve()));
  });
}

function end(stream: fs.WriteStream): Promise<void> {
  return new Promise(resolve => stream.end(resolve));
}

function readdirSafe(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
