/**
 * The workspace picker.
 *
 * Only the editor-facing half: assembling the list and labelling its rows live
 * in `workspaces.ts`, which stays free of `vscode` so both can be tested.
 */

import * as vscode from 'vscode';
import type { DbRexClient } from '@dbrex/client';
import { candidates, describeCandidate, type Candidate } from './workspaces';

interface Item extends vscode.QuickPickItem {
  readonly candidate: Candidate;
}

/**
 * Ask which workspace to speak for, and tell the daemon.
 *
 * Returns the chosen path, `undefined` for a deliberate "no workspace", and
 * `null` when the picker was dismissed — three outcomes the caller has to tell
 * apart, because two of them are a choice and one is not.
 */
export async function pickWorkspace(
  client: DbRexClient,
  folders: readonly string[],
  active: string | undefined,
): Promise<string | undefined | null> {
  const { workspaces } = await client.call({ op: 'listWorkspaces' });
  const items: Item[] = candidates(workspaces, folders, active).map(candidate => ({
    candidate,
    ...describeCandidate(candidate),
  }));

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Which workspace should DbRex speak for?',
    matchOnDetail: true,
  });
  if (picked === undefined) return null;

  await client.call({
    op: 'useWorkspace',
    ...(picked.candidate.path === undefined ? {} : { workspace: picked.candidate.path }),
  });
  return picked.candidate.path;
}
