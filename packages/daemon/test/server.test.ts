/**
 * End-to-end tests over a real Unix socket with a fake provider.
 *
 * These are the tests that would have caught the old design's central bug: the
 * MCP path bypassed the UI's credential handling, so an agent querying a
 * connection that needed a password got an opaque driver error instead of a
 * password box. Here an agent's query and a VSCode window's password prompt are
 * exercised together, because that interaction is the product.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DbRexError,
  capabilities,
  type Chunk,
  type Provider,
  type ProviderIo,
  type QueryOptions,
  type QueryStats,
  type Session,
} from '@dbrex/core';
import { DbRexClient, type ConnectOptions } from '@dbrex/client';
import { Broker } from '../src/broker';
import { ConnectionRegistry } from '../src/connections';
import { Logger } from '../src/log';
import { ProviderRegistry } from '../src/providers/registry';
import { SecretResolver } from '../src/secrets';
import { Server, type ServerDeps } from '../src/server';
import { SessionPool } from '../src/sessions';
import { ResultStore } from '../src/store/results';
import { Vault } from '../src/vault';

/** Rows the fake provider serves; enough to cross the progress-event threshold. */
const ROWS = Array.from({ length: 2_500 }, (_, i) => [i, `row-${i}`]);

interface FakeState {
  /** Passwords the provider was handed, in order. */
  readonly passwordsSeen: string[];
  opened: number;
  closed: number;
  passwordsRequested: number;
  lastSql?: string;
  aborted: boolean;
  /** Milliseconds between chunks, so a query can be cancelled mid-flight. */
  chunkDelayMs: number;
}

function fakeProvider(
  state: FakeState,
  opts: { needsPassword: boolean; accepts?: string },
): Provider {
  return {
    id: 'fake',
    displayName: 'Fake',
    capabilities: capabilities({ limit: 'limit', streams: true, browse: true, validate: true }),
    fields: [
      { name: 'host', type: 'string', description: 'Host', required: true },
      { name: 'port', type: 'number', description: 'Port', default: 1234 },
    ],
    async open(_spec, _endpoint, io: ProviderIo): Promise<Session> {
      if (opts.needsPassword) {
        state.passwordsRequested++;
        const password = await io.secret({ kind: 'password' });
        state.passwordsSeen.push(password);
        if (opts.accepts !== undefined && password !== opts.accepts) {
          throw new DbRexError('auth', 'password rejected by the server', { retryable: true });
        }
      }
      state.opened++;
      return {
        async *query(sql: string, options?: QueryOptions): AsyncGenerator<Chunk, QueryStats, void> {
          state.lastSql = sql;
          const started = Date.now();
          const limit = /LIMIT (\d+)/.exec(sql)?.[1];
          const all = limit ? ROWS.slice(0, Number(limit)) : ROWS;
          let sent = 0;
          let first = true;

          for (let i = 0; i < all.length; i += 500) {
            if (options?.signal?.aborted) {
              state.aborted = true;
              throw Object.assign(new Error('query cancelled'), { name: 'AbortError' });
            }
            if (state.chunkDelayMs > 0) await new Promise(r => setTimeout(r, state.chunkDelayMs));
            const rows = all.slice(i, i + 500);
            sent += rows.length;
            yield first
              ? { columns: [{ name: 'id', type: 'Int' }, { name: 'name', type: 'String' }], rows }
              : { rows };
            first = false;
          }
          return { elapsedMs: Date.now() - started, truncated: sent < ROWS.length };
        },
        async browse(pathParts) {
          return pathParts.length === 0
            ? [{ kind: 'database' as const, name: 'main', hasChildren: true }]
            : [{ kind: 'table' as const, name: 'events', hasChildren: true }];
        },
        async validate(sql: string) {
          return sql.includes('SELCT')
            ? [{ message: 'syntax error', severity: 'error' as const }]
            : [];
        },
        async close() { state.closed++; },
      };
    },
  };
}

let home: string;
let workspace: string;
let server: Server;
let deps: ServerDeps;
let state: FakeState;
let socketPath: string;
const clients: DbRexClient[] = [];

