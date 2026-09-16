/**
 * Where a secret comes from.
 *
 * Four sources, in the order they are worth using:
 *
 * - `command` — run `op read`, `pass show`, `vault kv get`. The daemon stores
 *   nothing at all, which is the right answer for a team and for CI.
 * - `env` — an environment variable of the daemon process.
 * - `vault` — the daemon's own encrypted store.
 * - `prompt` — the default: use the vault if it holds one, otherwise ask a
 *   human through the broker and remember the answer.
 *
 * A locked vault is not an error the caller has to understand. If a secret is
 * needed and the vault is locked, the daemon asks for the passphrase, unlocks,
 * and carries on with the original request.
 */

import { execFile } from 'node:child_process';
import { DbRexError, type SecretPurpose } from '@dbrex/core';
import type { Broker } from './broker';
import type { RegisteredConnection } from './connections';
import type { Vault } from './vault';

export type CommandRunner = (argv: readonly string[]) => Promise<string>;

export class SecretResolver {
  constructor(
    private readonly vault: Vault,
    private readonly broker: Broker,
    private readonly run: CommandRunner = runCommand,
  ) {}

  /** The stored value, or undefined. Never prompts a human. */
  async lookup(connection: RegisteredConnection, purpose: SecretPurpose): Promise<string | undefined> {
    const source = connection.spec.secret?.from ?? 'prompt';

    switch (source) {
      case 'command': {
        const argv = connection.spec.secret?.from === 'command' ? connection.spec.secret.argv : [];
        const value = (await this.run(argv)).trim();
        if (value.length === 0) {
          throw new DbRexError('config', `secret command for "${connection.spec.name}" produced no output`, {
            connection: connection.spec.name,
            hint: `command: ${argv.join(' ')}`,
          });
        }
        return value;
      }
      case 'env': {
        const name = connection.spec.secret?.from === 'env' ? connection.spec.secret.name : '';
        const value = process.env[name];
        if (value === undefined) {
          throw new DbRexError('config', `environment variable ${name} is not set`, {
            connection: connection.spec.name,
            hint: 'the daemon reads its own environment, not the client\'s',
          });
        }
        return value;
      }
      case 'vault':
      case 'prompt':
        return this.withUnlockedVault(() => this.vault.get(this.slot(connection, purpose)));
    }
  }

  /**
   * The stored value, asking a human when there is none.
   *
   * `reason` is shown with the prompt. Being asked for a password a second time
   * with no explanation is indistinguishable from the application being broken.
   */
  async require(
    connection: RegisteredConnection,
    purpose: SecretPurpose,
    reason?: string,
  ): Promise<string> {
    const found = await this.lookup(connection, purpose);
    if (found !== undefined) return found;

    const source = connection.spec.secret?.from ?? 'prompt';
    if (source !== 'prompt') {
      throw new DbRexError('auth', `no secret available for "${connection.spec.name}"`, {
        connection: connection.spec.name,
        hint: `this connection reads its secret from "${source}", which returned nothing`,
      });
    }

    const prompt = promptFor(connection.spec.name, purpose);
    const value = await this.broker.askSecret(
      connection.spec.name,
      reason === undefined ? prompt : `${prompt} — ${reason}`,
    );
    await this.remember(connection, purpose, value);
    return value;
  }

  /** Persist a value: one a human typed, or one a provider obtained itself. */
  async remember(connection: RegisteredConnection, purpose: SecretPurpose, value: string): Promise<void> {
    const source = connection.spec.secret?.from ?? 'prompt';
    // A connection that reads from a command or the environment has an owner
    // outside DbRex. Writing a copy into the vault would create a second source
    // of truth that silently wins on the next connect.
    if (source === 'command' || source === 'env') return;
    await this.withUnlockedVault(() => {
      this.vault.set(this.slot(connection, purpose), value);
    });
  }

  async forget(connection: RegisteredConnection, purpose: SecretPurpose): Promise<boolean> {
    return this.withUnlockedVault(() => this.vault.delete(this.slot(connection, purpose)));
  }

  /**
   * Vault slot for a connection's secret. Scoped by origin so a workspace
   * connection that shadows a global one by name does not inherit its password.
   */
  slot(connection: RegisteredConnection, purpose: SecretPurpose): string {
    const suffix = purpose.kind === 'password' ? 'password' : `token:${purpose.label}`;
    return `${connection.secretScope}/${connection.spec.name}/${suffix}`;
  }

  private async withUnlockedVault<T>(read: () => T): Promise<T> {
    try {
      return read();
    } catch (e) {
      if (!(DbRexError.is(e) && e.code === 'auth' && !this.vault.unlocked)) throw e;
      const passphrase = await this.broker.askUnlock('Passphrase for the DbRex secret vault');
      this.vault.unlock(passphrase);
      return read();
    }
  }
}

function promptFor(connection: string, purpose: SecretPurpose): string {
  return purpose.kind === 'password'
    ? `Password for connection "${connection}"`
    : `${purpose.label} for connection "${connection}"`;
}

/**
 * Run a secret command without a shell.
 *
 * No shell means no quoting rules to get wrong and no way for a connections
 * file committed to a repository to turn into command injection.
 */
function runCommand(argv: readonly string[]): Promise<string> {
  const [command, ...args] = argv;
  if (!command) {
    return Promise.reject(new DbRexError('config', 'secret command is empty'));
  }
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new DbRexError('config', `secret command failed: ${command}`, {
          hint: stderr.trim().split('\n')[0] ?? error.message,
        }, error));
        return;
      }
      resolve(stdout);
    });
  });
}
