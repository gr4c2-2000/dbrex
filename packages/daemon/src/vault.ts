/**
 * Encrypted secret store owned by the daemon.
 *
 * The old design kept passwords in VSCode's SecretStorage, which is why the AI
 * path could not run without an editor window open. Moving the store into the
 * daemon is what makes agents independent — so the store has to be at least as
 * good as what it replaces.
 *
 * Format: AES-256-GCM per entry, random 12-byte IV, the entry's key as
 * additional authenticated data so a ciphertext cannot be moved from one slot
 * to another. The file is rewritten atomically at mode 0600.
 *
 * Two key modes, and the difference matters:
 *
 * - `keyfile` (default): the master key is 32 random bytes in a 0600 file next
 *   to the vault. The daemon unlocks itself at startup, so nothing prompts and
 *   agents keep working across restarts. This protects against a backup, a
 *   synced folder or another user reading the vault — not against anyone who
 *   can already read your home directory as you. That is the same guarantee
 *   VSCode's SecretStorage gives on Linux, stated plainly instead of implied.
 *
 * - `passphrase`: the master key is derived with scrypt and never stored. The
 *   daemon starts locked and a human must unlock it once per daemon lifetime.
 *   Strictly better, at the cost of that one prompt.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DbRexError } from '@dbrex/core';

const VERSION = 1;
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
/** Sentinel entry used to tell "wrong passphrase" from "empty vault". */
const CHECK_KEY = '__vault_check__';
const CHECK_VALUE = 'dbrex-vault-ok';

const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 } as const;

interface SealedValue {
  readonly iv: string;
  readonly ciphertext: string;
  readonly tag: string;
}

interface VaultFile {
  readonly version: number;
  /** Present in passphrase mode; absent in keyfile mode. */
  readonly kdf?: {
    readonly algorithm: 'scrypt';
    readonly salt: string;
    readonly N: number;
    readonly r: number;
    readonly p: number;
  };
  readonly entries: Record<string, SealedValue>;
}

export type VaultMode = 'keyfile' | 'passphrase';

export class Vault {
  private key: Buffer | undefined;
  private file: VaultFile;

  private constructor(
    private readonly vaultPath: string,
    private readonly keyPath: string,
    file: VaultFile,
  ) {
    this.file = file;
  }

  /** Load an existing vault, or prepare an empty one that is written on first use. */
  static open(dir: string): Vault {
    const vaultPath = path.join(dir, 'vault.json');
    const keyPath = path.join(dir, 'vault.key');
    let file: VaultFile = { version: VERSION, entries: {} };
    if (fs.existsSync(vaultPath)) {
      const parsed = JSON.parse(fs.readFileSync(vaultPath, 'utf8')) as VaultFile;
      if (parsed.version !== VERSION) {
        throw new DbRexError('config', `vault at ${vaultPath} has unsupported version ${parsed.version}`);
      }
      file = parsed;
    }
    const vault = new Vault(vaultPath, keyPath, file);
    if (vault.mode === 'keyfile') vault.unlockWithKeyfile();
    return vault;
  }

  get mode(): VaultMode {
    return this.file.kdf ? 'passphrase' : 'keyfile';
  }

  get unlocked(): boolean {
    return this.key !== undefined;
  }

  get exists(): boolean {
    return fs.existsSync(this.vaultPath);
  }

  /** Derive the master key from a passphrase. Throws `auth` when it is wrong. */
  unlock(passphrase: string): void {
    const kdf = this.file.kdf;
    if (!kdf) throw new DbRexError('config', 'this vault does not use a passphrase');
    const key = crypto.scryptSync(passphrase, Buffer.from(kdf.salt, 'base64'), KEY_LENGTH, {
      N: kdf.N,
      r: kdf.r,
      p: kdf.p,
      maxmem: SCRYPT.maxmem,
    });
    const check = this.file.entries[CHECK_KEY];
    if (check) {
      try {
        if (unseal(key, CHECK_KEY, check) !== CHECK_VALUE) throw new Error('mismatch');
      } catch {
        throw new DbRexError('auth', 'wrong vault passphrase', { retryable: true });
      }
    }
    this.key = key;
  }

  lock(): void {
    this.key?.fill(0);
    this.key = undefined;
  }

  /**
   * Switch the vault to passphrase mode, re-encrypting everything it holds.
   * Requires the vault to be unlocked so existing secrets survive the move.
   */
  setPassphrase(passphrase: string): void {
    const current = this.requireKey();
    const plain = new Map<string, string>();
    for (const key of Object.keys(this.file.entries)) {
      if (key === CHECK_KEY) continue;
      plain.set(key, unseal(current, key, this.file.entries[key]!));
    }

    const salt = crypto.randomBytes(16);
    const next = crypto.scryptSync(passphrase, salt, KEY_LENGTH, SCRYPT);
    const entries: Record<string, SealedValue> = { [CHECK_KEY]: seal(next, CHECK_KEY, CHECK_VALUE) };
    for (const [key, value] of plain) entries[key] = seal(next, key, value);

    this.file = {
      version: VERSION,
      kdf: { algorithm: 'scrypt', salt: salt.toString('base64'), N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p },
      entries,
    };
    this.key = next;
    this.persist();
    try {
      fs.unlinkSync(this.keyPath);
    } catch {
      /* already gone */
    }
  }

  get(key: string): string | undefined {
    const sealed = this.file.entries[key];
    if (!sealed) return undefined;
    return unseal(this.requireKey(), key, sealed);
  }

  set(key: string, value: string): void {
    const entries = { ...this.file.entries, [key]: seal(this.requireKey(), key, value) };
    this.file = { ...this.file, entries };
    this.persist();
  }

  delete(key: string): boolean {
    if (!(key in this.file.entries)) return false;
    const entries = { ...this.file.entries };
    delete entries[key];
    this.file = { ...this.file, entries };
    this.persist();
    return true;
  }

  has(key: string): boolean {
    return key in this.file.entries;
  }

  /** Entry keys, excluding internal sentinels. For diagnostics, never values. */
  keys(): string[] {
    return Object.keys(this.file.entries).filter(k => k !== CHECK_KEY);
  }

  private requireKey(): Buffer {
    if (!this.key) {
      throw new DbRexError('auth', 'the secret vault is locked', {
        hint: 'unlock it from VSCode, or run `dbrex unlock`',
        retryable: true,
      });
    }
    return this.key;
  }

  private unlockWithKeyfile(): void {
    try {
      const key = fs.readFileSync(this.keyPath);
      if (key.length !== KEY_LENGTH) throw new Error('bad key length');
      this.key = key;
      return;
    } catch {
      /* fall through and mint one */
    }
    const key = crypto.randomBytes(KEY_LENGTH);
    fs.mkdirSync(path.dirname(this.keyPath), { recursive: true });
    fs.writeFileSync(this.keyPath, key, { mode: 0o600 });
    this.key = key;
  }

  /** Write via a temporary file and rename, so a crash cannot truncate the vault. */
  private persist(): void {
    const tmp = `${this.vaultPath}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(this.vaultPath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(this.file, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.vaultPath);
  }
}

function seal(key: Buffer, aad: string, value: string): SealedValue {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

function unseal(key: Buffer, aad: string, sealed: SealedValue): string {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
