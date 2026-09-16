/**
 * `dbrex` — the terminal client.
 *
 * Small on purpose. Its reason to exist is `dbrex unlock`: it is the piece that
 * lets an agent work with no editor running at all, because a person can answer
 * the one question the daemon cannot answer for itself from any terminal.
 * Everything else here is convenience that falls out of already having a client.
 */

import * as readline from 'node:readline';
import * as fs from 'node:fs';
import { DbRexClient, ensureDaemon, isListening } from '@dbrex/client';
import {
  DbRexError,
  configAt,
  messageOf,
  splitSql,
  type ConnectionInfo,
} from '@dbrex/core';
import { configDir, daemonPath, socketPath } from './paths';
import { installDuckDB } from './duckdb';
import { runMcpBridge } from './mcp';

export const VERSION = '0.1.0';

const USAGE = `dbrex ${VERSION}

  dbrex status                       is the daemon up, is the vault unlocked
  dbrex connections                  list connections and what they are for
  dbrex query <conn> <sql>           run one statement and print the rows
  dbrex query <conn> -f <file.sql>   run a file, honouring -- @conn / -- @limit
  dbrex browse <conn> [path...]      walk the schema tree
  dbrex unlock                       unlock the secret vault for this daemon
  dbrex set-password <conn>          store a password for a connection
  dbrex results [n]                  recent stored results
  dbrex install-duckdb              add DuckDB, needed to query object stores
  dbrex mcp                          serve MCP over stdio (for AI agents)
  dbrex stop                         stop the daemon

  --workspace <dir>   speak for a workspace, so its .dbrex/connections.json applies
`;

export async function main(argv: readonly string[]): Promise<number> {
  const args = [...argv];
  const workspace = takeOption(args, '--workspace');
  const command = args.shift();

  if (command === undefined || command === 'help' || command === '--help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command === '--version') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (command === 'mcp') {
    await runMcpBridge({ version: VERSION, ...(workspace === undefined ? {} : { workspace }) });
    return 0;
  }

  try {
    return await run(command, args, workspace);
  } catch (e) {
    process.stderr.write(`dbrex: ${messageOf(e)}\n`);
    if (DbRexError.is(e) && e.details.hint) process.stderr.write(`  ${e.details.hint}\n`);
    return 1;
  }
}

async function run(command: string, args: string[], workspace?: string): Promise<number> {
  const socket = socketPath();

  if (command === 'status') {
    if (!(await isListening(socket))) {
      process.stdout.write(`daemon: not running (${socket})\n`);
      return 0;
    }
    const client = await attach(socket, workspace);
    try {
      const vault = await client.call({ op: 'vaultStatus' });
      const { connections } = await client.call({ op: 'listConnections' });
      process.stdout.write(`daemon:      running (${socket})\n`);
      process.stdout.write(`vault:       ${vault.exists ? (vault.unlocked ? 'unlocked' : 'locked') : 'empty'}\n`);
      process.stdout.write(`connections: ${connections.length}\n`);
      return 0;
    } finally {
      client.close();
    }
  }

  if (command === 'install-duckdb') {
    return installDuckDB(configDir());
  }

  if (command === 'stop') {
    if (!(await isListening(socket))) {
      process.stdout.write('daemon: not running\n');
      return 0;
    }
    // The daemon exits when it has been idle; there is no kill switch on the
    // protocol on purpose, so one client cannot end another client's session.
    process.stdout.write('the daemon stops on its own once every client detaches\n');
    return 0;
  }

  await ensureDaemon({ socketPath: socket, daemonPath: daemonPath() });
  const client = await attach(socket, workspace);

  try {
    switch (command) {
      case 'connections': {
        const { connections } = await client.call({ op: 'listConnections' });
        printConnections(connections);
        return 0;
      }

      case 'unlock': {
        const status = await client.call({ op: 'vaultStatus' });
        if (status.unlocked) {
          process.stdout.write('vault is already unlocked\n');
          return 0;
        }
        const passphrase = await askHidden('Vault passphrase: ');
        await client.call({ op: 'unlock', passphrase });
        process.stdout.write('vault unlocked\n');
        return 0;
      }

      case 'set-password': {
        const connection = required(args.shift(), 'a connection name');
        const value = await askHidden(`Password for "${connection}": `);
        await client.call({ op: 'setSecret', connection, value });
        process.stdout.write('stored\n');
        return 0;
      }

      case 'results': {
        const limit = Number.parseInt(args.shift() ?? '20', 10);
        const { results } = await client.call({ op: 'listResults', limit });
        for (const r of results) {
          process.stdout.write(
            `${r.resultId}  ${r.pinned ? 'pin' : '   '}  ${String(r.rowCount).padStart(8)} rows  ` +
            `${r.connection}  ${r.sql.replace(/\s+/g, ' ').slice(0, 60)}\n`,
          );
        }
        return 0;
      }

      case 'browse': {
        const connection = required(args.shift(), 'a connection name');
        const { nodes } = await client.call({ op: 'browse', connection, path: args });
        for (const node of nodes) {
          process.stdout.write(`${node.kind.padEnd(9)} ${node.name}${node.detail ? `  ${node.detail}` : ''}\n`);
        }
        return 0;
      }

      case 'query': {
        const connection = required(args.shift(), 'a connection name');
        const statements = readStatements(args);
        for (const statement of statements) {
          await runOne(client, statement.connection ?? connection, statement.sql, statement.limit);
        }
        return 0;
      }

      default:
        process.stderr.write(`dbrex: unknown command "${command}"\n\n${USAGE}`);
        return 2;
    }
  } finally {
    client.close();
  }
}

