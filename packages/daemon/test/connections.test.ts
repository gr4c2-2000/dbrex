import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DbRexError, capabilities, type FieldSpec, type Provider } from '@dbrex/core';
import { ConnectionRegistry } from '../src/connections';
import { ProviderRegistry } from '../src/providers/registry';

const FIELDS: FieldSpec[] = [
  { name: 'host', type: 'string', description: 'Host', required: true, substitute: true },
  { name: 'port', type: 'number', description: 'Port', default: 3306 },
  { name: 'user', type: 'string', description: 'User', substitute: true },
];

const fake: Provider = {
  id: 'fake',
  displayName: 'Fake',
  capabilities: capabilities({ limit: 'limit' }),
  fields: FIELDS,
  open: () => { throw new Error('not used in these tests'); },
};

const providers = new ProviderRegistry([fake]);

let home: string;
let workspace: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dbrex-home-'));
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dbrex-ws-'));
  fs.mkdirSync(path.join(home, '.dbrex'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

function writeGlobal(body: unknown): void {
  fs.writeFileSync(path.join(home, '.dbrex', 'connections.json'), JSON.stringify(body));
}

function writeWorkspace(body: unknown): void {
  fs.mkdirSync(path.join(workspace, '.dbrex'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.dbrex', 'connections.json'), JSON.stringify(body));
}

function registry(identityUser = 'marc'): ConnectionRegistry {
  return new ConnectionRegistry(providers, {
    configDir: path.join(home, '.dbrex'),
    identityUser,
    home,
    env: { TOKEN: 'from-env' },
  });
}

describe('loading', () => {
  it('reads a connection and applies declared defaults', () => {
    writeGlobal({ connections: [{ name: 'prod', kind: 'fake', host: 'db.example' }] });
    const found = registry().find('prod');
    expect(found.spec.options).toEqual({ host: 'db.example', port: 3306 });
    expect(found.origin).toBe('global');
  });

  it('accepts engine options nested under "options" as well as at the top level', () => {
    writeGlobal({ connections: [{ name: 'prod', kind: 'fake', options: { host: 'db.example' } }] });
    expect(registry().find('prod').spec.options['host']).toBe('db.example');
  });

  it('substitutes $user, $env and ~ before validating', () => {
    writeGlobal({ connections: [{ name: 'prod', kind: 'fake', host: '$env:TOKEN', user: '$user' }] });
    const spec = registry().find('prod').spec;
    expect(spec.options).toMatchObject({ host: 'from-env', user: 'marc' });
  });

  it('keeps the reference text, which is what an agent reads before querying', () => {
    writeGlobal({
      connections: [{ name: 'prod', kind: 'fake', host: 'db', reference: 'docs: https://wiki/prod' }],
    });
    expect(registry().find('prod').spec.reference).toBe('docs: https://wiki/prod');
  });

  it('reads a secret source and a tunnel', () => {
    writeGlobal({
      connections: [{
        name: 'prod', kind: 'fake', host: 'db',
        secret: { from: 'command', argv: ['op', 'read', 'op://vault/db/password'] },
        tunnel: { host: 'bastion', user: 'marc' },
      }],
    });
    const spec = registry().find('prod').spec;
    expect(spec.secret).toEqual({ from: 'command', argv: ['op', 'read', 'op://vault/db/password'] });
    expect(spec.tunnel).toMatchObject({ host: 'bastion' });
  });

  it('treats a missing file as no connections, not as a problem', () => {
    const r = registry();
    expect(r.visible()).toEqual([]);
    expect(r.loadProblems()).toEqual([]);
  });
});

describe('reporting bad configuration', () => {
  it('reports malformed JSON instead of silently showing an empty list', () => {
    fs.writeFileSync(path.join(home, '.dbrex', 'connections.json'), '{ not json');
    const r = registry();
    expect(r.visible()).toEqual([]);
    // The old loader logged this and returned [], so the user saw "no
    // connections" and had no idea their file was broken.
    expect(r.loadProblems().join('\n')).toMatch(/connections\.json/);
  });

  it('reports a wrong option type and skips only that connection', () => {
    writeGlobal({
      connections: [
        { name: 'bad', kind: 'fake', host: 'db', port: 'not-a-number' },
        { name: 'good', kind: 'fake', host: 'db' },
      ],
    });
    const r = registry();
    expect(r.visible().map(c => c.spec.name)).toEqual(['good']);
    expect(r.loadProblems().join('\n')).toMatch(/port.*must be a number/);
  });

  it('reports an unknown option rather than passing it to the driver', () => {
    writeGlobal({ connections: [{ name: 'prod', kind: 'fake', host: 'db', hsot: 'typo' }] });
    expect(registry().loadProblems().join('\n')).toMatch(/unknown option "hsot"/);
  });

  it('reports a missing required option', () => {
    writeGlobal({ connections: [{ name: 'prod', kind: 'fake' }] });
    expect(registry().loadProblems().join('\n')).toMatch(/required option "host"/);
  });

  it('reports an unknown kind and lists the kinds it has', () => {
    writeGlobal({ connections: [{ name: 'prod', kind: 'oracle', host: 'db' }] });
    expect(registry().loadProblems().join('\n')).toMatch(/unknown kind "oracle".*fake/);
  });

  it('reports a duplicate name and keeps the first', () => {
    writeGlobal({
      connections: [
        { name: 'prod', kind: 'fake', host: 'first' },
        { name: 'prod', kind: 'fake', host: 'second' },
      ],
    });
    const r = registry();
    expect(r.find('prod').spec.options['host']).toBe('first');
    expect(r.loadProblems().join('\n')).toMatch(/duplicate connection name/);
  });

  it('names the unknown connection and lists what it does know', () => {
    writeGlobal({ connections: [{ name: 'prod', kind: 'fake', host: 'db' }] });
    try {
      registry().find('staging');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as DbRexError).code).toBe('not_found');
      expect((e as DbRexError).details.hint).toContain('prod');
    }
  });
});

describe('scoping', () => {
  it('lets a workspace connection shadow a global one of the same name', () => {
    writeGlobal({ connections: [{ name: 'prod', kind: 'fake', host: 'global-host' }] });
    writeWorkspace({ connections: [{ name: 'prod', kind: 'fake', host: 'workspace-host' }] });

    const r = registry();
    expect(r.find('prod', workspace).spec.options['host']).toBe('workspace-host');
    expect(r.find('prod').spec.options['host']).toBe('global-host');
  });

  it('gives a shadowing workspace connection its own secret scope', () => {
    writeGlobal({ connections: [{ name: 'prod', kind: 'fake', host: 'global-host' }] });
    writeWorkspace({ connections: [{ name: 'prod', kind: 'fake', host: 'workspace-host' }] });

    const r = registry();
    // Same name, different database, different password. Sharing a vault slot
    // here would hand a workspace connection the global connection's password.
    expect(r.find('prod', workspace).secretScope).not.toBe(r.find('prod').secretScope);
  });

  it('hides one workspace\'s connections from another', () => {
    writeWorkspace({ connections: [{ name: 'secret-project', kind: 'fake', host: 'db' }] });
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'dbrex-other-'));
    try {
      const r = registry();
      expect(r.visible(workspace).map(c => c.spec.name)).toEqual(['secret-project']);
      expect(r.visible(other)).toEqual([]);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('shows global connections to every workspace', () => {
    writeGlobal({ connections: [{ name: 'shared', kind: 'fake', host: 'db' }] });
    expect(registry().visible(workspace).map(c => c.spec.name)).toEqual(['shared']);
  });
});

describe('reloading', () => {
  it('picks up an edited file and clears stale problems', () => {
    fs.writeFileSync(path.join(home, '.dbrex', 'connections.json'), '{ broken');
    const r = registry();
    expect(r.loadProblems()).toHaveLength(1);

    writeGlobal({ connections: [{ name: 'prod', kind: 'fake', host: 'db' }] });
    r.reloadAll();

    expect(r.loadProblems()).toEqual([]);
    expect(r.find('prod').spec.options['host']).toBe('db');
  });

  it('re-substitutes when the identity changes', () => {
    writeGlobal({ connections: [{ name: 'prod', kind: 'fake', host: 'db', user: '$user' }] });
    const r = registry('marc');
    expect(r.find('prod').spec.options['user']).toBe('marc');

    r.setOptions({ configDir: path.join(home, '.dbrex'), identityUser: 'other', home, env: {} });
    expect(r.find('prod').spec.options['user']).toBe('other');
  });
});

describe('configurations written for the previous generation', () => {
  // The old tool spelled this `ssh`. Renaming it to `tunnel` without an alias
  // did not merely drop the tunnel: the key failed validation as an unknown
  // option and the whole connection disappeared from the list.
  it('accepts the old ssh key as a tunnel', () => {
    writeGlobal({
      connections: [{
        name: 'behind-bastion', kind: 'fake', host: 'db.internal',
        ssh: { host: 'bastion.example', user: 'marc', identityFile: '~/.ssh/id_ed25519' },
      }],
    });

    const r = registry();
    expect(r.loadProblems()).toEqual([]);
    expect(r.find('behind-bastion').spec.tunnel).toMatchObject({
      host: 'bastion.example',
      user: 'marc',
    });
  });

  it('substitutes variables inside the old ssh key too', () => {
    writeGlobal({
      connections: [{
        name: 'behind-bastion', kind: 'fake', host: 'db.internal',
        ssh: { host: 'bastion.example', user: '$user', identityFile: '~/.ssh/id_ed25519' },
      }],
    });
    expect(registry('marc').find('behind-bastion').spec.tunnel).toMatchObject({
      user: 'marc',
      identityFile: `${home}/.ssh/id_ed25519`,
    });
  });

  it('prefers the new key when a file carries both', () => {
    writeGlobal({
      connections: [{
        name: 'both', kind: 'fake', host: 'db.internal',
        ssh: { host: 'old.example' },
        tunnel: { host: 'new.example' },
      }],
    });
    expect(registry().find('both').spec.tunnel).toMatchObject({ host: 'new.example' });
  });

  it('still reports a genuinely unknown option', () => {
    writeGlobal({
      connections: [{ name: 'typo', kind: 'fake', host: 'db', shh: { host: 'bastion' } }],
    });
    expect(registry().loadProblems().join('\n')).toMatch(/unknown option "shh"/);
  });
});
