/**
 * `dbrex shell` — an interactive session against one connection.
 *
 * The one-shot `dbrex query` is the right shape for a script and the wrong
 * shape for a person: every statement re-reads the connection, and there is
 * nowhere for Tab to mean anything. Here the connection is open for the length
 * of the session, so completion can ask the server what exists.
 *
 * Completion reuses the rules the editor uses, from `@dbrex/core`. What is left
 * here is the part a terminal has that an editor does not: readline gives us
 * one line, but a statement may span several, and the candidate list has to be
 * filtered against the fragment already typed because readline will not do it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { DbRexClient } from '@dbrex/client';
import {
  completionAt,
  completionNodes,
  messageOf,
  prefixAt,
  splitSql,
  type BrowseNode,
  type ChildrenSource,
} from '@dbrex/core';
import { FORMATS, isFormat, type Format } from './format';
import { askHiddenOn, useSecretPrompt } from './prompt';

export interface ShellOptions {
  readonly client: DbRexClient;
  /** Connection the session starts on. `\c` changes it. */
  readonly connection: string;
  readonly format: Format;
  /** Where to keep the history. Absent disables it. */
  readonly historyFile?: string;
  /** Run one statement and print it. Owned by the caller, so the shell does not duplicate it. */
  readonly execute: (connection: string, sql: string, format: Format) => Promise<void>;
}

const HISTORY_LIMIT = 1000;
const CACHE_TTL_MS = 60_000;

const HELP = `
  <statement>;      run it. A statement may span lines; the ; ends it.
  Tab               complete a database, table or column from the server
  \\c <name>         switch to another connection
  \\f <format>       ${FORMATS.join(' | ')}
  \\d [path...]      list what is under a path, like: \\d analytics events
  \\q                quit, as does Ctrl-D
`;

export async function runShell(options: ShellOptions): Promise<number> {
  const schema = new SchemaCache(options.client);
  let connection = options.connection;
  let format = options.format;
  /** Lines of the statement being typed, before the line readline is holding. */
  let pending: string[] = [];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    history: loadHistory(options.historyFile),
    historySize: HISTORY_LIMIT,
    completer: (line: string, done: (error: null, result: [string[], string]) => void) => {
      // The buffer, not the line: `SELECT *\nFROM ev` has to complete as one
      // statement or the rules see a fragment with no FROM in it.
      const text = [...pending, line].join('\n');
      void completionsFor(text, text.length, path => schema.children(connection, path))
        .then(hits => done(null, hits))
        .catch(() => done(null, [[], line]));
    },
  });

  process.stdout.write(`dbrex shell — ${connection}. \\q to quit, \\? for help.\n`);

  // A password prompt during a query has to come through this readline; a
  // second one on the same stdin would fight it for keystrokes.
  const restorePrompt = useSecretPrompt(prompt => askHiddenOn(rl, prompt));

  /**
   * Lines are handled through the `line` event rather than a loop of
   * `rl.question`, because between two questions nothing is listening and a
   * line that arrives in that gap is dropped. Pasting four lines of SQL is
   * exactly that case. They are chained so a statement finishes before the
   * next line is looked at.
   */
  let work = Promise.resolve();
  /** Set by `\\q`, not by the end of input. */
  let quit = false;
  /** Set when the input stream ends. There is nobody left to prompt. */
  let ended = false;

  const finished = new Promise<void>(resolve => {
    // End of input means no more lines are coming, not that the ones already
    // queued should be dropped. Piping two statements in ends the stream while
    // the first is still running, and discarding the rest there lost the
    // second statement every time.
    rl.on('close', () => {
      ended = true;
      const drain = (): void => {
        const current = work;
        void current.then(() => { if (current === work) resolve(); else drain(); });
      };
      drain();
    });

    rl.on('line', line => {
      if (quit) return;
      work = work
        .then(async () => {
          if (quit) return;
          const more = await handle(line);
          if (!more) { quit = true; rl.close(); return; }
          // Prompting a closed interface throws. Nothing is waiting for a
          // prompt once the input has ended, and the rejection would break the
          // chain that the remaining lines are queued on.
          if (ended) return;
          rl.setPrompt(promptFor());
          rl.prompt();
        })
        // The chain carries every remaining line. Whatever goes wrong in one
        // of them, the rest still have to run.
        .catch((e: unknown) => { process.stderr.write(`${messageOf(e)}\n`); });
    });
  });

  const promptFor = (): string => (pending.length === 0 ? `${connection}> ` : '   -> ');

  /** Returns false when the session should end. */
  async function handle(line: string): Promise<boolean> {
    // A meta-command is only a meta-command at the start of a statement;
    // inside one it is just text, and a backslash appears in real SQL.
    if (pending.length === 0) {
      const trimmed = line.trim();
      if (trimmed.length === 0) return true;
      if (trimmed === '\\q' || trimmed === 'quit' || trimmed === 'exit') return false;
      if (trimmed === '\\?' || trimmed === 'help') { process.stdout.write(HELP); return true; }

      if (trimmed.startsWith('\\c')) {
        const next = trimmed.slice(2).trim();
        if (next.length === 0) { process.stdout.write(`${connection}\n`); return true; }
        connection = next;
        schema.invalidate();
        process.stdout.write(`now on ${connection}\n`);
        return true;
      }

      if (trimmed.startsWith('\\f')) {
        const next = trimmed.slice(2).trim();
        if (!isFormat(next)) {
          process.stderr.write(`format is one of: ${FORMATS.join(', ')}\n`);
          return true;
        }
        format = next;
        return true;
      }

      if (trimmed.startsWith('\\d')) {
        await list(schema, connection, trimmed.slice(2).trim());
        return true;
      }
    }

    pending.push(line);
    const text = pending.join('\n');
    // Wait for the terminator rather than guessing: a statement is finished
    // when the user says it is.
    if (!text.trimEnd().endsWith(';')) return true;
    pending = [];

    for (const statement of splitSql(text)) {
      try {
        await options.execute(connection, statement.sql, format);
      } catch (e) {
        // One bad statement ends the statement, not the session.
        process.stderr.write(`${messageOf(e)}\n`);
      }
    }
    // A statement may have created or dropped something.
    schema.invalidate();
    return true;
  }

  rl.setPrompt(promptFor());
  rl.prompt();

  try {
    await finished;
  } finally {
    restorePrompt();
    rl.close();
    saveHistory(options.historyFile, rl);
  }
  return 0;
}