/** A terminal client answers prompts; that is the whole point of running one. */
async function attach(socket: string, workspace?: string): Promise<DbRexClient> {
  return DbRexClient.connect(
    {
      socketPath: socket,
      role: 'tty',
      client: 'dbrex-cli',
      ensure: () => ensureDaemon({ socketPath: socket, daemonPath: daemonPath() }),
      ...(workspace === undefined ? {} : { workspace }),
    },
    {
      onInteraction: async ({ detail }) => {
        switch (detail.kind) {
          case 'secret':
          case 'unlock':
            // Only when someone is actually watching this terminal. A piped
            // `dbrex query` in a script must fail, not block forever.
            if (!process.stdin.isTTY) return undefined;
            return askHidden(`${detail.prompt}: `);
          case 'browser':
            process.stderr.write(`\n${detail.reason}\nOpen: ${detail.url}\n\n`);
            return true;
        }
      },
    },
  );
}

async function runOne(client: DbRexClient, connection: string, sql: string, limit?: number): Promise<void> {
  const result = await client.query({
    op: 'query',
    connection,
    sql,
    ...(limit === undefined ? {} : { rowLimit: limit }),
  });
  const page = await client.call({
    op: 'readRows',
    resultId: result.resultId,
    offset: 0,
    limit: Math.min(result.rowCount, 1_000),
  });
  printTable(result.columns.map(c => c.name), page.rows);
  process.stdout.write(
    `${result.rowCount} row${result.rowCount === 1 ? '' : 's'}` +
    `${result.stats.truncated ? ' (truncated)' : ''} in ${result.stats.elapsedMs}ms  [${result.resultId}]\n`,
  );
}

interface CliStatement {
  readonly sql: string;
  readonly connection?: string;
  readonly limit?: number;
}

/** Statements from the command line or a file, with directives applied. */
function readStatements(args: string[]): CliStatement[] {
  const fileFlag = args.indexOf('-f');
  if (fileFlag === -1) {
    const sql = args.join(' ').trim();
    if (sql.length === 0) throw new DbRexError('config', 'no SQL given');
    return [{ sql }];
  }

  const file = args[fileFlag + 1];
  if (file === undefined) throw new DbRexError('config', '-f needs a file');
  const text = fs.readFileSync(file, 'utf8');

  return splitSql(text).map(statement => {
    const config = configAt(text, statement.codeStart);
    return {
      sql: statement.sql,
      ...(config.connection === undefined ? {} : { connection: config.connection }),
      ...(config.limit === undefined ? {} : { limit: config.limit }),
    };
  });
}

function printConnections(connections: readonly ConnectionInfo[]): void {
  if (connections.length === 0) {
    process.stdout.write('no connections configured\n');
    return;
  }
  for (const c of connections) {
    process.stdout.write(
      `${c.name.padEnd(20)} ${c.kind.padEnd(11)} ${c.origin.padEnd(9)} ` +
      `${c.ready ? 'ready' : 'needs a human'}\n`,
    );
    if (c.reference) process.stdout.write(`  ${c.reference}\n`);
  }
}

function printTable(columns: readonly string[], rows: readonly (readonly unknown[])[]): void {
  if (columns.length === 0) return;
  const widths = columns.map((name, i) =>
    Math.min(60, Math.max(name.length, ...rows.map(row => cell(row[i]).length), 0)));

  const line = (values: readonly string[]): string =>
    values.map((v, i) => v.padEnd(widths[i] ?? 0)).join('  ').trimEnd();

  process.stdout.write(`${line(columns)}\n`);
  process.stdout.write(`${widths.map(w => '-'.repeat(w)).join('  ')}\n`);
  for (const row of rows) {
    process.stdout.write(`${line(columns.map((_, i) => truncate(cell(row[i]), widths[i] ?? 0)))}\n`);
  }
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function truncate(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

function required(value: string | undefined, what: string): string {
  if (value === undefined) throw new DbRexError('config', `expected ${what}`);
  return value;
}

function takeOption(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  const value = args[at + 1];
  args.splice(at, value === undefined ? 1 : 2);
  return value;
}

/** Read a line without echoing it. */
function askHidden(prompt: string): Promise<string> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const output = rl as unknown as { output?: NodeJS.WriteStream; _writeToOutput?: (text: string) => void };
    output._writeToOutput = (text: string) => {
      // Echo the prompt itself, swallow whatever is typed after it.
      if (text.startsWith(prompt)) output.output?.write(prompt);
    };
    rl.question(prompt, answer => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

/* c8 ignore start — process wiring */
if (require.main === module) {
  main(process.argv.slice(2))
    .then(code => { process.exitCode = code; })
    .catch((e: unknown) => {
      process.stderr.write(`dbrex: ${messageOf(e)}\n`);
      process.exitCode = 1;
    });
}
/* c8 ignore stop */