async function boot(
  options: { needsPassword?: boolean; accepts?: string; showAgentResults?: boolean } = {},
): Promise<void> {
  state = { opened: 0, closed: 0, passwordsRequested: 0, aborted: false, chunkDelayMs: 0, passwordsSeen: [] };
  const providers = new ProviderRegistry([fakeProvider(state, {
    needsPassword: options.needsPassword ?? false,
    ...(options.accepts === undefined ? {} : { accepts: options.accepts }),
  })]);
  const logger = new Logger({ dir: path.join(home, 'logs'), level: 'error', retentionDays: 1, maxTotalBytes: 1e6, echo: false });
  const connections = new ConnectionRegistry(providers, { configDir: path.join(home, '.dbrex'), home, env: {} });
  const vault = Vault.open(path.join(home, '.dbrex'));
  const broker = new Broker({ timeoutMs: 3_000 });
  const secrets = new SecretResolver(vault, broker);
  const sessions = new SessionPool(providers, secrets, broker, logger);
  const store = new ResultStore(path.join(home, 'cache'), { mode: 'sliding', maxBytes: 50_000_000 });

  socketPath = path.join(home, 'run', 'dbrexd.sock');
  deps = {
    socketPath, version: '0.1.0-test', logger, providers, connections,
    sessions, secrets, store, broker, vault,
    showAgentResults: () => options.showAgentResults ?? true,
  };
  server = new Server(deps);
  await server.listen();
}

async function connect(over: Partial<ConnectOptions> = {}, events = {}): Promise<DbRexClient> {
  const client = await DbRexClient.connect(
    { socketPath, role: 'ui', client: 'test', ...over },
    events,
  );
  clients.push(client);
  return client;
}

function writeConnections(dir: string, body: unknown): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'connections.json'), JSON.stringify(body));
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dbrex-server-'));
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dbrex-server-ws-'));
  writeConnections(path.join(home, '.dbrex'), {
    connections: [{ name: 'prod', kind: 'fake', host: 'db.example', reference: 'the production database' }],
  });
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await server?.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('handshake', () => {
  it('creates the socket at mode 0600 inside a 0700 directory', async () => {
    await boot();
    expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(socketPath)).mode & 0o777).toBe(0o700);
  });

  it('reports its version and protocol', async () => {
    await boot();
    const client = await connect();
    // `connect` already said hello; asking again proves the handshake is idempotent.
    const hello = await client.call({ op: 'hello', protocol: 1, role: 'ui', client: 'test' });
    expect(hello).toMatchObject({ daemonVersion: '0.1.0-test', protocol: 1 });
  });

  it('refuses a client speaking a different protocol', async () => {
    await boot();
    await expect(DbRexClient.connect({ socketPath, role: 'ui', client: 'old' }, {}))
      .resolves.toBeDefined();

    const raw = await connect();
    await expect(raw.call({ op: 'hello', protocol: 99, role: 'ui', client: 'from-the-future' }))
      .rejects.toMatchObject({ code: 'config' });
  });

  it('refuses to start when a live daemon already holds the socket', async () => {
    await boot();
    // A stale socket from a killed daemon must be cleared, but a socket a live
    // daemon owns must not be — otherwise starting a second one silently steals
    // every client from the first.
    await expect(new Server(deps).listen()).rejects.toMatchObject({ code: 'config' });
  });
});

