/**
 * `-- @key: value` comment directives.
 *
 * They cascade: a directive applies to every statement below it until another
 * one overrides the same key. Cheap to type, visible in the file, and they
 * travel with the query when it is shared — the reason this survived the
 * rewrite unchanged in behaviour.
 */

export interface Directive {
  readonly offset: number;
  readonly key: string;
  readonly value: string;
}


const DIRECTIVE = /(^|\n)[ \t]*--[ \t]*@(\w+)[ \t]*:[ \t]*([^\n]*)/g;

export function parseDirectives(text: string): Directive[] {
  const out: Directive[] = [];
  DIRECTIVE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DIRECTIVE.exec(text)) !== null) {
    out.push({ offset: m.index + m[1]!.length, key: m[2]!.toLowerCase(), value: m[3]!.trim() });
  }
  return out;
}

export interface StatementConfig {
  readonly connection?: string;
  readonly limit?: number;
  /** A connection the file defines for itself, if it does. */
  readonly inline?: InlineConnection;
}

/**
 * A connection declared in the file's own comments.
 *
 * The case this exists for is a database that is not worth a config entry: a
 * container that lives for an afternoon, a colleague's staging host pasted into
 * a scratch file. The query and the connection travel together, and when the
 * file is deleted nothing is left behind — no entry in `connections.json`, no
 * vault slot, nothing on disk at all.
 *
 * Values stay raw strings here. Which options a kind accepts and what type each
 * one has is the provider's business, and providers live in the daemon.
 */
export interface InlineConnection {
  readonly name: string;
  readonly kind: string;
  readonly options: Readonly<Record<string, string>>;
  /**
   * A password written in the file, in clear text.
   *
   * It never reaches the vault or any other file: the daemon keeps it in memory
   * for as long as the client that sent it stays connected. Whoever can read
   * the .sql file can read the password, which is the trade the feature makes.
   */
  readonly password?: string;
}

/**
 * Directive keys that mean something to DbRex itself. Every other key is a
 * provider option once `@kind` has been seen — before that it is a note.
 */
const RESERVED = new Set(['conn', 'dbname', 'limit', 'kind', 'password']);

/**
 * A `@conn` written inside a statement rather than above it.
 *
 * Such a directive does nothing: `configAt` only reads what precedes a
 * statement's code, so one that has been swallowed into the middle of a
 * statement is inert. It is also never deliberate — nobody names a connection
 * halfway through a query — so finding one means a statement above was left
 * unterminated and has absorbed the text below it.
 *
 * Worth detecting rather than ignoring, because the symptom is a syntax error
 * from an engine the user never addressed, which reads like the tool picked the
 * wrong provider.
 */
export function strandedConnection(
  text: string,
  statement: { readonly codeStart: number; readonly end: number },
): string | undefined {
  for (const d of parseDirectives(text)) {
    if (d.offset < statement.codeStart) continue;
    if (d.offset >= statement.end) break;
    if (d.key === 'conn' || d.key === 'dbname') return d.value || undefined;
  }
  return undefined;
}

/** Effective directive values for a statement starting at `offset`. */
export function configAt(text: string, offset: number): StatementConfig {
  let connection: string | undefined;
  let limit: number | undefined;
  let kind: string | undefined;
  let password: string | undefined;
  const options: Record<string, string> = {};

  for (const d of parseDirectives(text)) {
    if (d.offset >= offset) break;  // parseDirectives yields in source order
    switch (d.key) {
      case 'conn':
      case 'dbname':
        connection = d.value || undefined;
        break;
      case 'limit': {
        const n = Number.parseInt(d.value, 10);
        limit = Number.isFinite(n) ? n : undefined;
        break;
      }
      case 'kind':
        kind = d.value || undefined;
        break;
      case 'password':
        password = d.value || undefined;
        break;
      default:
        // Kept whatever the key is: the provider owns the option names, so a
        // key this package has never heard of is normal. It only becomes an
        // option once `@kind` says the file is defining a connection; until
        // then an unknown directive stays what it always was, someone's note.
        if (!RESERVED.has(d.key)) options[d.key] = d.value;
        break;
    }
  }

  const inline: InlineConnection | undefined = kind === undefined ? undefined : {
    name: connection ?? defaultName(kind, options),
    kind,
    options,
    ...(password === undefined ? {} : { password }),
  };

  // An inline connection with no `@conn` still has to be addressable: the name
  // it was given here is the one the daemon will register it under.
  const name = connection ?? inline?.name;

  return {
    ...(name === undefined ? {} : { connection: name }),
    ...(limit === undefined ? {} : { limit }),
    ...(inline === undefined ? {} : { inline }),
  };
}

/**
 * A name for a connection whose file never gave it one.
 *
 * It has to be stable across edits to the query — the daemon keys a live
 * session by it — and legible in a result list, where "which database did this
 * come from" is the only question it has to answer.
 */
function defaultName(kind: string, options: Readonly<Record<string, string>>): string {
  const host = options['host'] ?? options['endpoint'] ?? options['bucket'];
  if (host === undefined) return kind;
  const port = options['port'];
  return port === undefined ? `${kind}/${host}` : `${kind}/${host}:${port}`;
}
