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

import { splitSql, statementAt } from './split';

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
}

/** Effective directive values for a statement starting at `offset`. */
export function configAt(text: string, offset: number): StatementConfig {
  let connection: string | undefined;
  let limit: number | undefined;

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
      default:
        break;  // unknown directives are someone else's note to themselves
    }
  }

  return {
    ...(connection === undefined ? {} : { connection }),
    ...(limit === undefined ? {} : { limit }),
  };
}

/**
 * Which connection the statement at `offset` belongs to.
 *
 * A file may address several databases through `-- @conn`, so a caller's own
 * idea of the "current" connection is only the fallback. Anything that reads
 * schema for the editor — completion, syntax checking — has to agree with what
 * running the statement would actually do, or it describes a different database
 * than the one the query will hit.
 */
export function connectionAt(
  text: string,
  offset: number,
  fallback?: string,
): string | undefined {
  const statement = statementAt(splitSql(text), offset);
  const directive = statement === undefined ? undefined : configAt(text, statement.codeStart).connection;
  return directive ?? fallback;
}
