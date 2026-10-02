import { describe, expect, it } from 'vitest';
import { endsOpenStatement, splitSql, statementAt } from '../src/sql/split';
import { applyRowLimit, hasRowLimit, isReadStatement, topLevelOnly } from '../src/sql/limit';
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

describe('the row limit T-SQL accepts', () => {
  const top = (sql: string, limit = 10) => applyRowLimit(sql, limit, 'top');

  it('inserts TOP after SELECT', () => {
    expect(top('SELECT * FROM t')).toBe('SELECT TOP 10 * FROM t');
  });

  it('puts TOP after DISTINCT, which is the only legal order', () => {
    // `SELECT TOP 10 DISTINCT x` does not parse; the qualifier comes first.
    expect(top('SELECT DISTINCT kind FROM t')).toBe('SELECT DISTINCT TOP 10 kind FROM t');
  });

  it('puts TOP after ALL too', () => {
    expect(top('select all x from t')).toBe('select all TOP 10 x from t');
  });

  it('limits the outer query of a CTE, not the one inside it', () => {
    expect(top('WITH c AS (SELECT 1 AS x) SELECT * FROM c'))
      .toBe('WITH c AS (SELECT 1 AS x) SELECT TOP 10 * FROM c');
  });

  it('is not confused by a subquery in the FROM clause', () => {
    expect(top('SELECT * FROM (SELECT 1) z')).toBe('SELECT TOP 10 * FROM (SELECT 1) z');
  });

  it('declines a statement with a set operator, where TOP would bind to one branch', () => {
    for (const op of ['UNION', 'UNION ALL', 'EXCEPT', 'INTERSECT']) {
      const sql = `SELECT a FROM t ${op} SELECT b FROM u`;
      expect(top(sql), op).toBe(sql);
    }
  });

  it('leaves a statement that already limits itself alone', () => {
    expect(top('SELECT TOP 5 * FROM t')).toBe('SELECT TOP 5 * FROM t');
  });

  it('drops a trailing semicolon, as the other dialects do', () => {
    expect(top('SELECT * FROM t ORDER BY a;')).toBe('SELECT TOP 10 * FROM t ORDER BY a');
  });

  it('leaves a write alone', () => {
    expect(top('INSERT INTO t VALUES (1)')).toBe('INSERT INTO t VALUES (1)');
    expect(top('UPDATE t SET x = 1')).toBe('UPDATE t SET x = 1');
  });

  it('leaves everything alone when the limit is off', () => {
    expect(applyRowLimit('SELECT * FROM t', 0, 'top')).toBe('SELECT * FROM t');
  });

  it('is not fooled by the word union inside a string or an identifier', () => {
    expect(top("SELECT * FROM t WHERE kind = 'union'"))
      .toBe("SELECT TOP 10 * FROM t WHERE kind = 'union'");
    expect(top('SELECT * FROM unionised')).toBe('SELECT TOP 10 * FROM unionised');
  });

  it('is not fooled by a SELECT inside a comment', () => {
    expect(top('-- SELECT nothing\nSELECT * FROM t'))
      .toBe('-- SELECT nothing\nSELECT TOP 10 * FROM t');
  });
});

describe('a statement under its own directive', () => {
  /**
   * The regression this guards. A statement keeps its leading comments, so the
   * tool's own `-- @conn:` idiom — and everything the schema tree injects — used
   * to look like something other than a SELECT, and the default row limit was
   * silently never applied. The engine was asked for the whole table while the
   * setting promised the opposite.
   */
  it('still gets a row limit', () => {
    expect(applyRowLimit('-- @conn: prod\nSELECT * FROM t', 1000, 'limit'))
      .toBe('-- @conn: prod\nSELECT * FROM t LIMIT 1000');
  });

  it('gets a TOP in the right place too', () => {
    expect(applyRowLimit('-- @conn: prod\nSELECT * FROM t', 1000, 'top'))
      .toBe('-- @conn: prod\nSELECT TOP 1000 * FROM t');
  });

  it('is recognised behind a block comment as well', () => {
    expect(applyRowLimit('/* note */ SELECT * FROM t', 10, 'limit'))
      .toBe('/* note */ SELECT * FROM t LIMIT 10');
  });

  it('is recognised behind several comment lines', () => {
    const sql = '-- one\n-- two\nSELECT 1';
    expect(applyRowLimit(sql, 10, 'limit')).toBe(`${sql} LIMIT 10`);
  });

  it('does not make a write look like a read', () => {
    const sql = '-- a note\nINSERT INTO t VALUES (1)';
    expect(applyRowLimit(sql, 10, 'limit')).toBe(sql);
    expect(isReadStatement(sql)).toBe(false);
  });

  it('reads a commented SELECT as a read statement', () => {
    expect(isReadStatement('-- @conn: prod\nSELECT 1')).toBe(true);
    expect(isReadStatement('/* x */ SHOW TABLES')).toBe(true);
  });

  it('is not fooled by a keyword that only appears in the comment', () => {
    expect(isReadStatement('-- SELECT something\nDELETE FROM t')).toBe(false);
  });
});
