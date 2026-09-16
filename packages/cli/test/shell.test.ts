import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import type { BrowseNode } from '@dbrex/core';
import { completionsFor, runShell, type ShellOptions } from '../src/shell';

/** A schema the fake daemon serves, keyed by the browse path. */
const TREE: Record<string, BrowseNode[]> = {
  '': [node('database', 'analytics'), node('database', 'ops')],
  analytics: [node('table', 'events'), node('table', 'events_raw')],
  ops: [node('table', 'incidents')],
  'analytics.events': [node('column', 'day'), node('column', 'hits')],
};

function node(kind: BrowseNode['kind'], name: string): BrowseNode {
  return { kind, name, hasChildren: kind !== 'column' };
}

function fakeClient() {
  const browsed: string[][] = [];
  return {
    browsed,
    async call(request: { op: string; path?: readonly string[] }) {
      if (request.op === 'browse') {
        browsed.push([...(request.path ?? [])]);
        return { nodes: TREE[(request.path ?? []).join('.')] ?? [] };
      }
      throw new Error(`unexpected op ${request.op}`);
    },
  };
}

/**
 * Drive a session by feeding it lines, and collect what it printed.
 *
 * The shell reads a real readline over a pipe rather than a terminal, which is
 * what a test can drive; the completer is exercised directly, because Tab is
 * not a character a pipe can carry.
 */
async function session(input: string[], over: Partial<ShellOptions> = {}) {
  const stdin = new PassThrough();
  const written: string[] = [];
  const ran: { connection: string; sql: string; format: string }[] = [];

  const realIn = process.stdin;
  const realWrite = process.stdout.write.bind(process.stdout);
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
  process.stdout.write = ((chunk: string) => { written.push(String(chunk)); return true; }) as never;

  try {
    const client = fakeClient();
    const finished = runShell({
      client: client as never,
      connection: 'prod',
      format: 'table',
      execute: async (connection, sql, format) => { ran.push({ connection, sql, format }); },
      ...over,
    });
    for (const line of input) stdin.write(`${line}\n`);
    stdin.end();
    await finished;
    return { written: written.join(''), ran, client };
  } finally {
    Object.defineProperty(process, 'stdin', { value: realIn, configurable: true });
    process.stdout.write = realWrite;
  }
}

