/**
 * `dbrex` — the terminal client.
 *
 * Small on purpose. Its reason to exist is `dbrex unlock`: it is the piece that
 * lets an agent work with no editor running at all, because a person can answer
 * the one question the daemon cannot answer for itself from any terminal.
 * Everything else here is convenience that falls out of already having a client.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { DbRexClient, ensureDaemon, isListening } from '@dbrex/client';
import {
  DbRexError,
  configAt,
  messageOf,
  splitSql,
  type ConnectionInfo,
} from '@dbrex/core';
import { configDir, daemonPath, socketPath } from './paths';
import { FORMATS, defaultFormat, isFormat, render, type Format } from './format';
import { askHidden, askSecret } from './prompt';
import { runShell } from './shell';
import { installDuckDB } from './duckdb';
import {
  bundleDir,
  defaultLinkDir,
  describe as describeInstall,
  install,
  pathEntries,
} from './install';
import { runMcpBridge } from './mcp';

export const VERSION = '0.1.0';

const USAGE = `dbrex ${VERSION}

  dbrex status                       is the daemon up, is the vault unlocked
  dbrex connections                  list connections and what they are for
  dbrex shell [conn]                 interactive session; Tab completes from the server
  dbrex query <conn> <sql>           run one statement and print the rows
  dbrex query <conn> -f <file.sql>   run a file, honouring -- @conn / -- @limit
  dbrex browse <conn> [path...]      walk the schema tree
  dbrex unlock                       unlock the secret vault for this daemon
  dbrex set-password <conn>          store a password for a connection
  dbrex results [n]                  recent stored results
  dbrex install                     put the dbrex command on PATH
  dbrex install-duckdb              add DuckDB, needed to query object stores
  dbrex mcp                          serve MCP over stdio (for AI agents)
  dbrex stop                         stop the daemon

  --workspace <dir>   speak for a workspace, so its .dbrex/connections.json applies
  --format <name>     ${FORMATS.join(' | ')}. A terminal defaults to table, a pipe to tsv
`;

export async function main(argv: readonly string[]): Promise<number> {
  const args = [...argv];
  const workspace = takeOption(args, '--workspace');
  // Lifted out before the command is taken, or `dbrex --format json query ...`
  // reads `--format` as the command. Validated inside the try below, so a bad
  // value reports itself the way every other bad argument does.
  const format = takeOption(args, '--format');
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
    return await run(command, args, toFormat(format), workspace);
  } catch (e) {
    process.stderr.write(`dbrex: ${messageOf(e)}\n`);
    if (DbRexError.is(e) && e.details.hint) process.stderr.write(`  ${e.details.hint}\n`);
    return 1;
  }
}

async function run(
  command: string,
  args: string[],
  format: Format,
  workspace?: string,
): Promise<number> {
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

  // Before the daemon is reached for: installing is what someone does when
  // nothing works yet, and it must not depend on anything already running.
  if (command === 'install') {
    const report = install({
      from: bundleDir(),
      configDir: configDir(),
      linkDir: defaultLinkDir(),
      pathEntries: pathEntries(),
    });
    process.stdout.write(describeInstall(report));
    return 0;
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

      case 'shell': {
        const name = args.shift() ?? (await firstConnection(client));
        // Awaited, not returned. `return promise` inside this try runs the
        // finally as soon as the promise exists, which closed the client out
        // from under the session on its first statement.
        return await runShell({
          client,
          connection: name,
          format,
          historyFile: path.join(configDir(), 'history'),
          execute: (on, sql, as) => runOne(client, on, sql, as),
        });
      }

      case 'query': {
        const connection = required(args.shift(), 'a connection name');
        const statements = readStatements(args);
        for (const statement of statements) {
          await runOne(client, statement.connection ?? connection, statement.sql, format, statement.limit);
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

/** The only connection there is, when the shell was started without a name. */
async function firstConnection(client: DbRexClient): Promise<string> {
  const { connections } = await client.call({ op: 'listConnections' });
  const only = connections[0];
  if (only === undefined) {
    throw new DbRexError('config', 'no connections are configured', {
      hint: 'add one to ~/.dbrex/connections.json, then run dbrex shell again',
    });
  }
  return only.name;
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
            return askSecret(`${detail.prompt}: `);
          case 'browser':
            process.stderr.write(`\n${detail.reason}\nOpen: ${detail.url}\n\n`);
            return true;
        }
      },
    },
  );
}

async function runOne(
  client: DbRexClient,
  connection: string,
  sql: string,
  format: Format,
  limit?: number,
): Promise<void> {
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
  process.stdout.write(render(result.columns, page.rows, renderOptions(format)));

  // The summary is commentary, not data. Only a terminal gets it; a pipe gets
  // the rows and nothing that would have to be stripped back out again.
  if (process.stdout.isTTY) {
    process.stdout.write(
      `${result.rowCount} row${result.rowCount === 1 ? '' : 's'}` +
      `${result.stats.truncated ? ' (truncated)' : ''} in ${result.stats.elapsedMs}ms  [${result.resultId}]\n`,
    );
  }
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

/**
 * How this result should be drawn.
 *
 * Width and colour come from the real stdout, so redirecting to a file gets a
 * table sized for nothing in particular rather than one wrapped to whatever
 * terminal happened to launch the command.
 */
function renderOptions(format: Format) {
  const tty = process.stdout.isTTY === true;
  return {
    format,
    ...(tty && process.stdout.columns ? { width: process.stdout.columns } : {}),
    ...(tty ? { colour: true } : {}),
  };
}

function toFormat(chosen: string | undefined): Format {
  if (chosen === undefined) return defaultFormat(process.stdout.isTTY === true);
  if (!isFormat(chosen)) {
    throw new DbRexError('config', `unknown format "${chosen}"`, {
      hint: `one of: ${FORMATS.join(', ')}`,
    });
  }
  return chosen;
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
