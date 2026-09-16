import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ClientRole, DaemonMessage, Event, SecretPurpose } from '@dbrex/core';
import { Broker, type ClientHandle } from '../src/broker';
import { SecretResolver } from '../src/secrets';
import { Vault } from '../src/vault';
import type { RegisteredConnection } from '../src/connections';

const PASSWORD: SecretPurpose = { kind: 'password' };
const TOKEN: SecretPurpose = { kind: 'token', label: 'Trino SSO token' };

function connection(over: Partial<RegisteredConnection['spec']> = {}, scope = 'global'): RegisteredConnection {
  return {
    spec: { name: 'prod', kind: 'fake', options: {}, ...over },
    origin: 'global',
    secretScope: scope,
  };
}

/** A client that answers every prompt with the same value. */
function answering(broker: Broker, role: ClientRole, value: string): ClientHandle {
  const handle: ClientHandle = {
    id: Math.floor(Math.random() * 1e6),
    role,
    label: role,
    send: (message: DaemonMessage) => {
      const event = message as Event;
      if (event.event === 'interaction') {
        setImmediate(() => broker.reply(handle.id, event.interactionId, value));
      }
    },
  };
  broker.attach(handle);
  return handle;
}

let dir: string;
let vault: Vault;
let broker: Broker;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbrex-secrets-'));
  vault = Vault.open(dir);
  broker = new Broker({ timeoutMs: 2_000 });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env['DBREX_TEST_SECRET'];
});

describe('command source', () => {
  it('runs the command and trims its output', async () => {
    const seen: string[][] = [];
    const resolver = new SecretResolver(vault, broker, async argv => {
      seen.push([...argv]);
      return 'from-1password\n';
    });

    const conn = connection({ secret: { from: 'command', argv: ['op', 'read', 'op://x'] } });
    await expect(resolver.require(conn, PASSWORD)).resolves.toBe('from-1password');
    expect(seen).toEqual([['op', 'read', 'op://x']]);
  });

  it('does not copy the value into the vault', async () => {
    const resolver = new SecretResolver(vault, broker, async () => 'external');
    const conn = connection({ secret: { from: 'command', argv: ['op', 'read', 'x'] } });

    await resolver.require(conn, PASSWORD);
    await resolver.remember(conn, PASSWORD, 'external');

    // The command owns this secret. A vault copy would become a second source
    // of truth that silently wins after the real one is rotated.
    expect(vault.keys()).toEqual([]);
  });

  it('reports empty output as a config problem naming the command', async () => {
    const resolver = new SecretResolver(vault, broker, async () => '  \n');
    const conn = connection({ secret: { from: 'command', argv: ['op', 'read', 'x'] } });
    await expect(resolver.require(conn, PASSWORD)).rejects.toMatchObject({
      code: 'config',
      details: { hint: 'command: op read x' },
    });
  });
});

describe('env source', () => {
  it('reads the daemon\'s environment', async () => {
    process.env['DBREX_TEST_SECRET'] = 'from-env';
    const resolver = new SecretResolver(vault, broker);
    const conn = connection({ secret: { from: 'env', name: 'DBREX_TEST_SECRET' } });
    await expect(resolver.require(conn, PASSWORD)).resolves.toBe('from-env');
  });

  it('says whose environment it reads when the variable is missing', async () => {
    const resolver = new SecretResolver(vault, broker);
    const conn = connection({ secret: { from: 'env', name: 'DBREX_TEST_SECRET' } });
    await expect(resolver.require(conn, PASSWORD)).rejects.toMatchObject({ code: 'config' });
  });
});

describe('vault source', () => {
  it('never prompts, and fails when nothing is stored', async () => {
    answering(broker, 'ui', 'typed-by-a-human');
    const resolver = new SecretResolver(vault, broker);
    const conn = connection({ secret: { from: 'vault' } });

    // `from: vault` is an explicit statement that this connection's secret is
    // put there deliberately, so a miss is an error rather than a prompt.
    await expect(resolver.require(conn, PASSWORD)).rejects.toMatchObject({ code: 'auth' });
  });

  it('returns a stored value', async () => {
    const resolver = new SecretResolver(vault, broker);
    const conn = connection({ secret: { from: 'vault' } });
    vault.set(resolver.slot(conn, PASSWORD), 'stored');
    await expect(resolver.require(conn, PASSWORD)).resolves.toBe('stored');
  });
});

