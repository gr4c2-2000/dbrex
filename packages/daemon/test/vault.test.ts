import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Vault } from '../src/vault';
import { DbRexError } from '@dbrex/core';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbrex-vault-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('keyfile mode', () => {
  it('unlocks itself and round-trips a secret across restarts', () => {
    const first = Vault.open(dir);
    expect(first.mode).toBe('keyfile');
    expect(first.unlocked).toBe(true);
    first.set('prod/password', 'hunter2');

    const second = Vault.open(dir);
    expect(second.get('prod/password')).toBe('hunter2');
  });

  it('writes the key file and the vault at mode 0600', () => {
    Vault.open(dir).set('a', 'b');
    for (const file of ['vault.key', 'vault.json']) {
      expect(fs.statSync(path.join(dir, file)).mode & 0o777).toBe(0o600);
    }
  });

  it('never stores a value in the clear', () => {
    Vault.open(dir).set('prod/password', 'hunter2');
    expect(fs.readFileSync(path.join(dir, 'vault.json'), 'utf8')).not.toContain('hunter2');
  });

  it('reports missing keys as undefined and deletes idempotently', () => {
    const vault = Vault.open(dir);
    expect(vault.get('nope')).toBeUndefined();
    expect(vault.delete('nope')).toBe(false);
    vault.set('x', '1');
    expect(vault.delete('x')).toBe(true);
    expect(vault.get('x')).toBeUndefined();
  });

  it('lists keys without exposing values', () => {
    const vault = Vault.open(dir);
    vault.set('a', '1');
    vault.set('b', '2');
    expect(vault.keys().sort()).toEqual(['a', 'b']);
  });
});

describe('passphrase mode', () => {
  it('re-encrypts existing secrets and starts locked afterwards', () => {
    const vault = Vault.open(dir);
    vault.set('prod/password', 'hunter2');
    vault.setPassphrase('correct horse');

    const reopened = Vault.open(dir);
    expect(reopened.mode).toBe('passphrase');
    expect(reopened.unlocked).toBe(false);
    reopened.unlock('correct horse');
    expect(reopened.get('prod/password')).toBe('hunter2');
  });

  it('removes the key file so the vault no longer unlocks itself', () => {
    const vault = Vault.open(dir);
    vault.setPassphrase('pw');
    expect(fs.existsSync(path.join(dir, 'vault.key'))).toBe(false);
  });

  it('rejects a wrong passphrase as an auth error', () => {
    Vault.open(dir).setPassphrase('right');
    const vault = Vault.open(dir);
    try {
      vault.unlock('wrong');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(DbRexError.is(e)).toBe(true);
      expect((e as DbRexError).code).toBe('auth');
    }
    expect(vault.unlocked).toBe(false);
  });

  it('refuses to read while locked, with a hint about how to unlock', () => {
    const seeded = Vault.open(dir);
    seeded.set('prod/password', 'hunter2');
    seeded.setPassphrase('pw');

    const locked = Vault.open(dir);
    try {
      locked.get('prod/password');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as DbRexError).code).toBe('auth');
      expect((e as DbRexError).details.hint).toContain('dbrex unlock');
    }
  });

  it('forgets the key on lock()', () => {
    const vault = Vault.open(dir);
    vault.setPassphrase('pw');
    expect(vault.unlocked).toBe(true);
    vault.lock();
    expect(vault.unlocked).toBe(false);
  });
});

describe('tamper resistance', () => {
  it('rejects a ciphertext moved to another key', () => {
    const vault = Vault.open(dir);
    vault.set('staging/password', 'staging-secret');
    vault.set('prod/password', 'prod-secret');

    const file = path.join(dir, 'vault.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.entries['prod/password'] = raw.entries['staging/password'];
    fs.writeFileSync(file, JSON.stringify(raw));

    // The entry key is authenticated data, so a swapped ciphertext fails to
    // open rather than silently handing prod the staging password.
    expect(() => Vault.open(dir).get('prod/password')).toThrow();
  });

  it('rejects a modified ciphertext', () => {
    const vault = Vault.open(dir);
    vault.set('a', 'secret');
    const file = path.join(dir, 'vault.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ct = Buffer.from(raw.entries['a'].ciphertext, 'base64');
    ct[0] = ct[0]! ^ 0xff;
    raw.entries['a'].ciphertext = ct.toString('base64');
    fs.writeFileSync(file, JSON.stringify(raw));

    expect(() => Vault.open(dir).get('a')).toThrow();
  });

  it('refuses a vault written by a future version', () => {
    fs.writeFileSync(path.join(dir, 'vault.json'), JSON.stringify({ version: 99, entries: {} }));
    expect(() => Vault.open(dir)).toThrow(/unsupported version 99/);
  });
});
