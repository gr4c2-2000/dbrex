/**
 * Choosing which workspace this window speaks for.
 *
 * A workspace decides which connections exist, so the wrong one does not fail —
 * it makes the right connection missing, which reads as "DbRex lost my
 * database". That is worth a deliberate choice rather than an inference, and
 * worth being able to change without reloading the window.
 *
 * The list is assembled from two places that each know half of it. The daemon
 * knows the workspaces it is serving, including ones belonging to other windows
 * and to agents; the editor knows the folders actually open here, which the
 * daemon has never heard of until one is used. Neither alone is the list a
 * person expects to see.
 *
 * Deliberately free of `vscode`, so the assembly and the labelling can be
 * tested. The picker that shows them lives in `workspacePicker.ts`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { type WorkspaceInfo } from '@dbrex/core';

/** A workspace offered in the picker, and where it came from. */
export interface Candidate {
  /** Absolute path, or undefined for "no workspace, global connections only". */
  readonly path: string | undefined;
  readonly connections: number | undefined;
  readonly active: boolean;
  readonly hasFile: boolean;
  /** True when the daemon has not loaded this one yet. */
  readonly unseen: boolean;
}

/**
 * Merge what the daemon serves with what this window has open.
 *
 * A folder the daemon has not seen is still offered — that is the first-run
 * case, and leaving it out would mean the picker is empty exactly when someone
 * needs it. Its connection count is unknown rather than zero, because zero is a
 * claim and this does not know it.
 */
export function candidates(
  served: readonly WorkspaceInfo[],
  folders: readonly string[],
  active: string | undefined,
): Candidate[] {
  const byPath = new Map<string, Candidate>();

  // Which one is active is decided here, from what this window speaks for, and
  // not read from the daemon's own flag. The daemon learns of a change on the
  // next `hello`, so between a pick and a reconnect the two disagree — and the
  // window is the one that knows.
  for (const w of served) {
    byPath.set(w.path, {
      path: w.path,
      connections: w.connections,
      active: w.path === active,
      hasFile: w.hasFile,
      unseen: false,
    });
  }

  for (const folder of folders) {
    if (byPath.has(folder)) continue;
    byPath.set(folder, {
      path: folder,
      connections: undefined,
      active: folder === active,
      hasFile: hasConnectionsFile(folder),
      unseen: true,
    });
  }

  // The folders this window has open come first: they are what the person
  // looking at the picker is working on. "No workspace" sits at the end, where
  // it reads as an opt-out rather than as the default.
  const open = new Set(folders);
  const list = [...byPath.values()].sort((a, b) => {
    const mine = Number(open.has(b.path!)) - Number(open.has(a.path!));
    return mine !== 0 ? mine : a.path!.localeCompare(b.path!);
  });

  list.push({
    path: undefined,
    connections: undefined,
    active: active === undefined,
    hasFile: false,
    unseen: false,
  });
  return list;
}

function hasConnectionsFile(folder: string): boolean {
  try {
    return fs.statSync(path.join(folder, '.dbrex', 'connections.json')).isFile();
  } catch {
    return false;
  }
}

/** One row of the picker. Exported so the labelling can be asserted on. */
export function describeCandidate(candidate: Candidate): { label: string; description: string; detail?: string } {
  if (candidate.path === undefined) {
    return {
      label: `${candidate.active ? '$(check) ' : ''}No workspace`,
      description: 'global connections only',
    };
  }

  const counted = candidate.connections === undefined
    ? 'not loaded yet'
    : `${candidate.connections} connection${candidate.connections === 1 ? '' : 's'}`;

  return {
    label: `${candidate.active ? '$(check) ' : ''}${path.basename(candidate.path)}`,
    description: counted,
    detail: candidate.hasFile
      ? candidate.path
      : `${candidate.path}  ·  no .dbrex/connections.json of its own`,
  };
}
