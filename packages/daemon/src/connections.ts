/**
 * Connection registry.
 *
 * Specs come from two files, exactly as before, because the split earned its
 * keep: a global file for the connections you personally use, and a workspace
 * file that can be committed to a repository. The workspace file wins by name.
 *
 *   ~/.dbrex/connections.json
 *   <workspace>/.dbrex/connections.json
 *
 * One deliberate change: the daemon serves every workspace at once, so specs
 * are scoped. A client that spoke for workspace A never sees the connections
 * defined in workspace B — otherwise the first shared daemon would quietly turn
 * every repository's private connection file into a global one.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DbRexError,
  substituteDeep,
  validateOptions,
  withDefaults,
  type ConnectionSpec,
  type SecretSource,
  type TunnelSpec,
  type VarContext,
} from '@dbrex/core';
import type { ProviderRegistry } from './providers/registry';

export type Origin = 'global' | 'workspace';

export interface RegisteredConnection {
  readonly spec: ConnectionSpec;
  readonly origin: Origin;
  /** Workspace path for a workspace connection; undefined for a global one. */
  readonly workspace?: string;
  /**
   * Vault slot prefix. Scoped by origin so a workspace connection shadowing a
   * global one of the same name does not also inherit its password.
   */
  readonly secretScope: string;
}

export interface RegistryOptions {
  readonly configDir: string;
  readonly identityUser?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly home?: string;
}

export class ConnectionRegistry {
  private global: RegisteredConnection[] = [];
  private byWorkspace = new Map<string, RegisteredConnection[]>();
  private problems: string[] = [];

  constructor(
    private readonly providers: ProviderRegistry,
    private options: RegistryOptions,
  ) {
    this.reloadGlobal();
  }

  setOptions(options: RegistryOptions): void {
    this.options = options;
    this.reloadAll();
  }

  /** Files worth watching for changes. */
  watchPaths(workspaces: readonly string[]): string[] {
    return [globalFile(this.options.configDir), ...workspaces.map(workspaceFile)];
  }

  /**
   * Problems found while loading, as human-readable lines.
   *
   * The old loader swallowed a corrupt config into an empty list with a log
   * line, so the user saw "no connections" and had no idea their JSON was
   * broken. These surface to clients.
   */
  loadProblems(): readonly string[] {
    return this.problems;
  }

  reloadAll(): void {
    this.problems = [];
    this.reloadGlobal();
    for (const workspace of [...this.byWorkspace.keys()]) this.loadWorkspace(workspace);
  }

  /** Connections visible to a client speaking for `workspace`, workspace winning by name. */
  visible(workspace?: string): RegisteredConnection[] {
    const merged = new Map<string, RegisteredConnection>();
    for (const connection of this.global) merged.set(connection.spec.name, connection);
    if (workspace !== undefined) {
      for (const connection of this.forWorkspace(workspace)) merged.set(connection.spec.name, connection);
    }
    return [...merged.values()];
  }

  find(name: string, workspace?: string): RegisteredConnection {
    const found = this.visible(workspace).find(c => c.spec.name === name);
    if (!found) {
      const known = this.visible(workspace).map(c => c.spec.name);
      throw new DbRexError('not_found', `no connection named "${name}"`, {
        connection: name,
        hint: known.length > 0 ? `known connections: ${known.join(', ')}` : 'no connections are configured yet',
      });
    }
    return found;
  }

  private forWorkspace(workspace: string): RegisteredConnection[] {
    const cached = this.byWorkspace.get(workspace);
    if (cached) return cached;
    return this.loadWorkspace(workspace);
  }

  private loadWorkspace(workspace: string): RegisteredConnection[] {
    const loaded = this.load(workspaceFile(workspace), 'workspace', workspace);
    this.byWorkspace.set(workspace, loaded);
    return loaded;
  }

  private reloadGlobal(): void {
    this.global = this.load(globalFile(this.options.configDir), 'global');
  }

