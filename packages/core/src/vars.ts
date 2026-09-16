/**
 * `$user` / `$home` / `$env:NAME` substitution.
 *
 * Lets a connections file live in a repository without leaking anyone's
 * username or absolute paths. Carried over from the old codebase unchanged in
 * behaviour — it was one of the parts that earned its keep.
 */

export interface VarContext {
  readonly user: string;
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export function substituteVars(value: string, ctx: VarContext): string {
  return value
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name: string) => ctx.env[name] ?? '')
    .replace(/\$user\b/g, ctx.user)
    .replace(/\$home\b/g, ctx.home)
    .replace(/^~(?=\/|$)/, ctx.home);
}

/** Substitute every string leaf, in place-free fashion. Arrays and nesting included. */
export function substituteDeep<T>(value: T, ctx: VarContext): T {
  if (typeof value === 'string') return substituteVars(value, ctx) as unknown as T;
  if (Array.isArray(value)) return value.map(v => substituteDeep(v, ctx)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = substituteDeep(v, ctx);
    return out as T;
  }
  return value;
}
