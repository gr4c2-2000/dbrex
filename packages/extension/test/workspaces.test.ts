import { describe, expect, it } from 'vitest';
import type { WorkspaceInfo } from '@dbrex/core';
import { candidates, describeCandidate } from '../src/workspaces';

function served(over: Partial<WorkspaceInfo> & { path: string }): WorkspaceInfo {
  return { connections: 0, active: false, hasFile: true, ...over };
}

/** Paths of the offered list, with `null` standing for "no workspace". */
const paths = (list: readonly { path: string | undefined }[]) =>
  list.map(c => c.path ?? null);

describe('assembling the list', () => {
  it('offers what the daemon serves', () => {
    const list = candidates([served({ path: '/a' }), served({ path: '/b' })], [], undefined);
    expect(paths(list)).toEqual(['/a', '/b', null]);
  });

  it('offers an open folder the daemon has never seen', () => {
    // The first-run case. Leaving it out would empty the picker exactly when
    // someone needs it.
    const list = candidates([], ['/open'], undefined);
    expect(paths(list)).toEqual(['/open', null]);
    expect(list[0]?.unseen).toBe(true);
  });

  it('does not offer the same path twice', () => {
    const list = candidates([served({ path: '/a' })], ['/a'], undefined);
    expect(paths(list)).toEqual(['/a', null]);
    expect(list[0]?.unseen).toBe(false);
  });

  it('puts this window folders before workspaces it only serves', () => {
    const list = candidates(
      [served({ path: '/aaa-served' }), served({ path: '/zzz-open' })],
      ['/zzz-open'],
      undefined,
    );
    expect(paths(list)).toEqual(['/zzz-open', '/aaa-served', null]);
  });

  it('always ends with "no workspace", where it reads as an opt-out', () => {
    expect(paths(candidates([served({ path: '/a' })], ['/b'], undefined)).at(-1)).toBeNull();
  });

  it('marks the active one, and nothing else', () => {
    const list = candidates([served({ path: '/a' }), served({ path: '/b' })], [], '/b');
    expect(list.filter(c => c.active).map(c => c.path)).toEqual(['/b']);
  });

  it('marks "no workspace" active when there is none', () => {
    const list = candidates([served({ path: '/a' })], [], undefined);
    expect(list.at(-1)?.active).toBe(true);
  });

  it('keeps the daemon count, and leaves it unknown for a folder it has not loaded', () => {
    const list = candidates([served({ path: '/a', connections: 4 })], ['/b'], undefined);
    expect(list.find(c => c.path === '/a')?.connections).toBe(4);
    // Unknown, not zero: zero would be a claim this does not know to be true.
    expect(list.find(c => c.path === '/b')?.connections).toBeUndefined();
  });

  it('copes with nothing to offer at all', () => {
    expect(paths(candidates([], [], undefined))).toEqual([null]);
  });
});

describe('how a row reads', () => {
  it('shows the folder name, with the full path underneath', () => {
    const row = describeCandidate({
      path: '/home/someone/work/etl', connections: 2, active: false, hasFile: true, unseen: false,
    });
    expect(row.label).toBe('etl');
    expect(row.detail).toBe('/home/someone/work/etl');
    expect(row.description).toBe('2 connections');
  });

  it('counts one connection in the singular', () => {
    expect(describeCandidate({
      path: '/a', connections: 1, active: false, hasFile: true, unseen: false,
    }).description).toBe('1 connection');
  });

  it('says a folder has not been loaded rather than claiming it has none', () => {
    expect(describeCandidate({
      path: '/a', connections: undefined, active: false, hasFile: true, unseen: true,
    }).description).toBe('not loaded yet');
  });

  it('says so when a folder has no connections file of its own', () => {
    expect(describeCandidate({
      path: '/a', connections: 3, active: false, hasFile: false, unseen: false,
    }).detail).toMatch(/no \.dbrex\/connections\.json/);
  });

  it('ticks the active row', () => {
    expect(describeCandidate({
      path: '/a', connections: 0, active: true, hasFile: true, unseen: false,
    }).label).toMatch(/^\$\(check\) /);
  });

  it('describes "no workspace" without a path', () => {
    const row = describeCandidate({
      path: undefined, connections: undefined, active: false, hasFile: false, unseen: false,
    });
    expect(row.label).toBe('No workspace');
    expect(row.description).toBe('global connections only');
    expect(row.detail).toBeUndefined();
  });
});