describe('connections', () => {
  it('lists connections with their capabilities and reference text', async () => {
    await boot();
    const client = await connect();
    const { connections } = await client.call({ op: 'listConnections' });
    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({
      name: 'prod',
      kind: 'fake',
      origin: 'global',
      reference: 'the production database',
    });
    expect(connections[0]!.capabilities.limit).toBe('limit');
  });

  it('shows a workspace connection only to the client that named that workspace', async () => {
    await boot();
    writeConnections(path.join(workspace, '.dbrex'), {
      connections: [{ name: 'local', kind: 'fake', host: '127.0.0.1' }],
    });

    const inWorkspace = await connect({ workspace });
    const elsewhere = await connect();

    const mine = await inWorkspace.call({ op: 'listConnections' });
    const theirs = await elsewhere.call({ op: 'listConnections' });

    expect(mine.connections.map(c => c.name).sort()).toEqual(['local', 'prod']);
    expect(theirs.connections.map(c => c.name)).toEqual(['prod']);
  });

  it('describes providers so a client can build a connection form', async () => {
    await boot();
    const client = await connect();
    const { providers } = await client.call({ op: 'describeProviders' });
    expect(providers[0]!.fields.map(f => f.name)).toEqual(['host', 'port']);
  });

  it('names an unknown connection as not_found', async () => {
    await boot();
    const client = await connect();
    await expect(client.query({ op: 'query', connection: 'nope', sql: 'SELECT 1' }))
      .rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('queries', () => {
  it('stores rows and serves them back by page', async () => {
    await boot();
    const client = await connect();
    const result = await client.query({ op: 'query', connection: 'prod', sql: 'SELECT * FROM events' });

    expect(result.rowCount).toBe(ROWS.length);
    expect(result.columns.map(c => c.name)).toEqual(['id', 'name']);

    const page = await client.call({ op: 'readRows', resultId: result.resultId, offset: 1_000, limit: 3 });
    expect(page.rows).toEqual([[1000, 'row-1000'], [1001, 'row-1001'], [1002, 'row-1002']]);
    expect(page.total).toBe(ROWS.length);
  });

  it('pushes a row limit into the SQL, the only way to make the engine stop', async () => {
    await boot();
    const client = await connect();
    const result = await client.query({
      op: 'query', connection: 'prod', sql: 'SELECT * FROM events', rowLimit: 10,
    });
    expect(state.lastSql).toBe('SELECT * FROM events LIMIT 10');
    expect(result.rowCount).toBe(10);
  });

  it('reports progress while rows stream in', async () => {
    await boot();
    const seen: number[] = [];
    const client = await connect({}, { onQueryProgress: (_id: number, rows: number) => seen.push(rows) });
    await client.query({ op: 'query', connection: 'prod', sql: 'SELECT * FROM events' });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)).toBeLessThanOrEqual(ROWS.length);
  });

  it('cancels a running query and drops the session that ran it', async () => {
    await boot();
    state.chunkDelayMs = 30;
    const client = await connect();

    let requestId = 0;
    const running = client.query(
      { op: 'query', connection: 'prod', sql: 'SELECT * FROM events' },
      id => { requestId = id; },
    );
    await new Promise(r => setTimeout(r, 50));
    await client.cancel(requestId);

    await expect(running).rejects.toMatchObject({ code: 'cancelled' });
    expect(state.aborted).toBe(true);
    // A cancelled query can leave the driver's socket unusable, so the session
    // must not stay in the pool: the old code only repaired this on the UI path.
    expect(state.closed).toBe(1);
  });

  it('leaves no partial result behind after a cancellation', async () => {
    await boot();
    state.chunkDelayMs = 30;
    const client = await connect();

    let requestId = 0;
    const running = client.query(
      { op: 'query', connection: 'prod', sql: 'SELECT * FROM events' },
      id => { requestId = id; },
    );
    await new Promise(r => setTimeout(r, 50));
    await client.cancel(requestId);
    await running.catch(() => {});

    const { results } = await client.call({ op: 'listResults' });
    expect(results).toEqual([]);
  });

  it('reuses one session for many queries', async () => {
    await boot();
    const client = await connect();
    await client.query({ op: 'query', connection: 'prod', sql: 'SELECT 1' });
    await client.query({ op: 'query', connection: 'prod', sql: 'SELECT 2' });
    expect(state.opened).toBe(1);
  });

  it('opens one session when two clients query at the same moment', async () => {
    await boot();
    const a = await connect();
    const b = await connect();
    await Promise.all([
      a.query({ op: 'query', connection: 'prod', sql: 'SELECT 1' }),
      b.query({ op: 'query', connection: 'prod', sql: 'SELECT 2' }),
    ]);
    // The old pool awaited a connect before writing its cache, so a race like
    // this opened two connections and leaked one.
    expect(state.opened).toBe(1);
  });
});

describe('browse and validate', () => {
  it('walks the tree', async () => {
    await boot();
    const client = await connect();
    expect((await client.call({ op: 'browse', connection: 'prod', path: [] })).nodes[0]!.name).toBe('main');
    expect((await client.call({ op: 'browse', connection: 'prod', path: ['main'] })).nodes[0]!.name).toBe('events');
  });

  it('returns diagnostics for a bad statement', async () => {
    await boot();
    const client = await connect();
    const { diagnostics } = await client.call({ op: 'validate', connection: 'prod', sql: 'SELCT 1' });
    expect(diagnostics).toHaveLength(1);
  });
});

describe('results', () => {
  it('broadcasts a save to every attached client', async () => {
    await boot();
    const changes: string[] = [];
    const watcher = await connect({}, { onResultsChanged: (change: string) => changes.push(change) });
    const worker = await connect();

    await worker.query({ op: 'query', connection: 'prod', sql: 'SELECT 1' });
    await new Promise(r => setTimeout(r, 20));

    expect(changes).toContain('saved');
    expect(watcher).toBeDefined();
  });

  it('pins and deletes', async () => {
    await boot();
    const client = await connect();
    const { resultId } = await client.query({ op: 'query', connection: 'prod', sql: 'SELECT 1' });

    await client.call({ op: 'pinResult', resultId, pinned: true });
    expect((await client.call({ op: 'listResults' })).results[0]!.pinned).toBe(true);

    await client.call({ op: 'deleteResult', resultId });
    expect((await client.call({ op: 'listResults' })).results).toEqual([]);
  });
});

describe('credentials across roles', () => {
  it('routes an agent\'s password prompt to a VSCode window', async () => {
    await boot({ needsPassword: true });

    const prompts: string[] = [];
    await connect({ role: 'ui', client: 'vscode' }, {
      onInteraction: async ({ detail }: { detail: { kind: string; prompt?: string } }) => {
        prompts.push(detail.prompt ?? detail.kind);
        return 'hunter2';
      },
    });
    const agent = await connect({ role: 'agent', client: 'claude' });

    const result = await agent.query({ op: 'query', connection: 'prod', sql: 'SELECT 1' });

    // This is the shape of the whole architecture in one assertion: the agent
    // ran the query, the human answered for it, and neither had to know about
    // the other.
    expect(result.rowCount).toBe(ROWS.length);
    expect(prompts).toEqual(['Password for connection "prod"']);
  });

  it('fails an agent\'s query with a clear code when no human is attached', async () => {
    await boot({ needsPassword: true });
    const agent = await connect({ role: 'agent', client: 'claude' });
    await expect(agent.query({ op: 'query', connection: 'prod', sql: 'SELECT 1' }))
      .rejects.toMatchObject({ code: 'auth_interaction_required' });
  });

  it('refuses to take a secret from an agent', async () => {
    await boot();
    const agent = await connect({ role: 'agent', client: 'claude' });
    await expect(agent.call({ op: 'setSecret', connection: 'prod', value: 'typed-into-a-chat' }))
      .rejects.toMatchObject({ code: 'forbidden' });
  });

  it('refuses to let an agent unlock the vault', async () => {
    await boot();
    const agent = await connect({ role: 'agent', client: 'claude' });
    await expect(agent.call({ op: 'unlock', passphrase: 'guess' }))
      .rejects.toMatchObject({ code: 'forbidden' });
  });

  it('accepts a secret from a terminal client and reopens the session with it', async () => {
    await boot({ needsPassword: true });
    const cli = await connect({ role: 'tty', client: 'dbrex-cli' });
    await cli.call({ op: 'setSecret', connection: 'prod', value: 'from-the-cli' });

    const agent = await connect({ role: 'agent', client: 'claude' });
    await expect(agent.query({ op: 'query', connection: 'prod', sql: 'SELECT 1' })).resolves.toBeDefined();
    expect(state.passwordsRequested).toBe(1);
  });

  it('reports vault state', async () => {
    await boot();
    const client = await connect();
    expect(await client.call({ op: 'vaultStatus' })).toMatchObject({ unlocked: true });
  });
});

describe('configuration reloads', () => {
  it('re-reads the files and tells every client', async () => {
    await boot();
    let announced: readonly { name: string }[] = [];
    const watcher = await connect({}, {
      onConnectionsChanged: (connections: readonly { name: string }[]) => { announced = connections; },
    });

    writeConnections(path.join(home, '.dbrex'), {
      connections: [
        { name: 'prod', kind: 'fake', host: 'db.example' },
        { name: 'replica', kind: 'fake', host: 'replica.example' },
      ],
    });
    await watcher.call({ op: 'reloadConnections' });
    await new Promise(r => setTimeout(r, 20));

    expect(announced.map(c => c.name).sort()).toEqual(['prod', 'replica']);
  });
});

describe('a credential the server rejects', () => {
  it('is discarded, and the user is asked again', async () => {
    await boot({ needsPassword: true, accepts: 'correct' });

    const answers = ['correct'];
    await connect({ role: 'ui', client: 'vscode' }, {
      onInteraction: async () => answers.shift(),
    });

    // A password typed wrongly once used to be permanent: it sat in the vault,
    // every later attempt reused it, and the connection stayed broken until the
    // user found the Set Password command.
    const cli = await connect({ role: 'tty', client: 'dbrex-cli' });
    await cli.call({ op: 'setSecret', connection: 'prod', value: 'wrong' });

    const result = await cli.query({ op: 'query', connection: 'prod', sql: 'SELECT 1' });

    expect(result.rowCount).toBeGreaterThan(0);
    expect(state.passwordsSeen).toEqual(['wrong', 'correct']);
  });

  it('keeps asking while the user keeps trying, and gets there in the end', async () => {
    await boot({ needsPassword: true, accepts: 'correct' });

    const answers = ['also-wrong', 'correct'];
    await connect({ role: 'ui', client: 'vscode' }, {
      onInteraction: async () => answers.shift(),
    });
    const cli = await connect({ role: 'tty', client: 'dbrex-cli' });
    await cli.call({ op: 'setSecret', connection: 'prod', value: 'wrong' });

    await expect(cli.query({ op: 'query', connection: 'prod', sql: 'SELECT 1' }))
      .resolves.toMatchObject({ rowCount: ROWS.length });
    expect(state.passwordsSeen).toEqual(['wrong', 'also-wrong', 'correct']);
  });

  it('gives up after three, rather than hammering the server', async () => {
    await boot({ needsPassword: true, accepts: 'correct' });

    await connect({ role: 'ui', client: 'vscode' }, {
      onInteraction: async () => 'still-wrong',
    });
    const cli = await connect({ role: 'tty', client: 'dbrex-cli' });
    await cli.call({ op: 'setSecret', connection: 'prod', value: 'wrong' });

    await expect(cli.query({ op: 'query', connection: 'prod', sql: 'SELECT 1' }))
      .rejects.toMatchObject({ code: 'auth' });
    // An unbounded retry loop against a real server is how accounts get locked.
    expect(state.passwordsSeen).toEqual(['wrong', 'still-wrong', 'still-wrong']);
  });

  it('tells the user why it is asking again', async () => {
    await boot({ needsPassword: true, accepts: 'correct' });

    const prompts: string[] = [];
    const answers = ['correct'];
    await connect({ role: 'ui', client: 'vscode' }, {
      onInteraction: async ({ detail }: { detail: { prompt?: string } }) => {
        if (detail.prompt !== undefined) prompts.push(detail.prompt);
        return answers.shift();
      },
    });
    const cli = await connect({ role: 'tty', client: 'dbrex-cli' });
    await cli.call({ op: 'setSecret', connection: 'prod', value: 'wrong' });

    await cli.query({ op: 'query', connection: 'prod', sql: 'SELECT 1' });

    // Being asked a second time with no explanation is indistinguishable from
    // the application being broken.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('password rejected by the server');
  });

  it('stops when the user declines, instead of reopening the box', async () => {
    await boot({ needsPassword: true, accepts: 'correct' });

    let asked = 0;
    await connect({ role: 'ui', client: 'vscode' }, {
      onInteraction: async () => {
        asked++;
        return undefined;  // the user pressed Escape
      },
    });
    const cli = await connect({ role: 'tty', client: 'dbrex-cli' });

    await expect(cli.query({ op: 'query', connection: 'prod', sql: 'SELECT 1' }))
      .rejects.toMatchObject({ code: 'auth_interaction_required' });
    // Refusing to take no for an answer would make the prompt impossible to
    // dismiss; the next attempt asks again, because nothing was stored.
    expect(asked).toBe(1);
  });

  it('surfaces the failure to an agent as an auth error it can explain', async () => {
    await boot({ needsPassword: true, accepts: 'correct' });
    const agent = await connect({ role: 'agent', client: 'claude' });
    await expect(agent.query({ op: 'query', connection: 'prod', sql: 'SELECT 1' }))
      .rejects.toMatchObject({ code: 'auth_interaction_required' });
  });
});

describe('an agent working while you watch', () => {
  it('puts its result on the screens that are attached', async () => {
    await boot();
    const shown: string[] = [];
    await connect({ role: 'ui', client: 'vscode' }, {
      onShowResult: (resultId: string) => shown.push(resultId),
    });
    const agent = await connect({ role: 'agent', client: 'claude' });

    const result = await agent.query({ op: 'query', connection: 'prod', sql: 'SELECT 1' });
    await new Promise(r => setTimeout(r, 20));

    // Work you cannot see is work you cannot check. The previous generation
    // pushed these into the panel too; the difference is that this carries a
    // result id and nothing executable.
    expect(shown).toEqual([result.resultId]);
  });

  it('does not push a human\'s own query back at them', async () => {
    await boot();
    const shown: string[] = [];
    const ui = await connect({ role: 'ui', client: 'vscode' }, {
      onShowResult: (resultId: string) => shown.push(resultId),
    });

    await ui.query({ op: 'query', connection: 'prod', sql: 'SELECT 1' });
    await new Promise(r => setTimeout(r, 20));

    expect(shown).toEqual([]);
  });

  it('stays quiet when the setting is off', async () => {
    await boot({ showAgentResults: false });
    const shown: string[] = [];
    await connect({ role: 'ui', client: 'vscode' }, {
      onShowResult: (resultId: string) => shown.push(resultId),
    });
    const agent = await connect({ role: 'agent', client: 'claude' });

    await agent.query({ op: 'query', connection: 'prod', sql: 'SELECT 1' });
    await new Promise(r => setTimeout(r, 20));

    expect(shown).toEqual([]);
  });
});
