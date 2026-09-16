/**
 * Connection specs.
 *
 * The old `ConnectionParams` was a 20-field struct where 14 fields belonged to
 * one engine each, duplicated in `StoredConnection`, and hand-copied field by
 * field in `resolve()`. Three places to edit, nothing keeping them in sync.
 *
 * Here the shared shape holds only what every connection has. Engine-specific
 * fields live in `options`, and the provider that owns them declares them —
 * which also gives the connection wizard its form and the docs their table.
 */

import { DbRexError } from './errors';

/** Where a secret comes from. Resolved by the daemon, never by a provider. */
export type SecretSource =
  /** Run a command and take stdout: 1Password, pass, vault, gopass. Nothing stored. */
  | { readonly from: 'command'; readonly argv: readonly string[] }
  /** Read an environment variable of the daemon process. */
  | { readonly from: 'env'; readonly name: string }
  /** Read the daemon's encrypted vault. Requires an unlocked daemon. */
  | { readonly from: 'vault' }
  /** Ask a human through an interactive client, then remember in the vault. */
  | { readonly from: 'prompt' };

export interface TunnelSpec {
  readonly host: string;
  readonly user?: string;
  readonly port?: number;
  readonly identityFile?: string;
}

export interface ConnectionSpec {
  readonly name: string;
  /** Provider id. Not a closed union: adding a provider must not edit core. */
  readonly kind: string;
  /**
   * Free-text context surfaced to the AI before it queries: docs, repo, jira,
   * a path to a schema .md. Cheap, and the best answer the old codebase found
   * to "how does the agent learn this schema". Kept verbatim.
   */
  readonly reference?: string;
  readonly secret?: SecretSource;
  readonly tunnel?: TunnelSpec;
  /** Provider-owned fields, validated against that provider's `fields`. */
  readonly options: Readonly<Record<string, unknown>>;
}

export type FieldType = 'string' | 'number' | 'boolean';

/**
 * A provider's declaration of one option it accepts. Consumed by validation,
 * by the connection wizard (so `addConnection` stops hardcoding per-kind
 * prompts), and by the generated documentation.
 */
export interface FieldSpec {
  readonly name: string;
  readonly type: FieldType;
  readonly description: string;
  readonly required?: boolean;
  readonly default?: string | number | boolean;
  /** Run `$user` / `$home` / `$env:NAME` substitution over the value. */
  readonly substitute?: boolean;
  /** Offer this field in the connection wizard. Off for rarely-used knobs. */
  readonly prompt?: boolean;
}

export interface ValidationProblem {
  readonly field: string;
  readonly message: string;
}

/**
 * Check a spec's options against a provider's field declarations.
 * Reports every problem at once — a config file with three mistakes should
 * take one round trip to fix, not three.
 */
export function validateOptions(
  options: Readonly<Record<string, unknown>>,
  fields: readonly FieldSpec[],
): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  const declared = new Map(fields.map(f => [f.name, f]));

  for (const field of fields) {
    const value = options[field.name];
    if (value === undefined || value === null) {
      if (field.required && field.default === undefined) {
        problems.push({ field: field.name, message: `required option "${field.name}" is missing` });
      }
      continue;
    }
    if (typeof value !== field.type) {
      problems.push({
        field: field.name,
        message: `option "${field.name}" must be a ${field.type}, got ${typeof value}`,
      });
    }
  }

  for (const name of Object.keys(options)) {
    if (!declared.has(name)) {
      problems.push({ field: name, message: `unknown option "${name}"` });
    }
  }

  return problems;
}

/** Fill in declared defaults. Does not validate; run `validateOptions` first. */
export function withDefaults(
  options: Readonly<Record<string, unknown>>,
  fields: readonly FieldSpec[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...options };
  for (const field of fields) {
    if (out[field.name] === undefined && field.default !== undefined) {
      out[field.name] = field.default;
    }
  }
  return out;
}

/**
 * Typed reader for provider option bags. A provider that declared a field
 * required may read it with `req`; anything else goes through the optional
 * readers so a bad config surfaces as `config`, never as a driver crash.
 */
export class Options {
  constructor(
    private readonly bag: Readonly<Record<string, unknown>>,
    private readonly connection: string,
  ) {}

  str(name: string): string | undefined {
    const v = this.bag[name];
    return typeof v === 'string' && v.length > 0 ? v : undefined;
  }

  num(name: string): number | undefined {
    const v = this.bag[name];
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  }

  bool(name: string): boolean | undefined {
    const v = this.bag[name];
    return typeof v === 'boolean' ? v : undefined;
  }

  reqStr(name: string): string {
    const v = this.str(name);
    if (v === undefined) throw this.missing(name);
    return v;
  }

  reqNum(name: string): number {
    const v = this.num(name);
    if (v === undefined) throw this.missing(name);
    return v;
  }

  private missing(name: string): DbRexError {
    return new DbRexError('config', `connection "${this.connection}" is missing option "${name}"`, {
      connection: this.connection,
      hint: `add "${name}" to this connection in your connections file`,
    });
  }
}