/**
 * Candidates for the cursor at the end of `text`, filtered by what is typed.
 *
 * The filtering is the part an editor does for you. readline hands back
 * whatever it is given and replaces the typed fragment with it, so returning
 * an unfiltered list would overwrite what the user was halfway through.
 */
export async function completionsFor(
  text: string,
  offset: number,
  children: ChildrenSource,
): Promise<[string[], string]> {
  const prefix = prefixAt(text, offset);
  const request = completionAt(text, offset);
  if (request === undefined) return [[], prefix];

  const nodes = await completionNodes(request, children);
  const names = nodes.map(node => node.insert ?? node.name);
  const hits = names.filter(name => name.toLowerCase().startsWith(prefix.toLowerCase()));
  return [hits, prefix];
}

async function list(schema: SchemaCache, connection: string, where: string): Promise<void> {
  const nodes = await schema.children(connection, where.length === 0 ? [] : where.split(/[\s.]+/));
  for (const node of nodes) {
    process.stdout.write(`${node.kind.padEnd(9)} ${node.name}${node.detail ? `  ${node.detail}` : ''}\n`);
  }
}

/**
 * Browse results, remembered for a minute.
 *
 * Tab is pressed far more often than the schema changes, and every miss is a
 * round trip to the server while the user waits with the cursor blinking.
 */
class SchemaCache {
  private readonly entries = new Map<string, { at: number; nodes: readonly BrowseNode[] }>();

  constructor(private readonly client: DbRexClient) {}

  invalidate(): void {
    this.entries.clear();
  }

  async children(connection: string, path: readonly string[]): Promise<readonly BrowseNode[]> {
    // A separator that cannot occur in an identifier, so ['a', 'bc'] and
    // ['ab', 'c'] do not collide. Written as an escape, and not NUL: a raw
    // control byte in a source file makes git and grep call it binary.
    const key = [connection, ...path].join('\u001f');
    const hit = this.entries.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.nodes;

    try {
      const { nodes } = await this.client.call({ op: 'browse', connection, path });
      this.entries.set(key, { at: Date.now(), nodes });
      return nodes;
    } catch {
      // A failed browse must not interrupt typing. No candidates is a fine
      // answer; a stack trace in the middle of a line is not.
      return [];
    }
  }
}

/** Newest first, which is the order readline's history is kept in. */
function loadHistory(file: string | undefined): string[] {
  if (file === undefined) return [];
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(line => line.length > 0).reverse();
  } catch {
    return [];
  }
}

function saveHistory(file: string | undefined, rl: readline.Interface): void {
  if (file === undefined) return;
  const history = (rl as unknown as { history?: string[] }).history ?? [];
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // Oldest first on disk, so the file reads in the order things were typed.
    fs.writeFileSync(file, `${[...history].reverse().slice(-HISTORY_LIMIT).join('\n')}\n`, { mode: 0o600 });
  } catch {
    // A history that cannot be written is not a reason to fail the session.
  }
}
