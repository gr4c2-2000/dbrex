import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  appendConnection,
  readConnections,
  removeConnectionEntry,
  updateConnection,
} from '../src/connectionsFile';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbrex-config-'));
  file = path.join(dir, '.dbrex', 'connections.json');
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function write(body: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body, null, 2));
}

const read = () => JSON.parse(fs.readFileSync(file, 'utf8')) as { connections: Record<string, unknown>[] };
const names = () => read().connections.map(c => c['name']);

describe('reading', () => {
  it('reads a well-formed file', () => {
    write({ connections: [{ name: 'a' }] });
    expect(readConnections(file)?.connections).toEqual([{ name: 'a' }]);
  });

  it('refuses a file that is not JSON rather than calling it empty', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not json');
    expect(readConnections(file)).toBeUndefined();
  });

  it('refuses a file whose connections are not a list', () => {
    write({ connections: { a: 1 } });
    expect(readConnections(file)).toBeUndefined();
  });

  it('refuses a file that is not there', () => {
    expect(readConnections(file)).toBeUndefined();
  });
});

describe('adding', () => {
  it('creates the file and its directory', () => {
    appendConnection(file, { name: 'a', kind: 'mysql' });
    expect(names()).toEqual(['a']);
  });

  it('keeps what was already there, and its order', () => {
    write({ connections: [{ name: 'first' }, { name: 'second' }] });
    appendConnection(file, { name: 'third' });
    expect(names()).toEqual(['first', 'second', 'third']);
  });

  it('writes a trailing newline, so the file is not a diff hazard', () => {
    appendConnection(file, { name: 'a' });
    expect(fs.readFileSync(file, 'utf8').endsWith('}\n')).toBe(true);
  });
});

describe('changing one option', () => {
  it('changes a value declared at the top level of the entry', () => {
    write({ connections: [{ name: 'a', host: 'old' }] });
    expect(updateConnection(file, 'a', 'host', 'new')).toBe(true);
    expect(read().connections[0]).toEqual({ name: 'a', host: 'new' });
  });

  it('changes a value inside an options block, leaving it there', () => {
    // Both spellings are accepted by the daemon; moving someone's key between
    // them is an edit they did not ask for.
    write({ connections: [{ name: 'a', options: { host: 'old' } }] });
    updateConnection(file, 'a', 'host', 'new');
    expect(read().connections[0]).toEqual({ name: 'a', options: { host: 'new' } });
  });

  it('adds an option that was not set before', () => {
    write({ connections: [{ name: 'a' }] });
    updateConnection(file, 'a', 'port', 3306);
    expect(read().connections[0]).toEqual({ name: 'a', port: 3306 });
  });

  it('leaves the other entries untouched', () => {
    write({ connections: [{ name: 'a', host: 'x' }, { name: 'b', host: 'y' }] });
    updateConnection(file, 'a', 'host', 'z');
    expect(read().connections[1]).toEqual({ name: 'b', host: 'y' });
  });

  it('reports a name that is not there, and changes nothing', () => {
    write({ connections: [{ name: 'a' }] });
    expect(updateConnection(file, 'ghost', 'host', 'x')).toBe(false);
    expect(read().connections).toEqual([{ name: 'a' }]);
  });

  it('reports a file it cannot read', () => {
    expect(updateConnection(file, 'a', 'host', 'x')).toBe(false);
  });
});

describe('removing', () => {
  it('removes the named entry and keeps the rest in order', () => {
    write({ connections: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] });
    expect(removeConnectionEntry(file, 'b')).toBe(true);
    expect(names()).toEqual(['a', 'c']);
  });

  it('removes the only entry, leaving a valid empty file', () => {
    write({ connections: [{ name: 'a' }] });
    removeConnectionEntry(file, 'a');
    expect(read().connections).toEqual([]);
    expect(readConnections(file)).toEqual({ connections: [] });
  });

  it('refuses a name that is not there, and does not rewrite the file', () => {
    write({ connections: [{ name: 'a' }] });
    const before = fs.readFileSync(file, 'utf8');
    expect(removeConnectionEntry(file, 'ghost')).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('refuses a file it cannot read, rather than replacing it with an empty one', () => {
    // The failure mode this guards: treating an unparseable file as empty and
    // writing that back deletes every connection in it.
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ broken');
    expect(removeConnectionEntry(file, 'a')).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('{ broken');
  });

  it('refuses a missing file without creating one', () => {
    expect(removeConnectionEntry(file, 'a')).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('removes every entry sharing the name, since the daemon addresses by name', () => {
    write({ connections: [{ name: 'dup', host: 'a' }, { name: 'dup', host: 'b' }, { name: 'keep' }] });
    removeConnectionEntry(file, 'dup');
    expect(names()).toEqual(['keep']);
  });
});