  private load(file: string, origin: Origin, workspace?: string): RegisteredConnection[] {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.problems.push(`${file}: ${e instanceof Error ? e.message : String(e)}`);
      }
      return [];
    }

    const list = (raw as { connections?: unknown }).connections;
    if (!Array.isArray(list)) {
      this.problems.push(`${file}: expected an object with a "connections" array`);
      return [];
    }

    const context = this.varContext();
    const out: RegisteredConnection[] = [];
    const seen = new Set<string>();

    for (const [i, entry] of list.entries()) {
      const spec = this.prepare(entry, `${file}[${i}]`, context);
      if (!spec) continue;
      if (seen.has(spec.name)) {
        this.problems.push(`${file}: duplicate connection name "${spec.name}"`);
        continue;
      }
      seen.add(spec.name);
      out.push({
        spec,
        origin,
        ...(workspace === undefined ? {} : { workspace }),
        secretScope: origin === 'global' ? 'global' : `workspace:${workspace}`,
      });
    }
    return out;
  }

  /** Substitute variables, apply defaults and validate against the provider's fields. */
  private prepare(entry: unknown, where: string, context: VarContext): ConnectionSpec | undefined {
    if (typeof entry !== 'object' || entry === null) {
      this.problems.push(`${where}: not an object`);
      return undefined;
    }

    const draft = substituteDeep(entry as Record<string, unknown>, context);
    const name = typeof draft['name'] === 'string' ? draft['name'] : undefined;
    const kind = typeof draft['kind'] === 'string' ? draft['kind'] : undefined;
    if (!name || !kind) {
      this.problems.push(`${where}: needs both "name" and "kind"`);
      return undefined;
    }

    const provider = this.providers.get(kind);
    if (!provider) {
      this.problems.push(`${where}: unknown kind "${kind}" (have: ${this.providers.ids().join(', ')})`);
      return undefined;
    }

    // Everything that is not a shared field belongs to the provider. Writing
    // engine options at the top level is the natural mistake, so accept both
    // shapes rather than making people nest what they never had to nest before.
    //
    // `ssh` is the spelling the previous generation of this tool used for the
    // same thing. Without the alias an existing tunnelled connection does not
    // merely lose its tunnel — it fails validation as an unknown option and
    // vanishes from the list, which is a rotten way to greet someone's upgrade.
    const { name: _n, kind: _k, reference, secret, tunnel, ssh, options, ...rest } = draft;
    const forward = isTunnel(tunnel) ? tunnel : isTunnel(ssh) ? ssh : undefined;
    const bag = { ...(typeof options === 'object' && options !== null ? options : {}), ...rest };
    const withDefault = withDefaults(bag as Record<string, unknown>, provider.fields);

    const problems = validateOptions(withDefault, provider.fields);
    if (problems.length > 0) {
      for (const p of problems) this.problems.push(`${where} (${name}): ${p.message}`);
      return undefined;
    }

    return {
      name,
      kind,
      ...(typeof reference === 'string' ? { reference } : {}),
      ...(isSecretSource(secret) ? { secret } : {}),
      ...(forward === undefined ? {} : { tunnel: forward }),
      options: withDefault,
    };
  }

  private varContext(): VarContext {
    const home = this.options.home ?? os.homedir();
    return {
      user: this.options.identityUser || os.userInfo().username,
      home,
      env: this.options.env ?? process.env,
    };
  }
}

export function globalFile(configDir: string): string {
  return path.join(configDir, 'connections.json');
}

export function workspaceFile(workspace: string): string {
  return path.join(workspace, '.dbrex', 'connections.json');
}

function isSecretSource(value: unknown): value is SecretSource {
  if (typeof value !== 'object' || value === null) return false;
  const from = (value as { from?: unknown }).from;
  return from === 'command' || from === 'env' || from === 'vault' || from === 'prompt';
}

function isTunnel(value: unknown): value is TunnelSpec {
  return typeof value === 'object' && value !== null && typeof (value as { host?: unknown }).host === 'string';
}