describe('running statements', () => {
  it('runs a statement once it is terminated', async () => {
    const { ran } = await session(['SELECT 1;']);
    expect(ran).toEqual([{ connection: 'prod', sql: 'SELECT 1', format: 'table' }]);
  });

  it('waits for the semicolon before running anything', async () => {
    const { ran } = await session(['SELECT 1']);
    expect(ran).toEqual([]);
  });

  it('joins a statement spread over several lines', async () => {
    const { ran } = await session(['SELECT count(*)', 'FROM events', 'WHERE day > 0;']);
    expect(ran).toHaveLength(1);
    expect(ran[0]?.sql).toBe('SELECT count(*)\nFROM events\nWHERE day > 0');
  });

  it('runs each statement when a line holds several', async () => {
    const { ran } = await session(['SELECT 1; SELECT 2;']);
    expect(ran.map(r => r.sql)).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('ignores an empty line', async () => {
    const { ran } = await session(['', '   ', 'SELECT 1;']);
    expect(ran).toHaveLength(1);
  });

  it('runs every queued line when input ends while one is still running', async () => {
    // A pipe closes long before a slow statement finishes. Treating that close
    // as "stop" dropped everything still queued behind it.
    const ran: string[] = [];
    await session(['SELECT 1;', 'SELECT 2;', 'SELECT 3;'], {
      execute: async (_c, sql) => {
        await new Promise(resolve => setTimeout(resolve, 5));
        ran.push(sql);
      },
    });
    expect(ran).toEqual(['SELECT 1', 'SELECT 2', 'SELECT 3']);
  });

  it('keeps the session alive when a statement fails', async () => {
    const ran: string[] = [];
    await session(['BAD;', 'SELECT 1;'], {
      execute: async (_c, sql) => {
        ran.push(sql);
        if (sql === 'BAD') throw new Error('nope');
      },
    });
    expect(ran).toEqual(['BAD', 'SELECT 1']);
  });
});

describe('meta commands', () => {
  it('switches connection with \\c', async () => {
    const { ran } = await session(['\\c staging', 'SELECT 1;']);
    expect(ran[0]?.connection).toBe('staging');
  });

  it('reports the current connection when \\c is given nothing', async () => {
    const { written } = await session(['\\c']);
    expect(written).toContain('prod');
  });

  it('changes the output format with \\f', async () => {
    const { ran } = await session(['\\f json', 'SELECT 1;']);
    expect(ran[0]?.format).toBe('json');
  });

  it('refuses a format it cannot render', async () => {
    const { ran } = await session(['\\f yaml', 'SELECT 1;']);
    expect(ran[0]?.format).toBe('table');
  });

  it('lists a path with \\d', async () => {
    const { written } = await session(['\\d analytics']);
    expect(written).toContain('events');
  });

  it('quits on \\q without running what follows', async () => {
    const { ran } = await session(['\\q', 'SELECT 1;']);
    expect(ran).toEqual([]);
  });

  it('treats a backslash inside a statement as text, not a command', async () => {
    const { ran } = await session(['SELECT 1', '\\c staging;']);
    expect(ran[0]?.sql).toContain('\\c staging');
    expect(ran[0]?.connection).toBe('prod');
  });
});

describe('history', () => {
  let dir: string;

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbrex-shell-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('writes what was typed, oldest first', async () => {
    const file = path.join(dir, 'history');
    await session(['SELECT 1;', 'SELECT 2;'], { historyFile: file });
    expect(fs.readFileSync(file, 'utf8').trim().split('\n')).toEqual(['SELECT 1;', 'SELECT 2;']);
  });

  it('keeps the file private', async () => {
    const file = path.join(dir, 'history');
    await session(['SELECT 1;'], { historyFile: file });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('survives a history file it cannot read', async () => {
    const { ran } = await session(['SELECT 1;'], { historyFile: path.join(dir, 'no', 'such', 'file') });
    expect(ran).toHaveLength(1);
  });
});

describe('tab completion', () => {
  const children = async (path: readonly string[]) => TREE[path.join('.')] ?? [];

  /** What Tab would offer with the cursor at the end of the text. */
  const at = (text: string) => completionsFor(text, text.length, children);

  it('offers the databases after FROM', async () => {
    expect(await at('SELECT * FROM ')).toEqual([['analytics', 'ops'], '']);
  });

  it('narrows to what has been typed, and says what it is replacing', async () => {
    expect(await at('SELECT * FROM an')).toEqual([['analytics'], 'an']);
  });

  it('matches regardless of case', async () => {
    expect(await at('SELECT * FROM AN')).toEqual([['analytics'], 'AN']);
  });

  it('offers the tables of a database after its dot', async () => {
    expect(await at('SELECT * FROM analytics.')).toEqual([['events', 'events_raw'], '']);
  });

  it('narrows the tables under a dot', async () => {
    expect(await at('SELECT * FROM analytics.events_')).toEqual([['events_raw'], 'events_']);
  });

  it('offers the columns of the table the statement names', async () => {
    const text = 'SELECT  FROM analytics.events';
    expect(await completionsFor(text, 'SELECT '.length, children))
      .toEqual([['day', 'hits'], '']);
  });

  it('narrows the columns to what has been typed', async () => {
    const text = 'SELECT h FROM analytics.events';
    expect(await completionsFor(text, 'SELECT h'.length, children)).toEqual([['hits'], 'h']);
  });

  it('offers nothing rather than everything when nothing matches', async () => {
    expect(await at('SELECT * FROM zz')).toEqual([[], 'zz']);
  });

  it('completes across a statement split over lines', async () => {
    expect(await at('SELECT *\nFROM an')).toEqual([['analytics'], 'an']);
  });

  it('stays quiet where there is nothing to suggest', async () => {
    expect(await at('SELECT 1 + ')).toEqual([[], '']);
  });

  it('survives a browse that fails', async () => {
    const angry = async () => { throw new Error('connection lost'); };
    await expect(completionsFor('SELECT * FROM ', 14, angry)).rejects.toThrow();
  });
});
