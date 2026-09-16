import { describe, expect, it } from 'vitest';
import {
  completionAt,
  completionNodes,
  prefixAt,
  type BrowseNode,
  type ChildrenSource,
} from '../src/index';

/** Cursor position marked with `|`, which is not SQL and cannot occur by accident. */
function at(marked: string): { text: string; offset: number } {
  const offset = marked.indexOf('|');
  if (offset === -1) throw new Error('mark the cursor with |');
  return { text: marked.replace('|', ''), offset };
}

function request(marked: string) {
  const { text, offset } = at(marked);
  return completionAt(text, offset);
}

describe('what the cursor is asking for', () => {
  it('asks for the children of a path after a trailing dot', () => {
    expect(request('SELECT * FROM analytics.|')).toEqual({ kind: 'children', path: ['analytics'] });
  });

  it('keeps asking for the same children once a partial name is typed', () => {
    expect(request('SELECT * FROM analytics.ev|')).toEqual({ kind: 'children', path: ['analytics'] });
  });

  it('follows a dotted path to any depth', () => {
    expect(request('SELECT * FROM analytics.events.|'))
      .toEqual({ kind: 'children', path: ['analytics', 'events'] });
  });

  it('asks for the roots right after a clause that names a relation', () => {
    for (const clause of ['FROM', 'JOIN', 'INTO', 'UPDATE', 'TABLE']) {
      expect(request(`SELECT * ${clause} |`), clause).toEqual({ kind: 'roots' });
    }
  });

  it('still asks for the roots once a partial name is typed', () => {
    expect(request('SELECT * FROM ev|')).toEqual({ kind: 'roots' });
  });

  it('is case insensitive about the clause', () => {
    expect(request('select * from |')).toEqual({ kind: 'roots' });
  });

  it('asks for the columns of the tables the statement names', () => {
    expect(request('SELECT | FROM events'))
      .toEqual({ kind: 'columns', tables: ['events'] });
  });

  it('collects every relation in the statement, qualified or not', () => {
    expect(request('SELECT | FROM analytics.events JOIN users ON a = b'))
      .toEqual({ kind: 'columns', tables: ['analytics.events', 'users'] });
  });

  it('stops after four relations, because each one costs a round trip', () => {
    const sql = 'SELECT | FROM a JOIN b JOIN c JOIN d JOIN e JOIN f';
    expect(request(sql)).toEqual({ kind: 'columns', tables: ['a', 'b', 'c', 'd'] });
  });

  it('offers nothing when the statement names no relation', () => {
    expect(request('SELECT 1 + |')).toBeUndefined();
  });

  it('reads only the line the cursor is on, so an earlier dot does not leak', () => {
    expect(request('SELECT *\nFROM |')).toEqual({ kind: 'roots' });
  });

  it('scopes columns to the statement under the cursor, not the whole file', () => {
    expect(request('SELECT * FROM users;\nSELECT | FROM events'))
      .toEqual({ kind: 'columns', tables: ['events'] });
  });
});

describe('the fragment already typed', () => {
  it('is the identifier the cursor sits at the end of', () => {
    const { text, offset } = at('SELECT * FROM ev|');
    expect(prefixAt(text, offset)).toBe('ev');
  });

  it('is empty after a dot, because everything below the path is a candidate', () => {
    const { text, offset } = at('SELECT * FROM analytics.|');
    expect(prefixAt(text, offset)).toBe('');
  });

  it('is empty at the start of a line', () => {
    const { text, offset } = at('SELECT *\n|');
    expect(prefixAt(text, offset)).toBe('');
  });
});

function node(kind: BrowseNode['kind'], name: string): BrowseNode {
  return { kind, name, hasChildren: kind !== 'column' };
}

/** A fixed tree, plus a record of which paths were actually asked for. */
function tree(shape: Record<string, readonly BrowseNode[]>): ChildrenSource & { asked: string[][] } {
  const asked: string[][] = [];
  const source = async (path: readonly string[]) => {
    asked.push([...path]);
    return shape[path.join('.')] ?? [];
  };
  return Object.assign(source, { asked });
}

describe('resolving a request against the schema', () => {
  it('lists a path directly', async () => {
    const children = tree({ analytics: [node('table', 'events')] });
    expect(await completionNodes({ kind: 'children', path: ['analytics'] }, children))
      .toEqual([node('table', 'events')]);
  });

  it('lists the top level for roots', async () => {
    const children = tree({ '': [node('database', 'analytics')] });
    expect(await completionNodes({ kind: 'roots' }, children))
      .toEqual([node('database', 'analytics')]);
  });

  it('returns only columns, never the tables it walked through', async () => {
    const children = tree({
      'analytics.events': [node('column', 'day'), node('column', 'kind')],
    });
    expect(await completionNodes({ kind: 'columns', tables: ['analytics.events'] }, children))
      .toEqual([node('column', 'day'), node('column', 'kind')]);
  });

  it('finds the database of an unqualified table instead of guessing one', async () => {
    const children = tree({
      '': [node('database', 'ops'), node('database', 'analytics')],
      ops: [node('table', 'incidents')],
      analytics: [node('table', 'events')],
      'analytics.events': [node('column', 'day')],
    });
    expect(await completionNodes({ kind: 'columns', tables: ['events'] }, children))
      .toEqual([node('column', 'day')]);
    // It had to look inside `ops` first; taking the first root would have been wrong.
    expect(children.asked).toContainEqual(['ops']);
  });

  it('gives up quietly on an unqualified table no database holds', async () => {
    const children = tree({ '': [node('database', 'ops')], ops: [] });
    expect(await completionNodes({ kind: 'columns', tables: ['ghost'] }, children)).toEqual([]);
  });

  it('merges the columns of several tables', async () => {
    const children = tree({
      'a.x': [node('column', 'id')],
      'b.y': [node('column', 'name')],
    });
    expect(await completionNodes({ kind: 'columns', tables: ['a.x', 'b.y'] }, children))
      .toEqual([node('column', 'id'), node('column', 'name')]);
  });
});