describe('prompt source (the default)', () => {
  it('prefers the vault and does not ask', async () => {
    let asked = 0;
    const handle: ClientHandle = {
      id: 1, role: 'ui', label: 'ui',
      send: m => { if ((m as Event).event === 'interaction') asked++; },
    };
    broker.attach(handle);

    const resolver = new SecretResolver(vault, broker);
    const conn = connection();
    vault.set(resolver.slot(conn, PASSWORD), 'stored');

    await expect(resolver.require(conn, PASSWORD)).resolves.toBe('stored');
    expect(asked).toBe(0);
  });

  it('asks a human on a miss and remembers the answer', async () => {
    answering(broker, 'ui', 'typed');
    const resolver = new SecretResolver(vault, broker);
    const conn = connection();

    await expect(resolver.require(conn, PASSWORD)).resolves.toBe('typed');
    expect(vault.get(resolver.slot(conn, PASSWORD))).toBe('typed');
  });

  it('lookup never prompts, even when nothing is stored', async () => {
    let asked = 0;
    broker.attach({
      id: 1, role: 'ui', label: 'ui',
      send: m => { if ((m as Event).event === 'interaction') asked++; },
    });

    const resolver = new SecretResolver(vault, broker);
    await expect(resolver.lookup(connection(), TOKEN)).resolves.toBeUndefined();
    expect(asked).toBe(0);
  });

  it('fails with auth_interaction_required when only an agent is attached', async () => {
    answering(broker, 'agent', 'agent-should-never-answer');
    const resolver = new SecretResolver(vault, broker);
    await expect(resolver.require(connection(), PASSWORD))
      .rejects.toMatchObject({ code: 'auth_interaction_required' });
  });
});

describe('token storage', () => {
  it('stores a token a provider obtained by itself, under its own slot', async () => {
    const resolver = new SecretResolver(vault, broker);
    const conn = connection();

    await resolver.remember(conn, TOKEN, 'jwt-value');

    expect(await resolver.lookup(conn, TOKEN)).toBe('jwt-value');
    expect(await resolver.lookup(conn, PASSWORD)).toBeUndefined();
  });
});

describe('slot scoping', () => {
  it('separates connections that share a name but not an origin', () => {
    const resolver = new SecretResolver(vault, broker);
    const global = connection({}, 'global');
    const workspace = connection({}, 'workspace:/home/marc/repo');
    expect(resolver.slot(global, PASSWORD)).not.toBe(resolver.slot(workspace, PASSWORD));
  });

  it('separates a password from a token on the same connection', () => {
    const resolver = new SecretResolver(vault, broker);
    const conn = connection();
    expect(resolver.slot(conn, PASSWORD)).not.toBe(resolver.slot(conn, TOKEN));
  });
});

describe('locked vault', () => {
  it('asks for the passphrase and then completes the original request', async () => {
    const seeded = Vault.open(dir);
    const resolver0 = new SecretResolver(seeded, broker);
    seeded.set(resolver0.slot(connection(), PASSWORD), 'stored');
    seeded.setPassphrase('open sesame');

    const locked = Vault.open(dir);
    expect(locked.unlocked).toBe(false);

    answering(broker, 'ui', 'open sesame');
    const resolver = new SecretResolver(locked, broker);

    await expect(resolver.require(connection(), PASSWORD)).resolves.toBe('stored');
    expect(locked.unlocked).toBe(true);
  });

  it('surfaces the auth error when nobody can unlock it', async () => {
    const seeded = Vault.open(dir);
    seeded.setPassphrase('pw');

    const locked = Vault.open(dir);
    const resolver = new SecretResolver(locked, broker);
    await expect(resolver.require(connection(), PASSWORD))
      .rejects.toMatchObject({ code: 'auth_interaction_required' });
  });
});
