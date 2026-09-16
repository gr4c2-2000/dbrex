import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigWatcher } from '../src/watch';

let dir: string;
let file: string;
let watcher: ConfigWatcher | undefined;

/** Give the watcher its debounce plus enough slack for the filesystem event. */
const settle = (): Promise<void> => new Promise(r => setTimeout(r, 120));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbrex-watch-'));
  file = path.join(dir, 'connections.json');
});

afterEach(() => {
  watcher?.dispose();
  watcher = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

function watch(): { fired: () => number } {
  let count = 0;
  watcher = new ConfigWatcher(() => { count++; }, 20);
  watcher.add(file);
  return { fired: () => count };
}

describe('ConfigWatcher', () => {
  it('fires when the file is created', async () => {
    const seen = watch();
    fs.writeFileSync(file, '{"connections":[]}');
    await settle();
    expect(seen.fired()).toBe(1);
  });

  it('fires when the content changes', async () => {
    fs.writeFileSync(file, '{"connections":[]}');
    const seen = watch();
    fs.writeFileSync(file, '{"connections":[{"name":"a"}]}');
    await settle();
    expect(seen.fired()).toBe(1);
  });

  it('survives an atomic save, which replaces the file rather than writing it', async () => {
    fs.writeFileSync(file, '{"connections":[]}');
    const seen = watch();

    // What editors actually do: write a temporary file, then rename over the
    // original. A watch on the file itself follows the old inode and goes deaf.
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, '{"connections":[{"name":"a"}]}');
    fs.renameSync(tmp, file);
    await settle();

    expect(seen.fired()).toBe(1);
  });

  it('ignores a rewrite that does not change the content', async () => {
    const content = '{"connections":[]}';
    fs.writeFileSync(file, content);
    const seen = watch();
    fs.writeFileSync(file, content);
    await settle();
    // Dropping every open database session because an editor re-saved an
    // unchanged buffer would be a poor trade.
    expect(seen.fired()).toBe(0);
  });

  it('ignores other files in the same directory', async () => {
    fs.writeFileSync(file, '{"connections":[]}');
    const seen = watch();
    fs.writeFileSync(path.join(dir, 'notes.md'), 'hello');
    await settle();
    expect(seen.fired()).toBe(0);
  });

  it('collapses a burst of writes into one reload', async () => {
    fs.writeFileSync(file, '{"connections":[]}');
    const seen = watch();
    for (let i = 0; i < 5; i++) fs.writeFileSync(file, `{"connections":[{"n":${i}}]}`);
    await settle();
    expect(seen.fired()).toBe(1);
  });

  it('fires when the file is deleted', async () => {
    fs.writeFileSync(file, '{"connections":[]}');
    const seen = watch();
    fs.unlinkSync(file);
    await settle();
    expect(seen.fired()).toBe(1);
  });

  it('tolerates a directory that does not exist', () => {
    watcher = new ConfigWatcher(() => {}, 20);
    expect(() => watcher!.add(path.join(dir, 'nope', 'connections.json'))).not.toThrow();
  });

  it('stops firing after dispose', async () => {
    fs.writeFileSync(file, '{"connections":[]}');
    const seen = watch();
    watcher!.dispose();
    fs.writeFileSync(file, '{"connections":[{"name":"a"}]}');
    await settle();
    expect(seen.fired()).toBe(0);
  });
});
