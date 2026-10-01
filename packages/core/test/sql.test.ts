import { describe, expect, it } from 'vitest';
import { endsOpenStatement, splitSql, statementAt } from '../src/sql/split';
import { applyRowLimit, hasRowLimit, topLevelOnly } from '../src/sql/limit';
import { configAt, parseDirectives, strandedConnection } from '../src/sql/directives';

describe('splitSql', () => {
  it('splits on top-level semicolons and trims', () => {
    const s = splitSql('SELECT 1;\n  SELECT 2 ;');
    expect(s.map(x => x.sql)).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('reports offsets that address the trimmed statement', () => {
    const text = '\n\nSELECT 42;';
    const [first] = splitSql(text);
    expect(text.slice(first!.start, first!.end)).toBe('SELECT 42');
  });

  it('ignores semicolons inside strings, identifiers and comments', () => {
    const text = [
      `SELECT ';' AS a, "b;c" AS b, \`d;e\` AS c;`,
      `-- trailing ; comment`,
      `/* block ; comment */`,
      `SELECT 2;`,
    ].join('\n');
    expect(splitSql(text)).toHaveLength(2);
  });

  it('handles doubled-quote escapes', () => {
    expect(splitSql(`SELECT 'it''s; fine';SELECT 2`)).toHaveLength(2);
  });

  it('handles backslash escapes in strings but not in backticks', () => {
    expect(splitSql(`SELECT 'a\\';b';SELECT 2`)).toHaveLength(2);
    expect(splitSql('SELECT `a\\`, 1;SELECT 2')).toHaveLength(2);
  });

  it('drops empty statements from stray semicolons', () => {
    expect(splitSql(';;\nSELECT 1;;')).toHaveLength(1);
  });

  it('returns nothing for text with no statements', () => {
    expect(splitSql('   \n-- just a comment\n')).toEqual([]);
  });
});

describe('statementAt', () => {
  const text = 'SELECT 1;\n\nSELECT 2;';
  const stmts = splitSql(text);

  it('finds the statement the cursor is inside', () => {
    expect(statementAt(stmts, 3)?.sql).toBe('SELECT 1');
    expect(statementAt(stmts, text.indexOf('SELECT 2') + 2)?.sql).toBe('SELECT 2');
  });

  it('attributes the gap between statements to the one before it', () => {
    expect(statementAt(stmts, text.indexOf('\n\n') + 1)?.sql).toBe('SELECT 1');
  });

  it('falls back to the first statement before any text', () => {
    expect(statementAt(stmts, 0)?.sql).toBe('SELECT 1');
  });
});

describe('topLevelOnly', () => {
  it('blanks nested groups, strings and comments', () => {
    const masked = topLevelOnly(`SELECT (SELECT 1 LIMIT 1), 'LIMIT 5' -- LIMIT 9\nFROM t`);
    expect(masked).not.toMatch(/limit/i);
    expect(masked).toMatch(/SELECT/);
    expect(masked).toMatch(/FROM t/);
  });
});

describe('hasRowLimit', () => {
  it('sees a top-level limit', () => {
    expect(hasRowLimit('SELECT * FROM t LIMIT 10')).toBe(true);
    expect(hasRowLimit('SELECT * FROM t FETCH FIRST 10 ROWS ONLY')).toBe(true);
  });

  it('does not count a limit inside a subquery or a literal', () => {
    expect(hasRowLimit('SELECT * FROM (SELECT 1 LIMIT 1) x')).toBe(false);
    expect(hasRowLimit(`SELECT 'LIMIT 5' FROM t`)).toBe(false);
  });
});

describe('applyRowLimit', () => {
  it('appends dialect-appropriate syntax', () => {
    expect(applyRowLimit('SELECT * FROM t', 10, 'limit')).toBe('SELECT * FROM t LIMIT 10');
    expect(applyRowLimit('SELECT * FROM t', 10, 'fetch-first'))
      .toBe('SELECT * FROM t FETCH FIRST 10 ROWS ONLY');
  });

  it('strips a trailing semicolon before appending', () => {
    expect(applyRowLimit('SELECT * FROM t;', 5, 'limit')).toBe('SELECT * FROM t LIMIT 5');
  });

  it('leaves everything else alone', () => {
    expect(applyRowLimit('SELECT * FROM t', 0, 'limit')).toBe('SELECT * FROM t');
    expect(applyRowLimit('SELECT * FROM t', 10, 'none')).toBe('SELECT * FROM t');
    expect(applyRowLimit('DELETE FROM t', 10, 'limit')).toBe('DELETE FROM t');
    expect(applyRowLimit('SELECT 1 LIMIT 1', 10, 'limit')).toBe('SELECT 1 LIMIT 1');
    expect(applyRowLimit('SHOW TABLES', 10, 'limit')).toBe('SHOW TABLES');
  });
});

describe('directives', () => {
  const text = [
    '-- @conn: prod',
    'SELECT 1;',
    '-- @limit: 50',
    '-- @conn: staging',
    'SELECT 2;',
  ].join('\n');

  it('parses key, value and offset', () => {
    expect(parseDirectives(text).map(d => [d.key, d.value])).toEqual([
      ['conn', 'prod'], ['limit', '50'], ['conn', 'staging'],
    ]);
  });

  it('cascades until overridden', () => {
    expect(configAt(text, text.indexOf('SELECT 1'))).toEqual({ connection: 'prod' });
    expect(configAt(text, text.indexOf('SELECT 2'))).toEqual({ connection: 'staging', limit: 50 });
  });

  it('accepts dbname as an alias for conn', () => {
    expect(configAt('-- @dbname: x\nSELECT 1', 20)).toEqual({ connection: 'x' });
  });

  it('ignores a non-numeric limit and unknown keys', () => {
    expect(configAt('-- @limit: many\n-- @note: hi\nSELECT 1', 40)).toEqual({});
  });

  it('is stateless across calls', () => {
    expect(parseDirectives(text)).toHaveLength(3);
    expect(parseDirectives(text)).toHaveLength(3);
  });
});

describe('directives attached to the statement below them', () => {
  const text = [
    '-- @conn: clickhouse_analytics',
    '-- @limit: 3',
    'SELECT 1 AS a;',
    '',
    '-- @conn: clickhouse_ma',
    'SELECT 2 AS b;',
  ].join('\n');

  it('reports where the code starts, not where the comment does', () => {
    const [first] = splitSql(text);
    // `start` sits on the `--` of the first directive, because a statement keeps
    // its leading comments. Measuring directives from there compares them
    // against themselves and finds none.
    expect(text.slice(first!.start, first!.start + 2)).toBe('--');
    expect(text.slice(first!.codeStart, first!.codeStart + 6)).toBe('SELECT');
  });

  it('applies a directive written directly above its statement', () => {
    const statements = splitSql(text);
    expect(configAt(text, statements[0]!.codeStart))
      .toEqual({ connection: 'clickhouse_analytics', limit: 3 });
    expect(configAt(text, statements[1]!.codeStart))
      .toEqual({ connection: 'clickhouse_ma', limit: 3 });
  });

  it('ignores a directive written below the code it follows', () => {
    const trailing = 'SELECT 1;\n-- @conn: later\nSELECT 2;';
    const statements = splitSql(trailing);
    expect(configAt(trailing, statements[0]!.codeStart)).toEqual({});
    expect(configAt(trailing, statements[1]!.codeStart)).toEqual({ connection: 'later' });
  });

  it('handles a block comment before the code', () => {
    const blocked = '-- @conn: prod\n/* notes */ SELECT 1;';
    const [only] = splitSql(blocked);
    expect(blocked.slice(only!.codeStart, only!.codeStart + 6)).toBe('SELECT');
    expect(configAt(blocked, only!.codeStart)).toEqual({ connection: 'prod' });
  });
});

describe('connections defined in the file', () => {
  const text = [
    '-- @kind: mysql',
    '-- @host: 127.0.0.1',
    '-- @port: 3306',
    '-- @user: root',
    '-- @password: hunter2',
    '-- @database: app',
    'SELECT 1;',
  ].join('\n');

  it('collects kind, password and provider options', () => {
    expect(configAt(text, text.indexOf('SELECT 1')).inline).toEqual({
      name: 'mysql/127.0.0.1:3306',
      kind: 'mysql',
      options: { host: '127.0.0.1', port: '3306', user: 'root', database: 'app' },
      password: 'hunter2',
    });
  });

  it('names the connection so the rest of the pipeline can address it', () => {
    expect(configAt(text, text.indexOf('SELECT 1')).connection).toBe('mysql/127.0.0.1:3306');
  });

  it('lets @conn name it instead of the derived name', () => {
    const named = `-- @conn: docker\n${text}`;
    const config = configAt(named, named.indexOf('SELECT 1'));
    expect(config.connection).toBe('docker');
    expect(config.inline?.name).toBe('docker');
  });

  it('falls back to the kind alone when there is no host', () => {
    expect(configAt('-- @kind: duck\nSELECT 1', 40).inline?.name).toBe('duck');
  });

  it('leaves unknown keys alone when no @kind claims them', () => {
    expect(configAt('-- @note: hi\n-- @host: db\nSELECT 1', 40)).toEqual({});
  });

  it('keeps a password out of the options bag', () => {
    const options = configAt(text, text.indexOf('SELECT 1')).inline?.options ?? {};
    expect(Object.keys(options)).not.toContain('password');
  });

  it('cascades like every other directive', () => {
    const two = [
      '-- @kind: mysql',
      '-- @host: first',
      'SELECT 1;',
      '-- @host: second',
      'SELECT 2;',
    ].join('\n');
    expect(configAt(two, two.indexOf('SELECT 1')).inline?.options).toEqual({ host: 'first' });
    expect(configAt(two, two.indexOf('SELECT 2')).inline?.options).toEqual({ host: 'second' });
  });
});

describe('a statement that was never terminated', () => {
  it('knows when text ends mid-statement', () => {
    expect(endsOpenStatement('SELECT 1')).toBe(true);
    expect(endsOpenStatement('SELECT 1;')).toBe(false);
  });

  it('is not fooled by trailing whitespace or a blank line', () => {
    expect(endsOpenStatement('SELECT 1\n\n')).toBe(true);
    expect(endsOpenStatement('SELECT 1;\n\n')).toBe(false);
  });

  it('is not fooled by a trailing comment', () => {
    expect(endsOpenStatement('SELECT 1;\n-- a note\n')).toBe(false);
    expect(endsOpenStatement('SELECT 1\n-- a note\n')).toBe(true);
  });

  it('treats comments and whitespace alone as nothing to close', () => {
    expect(endsOpenStatement('')).toBe(false);
    expect(endsOpenStatement('-- @conn: ads\n')).toBe(false);
    expect(endsOpenStatement('   \n\t\n')).toBe(false);
  });

  it('ignores a semicolon inside a string or a comment', () => {
    expect(endsOpenStatement("SELECT ';'")).toBe(true);
    expect(endsOpenStatement('SELECT 1 -- ;\n')).toBe(true);
  });

  it('reopens after a terminator when more code follows', () => {
    expect(endsOpenStatement('SELECT 1; SELECT 2')).toBe(true);
  });
});

describe('a @conn stranded inside a statement', () => {
  /**
   * The case this was written for: a block injected from the schema tree landed
   * below a statement with no `;`, so the whole file became one statement and
   * the directive stopped applying. The query went to the previous connection
   * and came back with a syntax error from an engine it had never named.
   */
  const SWALLOWED = [
    '-- @conn: ads',
    'SELECT id, name',
    'FROM users',
    'WHERE id = 1',
    '',
    '-- @conn: commonAZ',
    'SELECT *',
    'FROM "dot.i-json-dot"',
    'LIMIT 100',
  ].join('\n');

  it('is one statement, which is the whole problem', () => {
    expect(splitSql(SWALLOWED)).toHaveLength(1);
  });

  it('still resolves to the connection named at the top', () => {
    const statement = splitSql(SWALLOWED)[0]!;
    expect(configAt(SWALLOWED, statement.codeStart).connection).toBe('ads');
  });

  it('names the connection that was asked for and ignored', () => {
    const statement = splitSql(SWALLOWED)[0]!;
    expect(strandedConnection(SWALLOWED, statement)).toBe('commonAZ');
  });

  it('finds nothing when the directive is where it belongs', () => {
    const fine = '-- @conn: commonAZ\nSELECT 1';
    const statement = splitSql(fine)[0]!;
    expect(strandedConnection(fine, statement)).toBeUndefined();
    expect(configAt(fine, statement.codeStart).connection).toBe('commonAZ');
  });

  it('does not reach into the next statement for one', () => {
    const two = 'SELECT 1;\n-- @conn: other\nSELECT 2';
    const first = splitSql(two)[0]!;
    expect(strandedConnection(two, first)).toBeUndefined();
  });

  it('accepts @dbname, which means the same thing', () => {
    const text = 'SELECT 1\n-- @dbname: other\nSELECT 2';
    expect(strandedConnection(text, splitSql(text)[0]!)).toBe('other');
  });
});
