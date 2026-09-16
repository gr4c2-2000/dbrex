import { describe, expect, it } from 'vitest';
import { DbRexError, validateOptions, type ErrorCode, type FieldSpec } from '@dbrex/core';
import {
  classifyMysqlError,
  columnsOfFields,
  mysqlBrowseNodes,
  mysqlBrowseQuery,
  mysqlError,
  mysqlProvider,
  mysqlTypeName,
  quoteMysqlIdent,
} from '../src/providers/mysql';

function field(name: string): FieldSpec | undefined {
  return mysqlProvider.fields.find(f => f.name === name);
}

describe('field declarations', () => {
  it('declares every option the provider reads', () => {
    expect(mysqlProvider.fields.map(f => f.name).sort()).toEqual(['database', 'host', 'port', 'user']);
  });

  it('defaults the port to 3306 and requires host and user', () => {
    expect(field('port')?.default).toBe(3306);
    expect(field('host')?.required).toBe(true);
    expect(field('user')?.required).toBe(true);
    expect(field('database')?.required).toBeUndefined();
  });

  it('substitutes $user/$home/$env in the identity fields only', () => {
    expect(field('user')?.substitute).toBe(true);
    expect(field('database')?.substitute).toBe(true);
    expect(field('host')?.substitute).toBeUndefined();
    expect(field('port')?.substitute).toBeUndefined();
  });

  it('describes every field for the wizard', () => {
    for (const f of mysqlProvider.fields) {
      expect(f.description.length).toBeGreaterThan(10);
      expect(f.prompt).toBe(true);
    }
  });

  it('accepts a well-formed options bag and rejects anything else', () => {
    const fields = mysqlProvider.fields;
    expect(validateOptions({ host: 'db', port: 3306, user: 'app', database: 'shop' }, fields)).toEqual([]);
    expect(validateOptions({ host: 'db', user: 'app', password: 'hunter2' }, fields))
      .toEqual([{ field: 'password', message: 'unknown option "password"' }]);
    expect(validateOptions({ host: 'db', user: 'app', port: '3306' }, fields))
      .toEqual([{ field: 'port', message: 'option "port" must be a number, got string' }]);
  });
});

describe('capabilities', () => {
  const caps = mysqlProvider.capabilities;

  it('does not claim a server-side row limit it cannot enforce', () => {
    expect(caps.streams).toBe(true);
  });

  it('claims only transport-level cancellation', () => {
    expect(caps.cancel).toBe('transport');
  });

  it('claims LIMIT, plan-only EXPLAIN, browse and validate', () => {
    expect(caps.limit).toBe('limit');
    expect(caps.explain).toBe('plan');
    expect(caps.browse).toBe(true);
    expect(caps.validate).toBe(true);
  });

  it('does not claim a per-query settings channel', () => {
    expect(caps.settings).toBe(false);
  });

  it('offers dialect keywords', () => {
    expect(caps.keywords).toContain('STRAIGHT_JOIN');
    expect(caps.keywords).toContain('SELECT');
  });
});

describe('column shaping', () => {
  it('names protocol type codes and falls back visibly', () => {
    expect(mysqlTypeName(3)).toBe('INT');
    expect(mysqlTypeName(245)).toBe('JSON');
    expect(mysqlTypeName(undefined)).toBe('UNKNOWN');
    expect(mysqlTypeName(199)).toBe('TYPE_199');
  });

  it('turns field packets into columns, preferring MariaDB extended metadata', () => {
    const fields = [
      { name: 'id', columnType: 8 },
      { name: 'payload', columnType: 253, extendedTypeName: 'uuid' },
      { name: 'legacy', type: 12 },
    ] as unknown as Parameters<typeof columnsOfFields>[0];
    expect(columnsOfFields(fields)).toEqual([
      { name: 'id', type: 'BIGINT' },
      { name: 'payload', type: 'UUID' },
      { name: 'legacy', type: 'DATETIME' },
    ]);
  });

  it('has no columns when there was no result set', () => {
    expect(columnsOfFields(undefined)).toEqual([]);
  });
});

describe('identifier quoting', () => {
  it('doubles backticks the way MySQL expects', () => {
    expect(quoteMysqlIdent('orders')).toBe('`orders`');
    expect(quoteMysqlIdent('we`ird')).toBe('`we``ird`');
    expect(quoteMysqlIdent("o'brien")).toBe("`o'brien`");
  });
});

describe('introspection SQL', () => {
  it('lists user databases at the root', () => {
    const { sql, params } = mysqlBrowseQuery([]);
    expect(sql).toContain('information_schema.SCHEMATA');
    expect(params).toEqual(['mysql', 'information_schema', 'performance_schema', 'sys']);
  });

  it('binds the database and table instead of interpolating them', () => {
    const nasty = "sh'op";
    const tables = mysqlBrowseQuery([nasty]);
    expect(tables.sql).toContain('TABLE_SCHEMA = ?');
    expect(tables.sql).not.toContain(nasty);
    expect(tables.params).toEqual([nasty]);

    const columns = mysqlBrowseQuery([nasty, 'or`ders']);
    expect(columns.sql).toContain('TABLE_SCHEMA = ? AND TABLE_NAME = ?');
    expect(columns.sql).not.toContain('or`ders');
    expect(columns.params).toEqual([nasty, 'or`ders']);
  });

  it('refuses to go below a column', () => {
    expect(() => mysqlBrowseQuery(['shop', 'orders', 'id'])).toThrowError(DbRexError);
    try {
      mysqlBrowseQuery(['shop', 'orders', 'id']);
    } catch (e) {
      expect(DbRexError.is(e) && e.code).toBe('not_found');
    }
  });
});

describe('browse nodes', () => {
  it('shapes databases with a quoted insert', () => {
    expect(mysqlBrowseNodes([], [['sh`op']])).toEqual([
      { kind: 'database', name: 'sh`op', hasChildren: true, insert: '`sh``op`' },
    ]);
  });

  it('tells views from tables and qualifies the insert', () => {
    expect(mysqlBrowseNodes(['shop'], [['orders', 'BASE TABLE'], ['recent', 'VIEW']])).toEqual([
      {
        kind: 'table', name: 'orders', hasChildren: true, insert: '`shop`.`orders`',
        query: 'SELECT *\nFROM `shop`.`orders`\nLIMIT 100',
      },
      {
        kind: 'view', name: 'recent', hasChildren: true, insert: '`shop`.`recent`',
        query: 'SELECT *\nFROM `shop`.`recent`\nLIMIT 100',
      },
    ]);
  });

  it('puts the column type in the detail line', () => {
    expect(mysqlBrowseNodes(['shop', 'orders'], [['id', 'bigint unsigned'], ['note', null]])).toEqual([
      { kind: 'column', name: 'id', detail: 'bigint unsigned', hasChildren: false, insert: '`id`' },
      { kind: 'column', name: 'note', detail: '', hasChildren: false, insert: '`note`' },
    ]);
  });
});

describe('error classification', () => {
  const driverError = (message: string, extra: Record<string, unknown>): Error =>
    Object.assign(new Error(message), extra);

  const cases: ReadonlyArray<readonly [string, unknown, ErrorCode]> = [
    [
      'rejected password',
      driverError("Access denied for user 'app'@'10.0.0.2' (using password: YES)", {
        code: 'ER_ACCESS_DENIED_ERROR', errno: 1045, sqlState: '28000', fatal: true,
      }),
      'auth',
    ],
    [
      'no rights on the database',
      driverError("Access denied for user 'app'@'%' to database 'shop'", {
        code: 'ER_DBACCESS_DENIED_ERROR', errno: 1044, sqlState: '42000',
      }),
      'auth',
    ],
    [
      'nothing listening',
      driverError('connect ECONNREFUSED 127.0.0.1:3306', {
        code: 'ECONNREFUSED', errno: -111, syscall: 'connect', fatal: true,
      }),
      'network',
    ],
    ['bad hostname', driverError('getaddrinfo ENOTFOUND db.internal', { code: 'ENOTFOUND', fatal: true }), 'network'],
    ['dead route', driverError('connect ETIMEDOUT', { code: 'ETIMEDOUT', fatal: true }), 'network'],
    [
      'wrong certificate',
      driverError("Hostname/IP does not match certificate's altnames", { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }),
      'network',
    ],
    [
      'server went away',
      driverError('Connection lost: The server closed the connection.', {
        code: 'PROTOCOL_CONNECTION_LOST', fatal: true,
      }),
      'network',
    ],
    [
      'socket already torn down',
      driverError("Can't add new command when connection is in closed state", { fatal: true }),
      'network',
    ],
    [
      'typo in the statement',
      driverError("You have an error in your SQL syntax; check the manual near 'FRM users'", {
        code: 'ER_PARSE_ERROR', errno: 1064, sqlState: '42000',
      }),
      'sql',
    ],
    [
      'unknown table',
      driverError("Table 'shop.order' doesn't exist", { code: 'ER_NO_SUCH_TABLE', errno: 1146, sqlState: '42S02' }),
      'sql',
    ],
    [
      'unknown column',
      driverError("Unknown column 'totl' in 'field list'", { code: 'ER_BAD_FIELD_ERROR', errno: 1054 }),
      'sql',
    ],
    ['per-query inactivity timeout', driverError('Query inactivity timeout', { code: 'PROTOCOL_SEQUENCE_TIMEOUT' }), 'timeout'],
    ['abort signal', driverError('The operation was aborted', { name: 'AbortError' }), 'cancelled'],
    ['a bug of ours', new Error('cannot read properties of undefined'), 'internal'],
    ['not even an error', 'something went wrong', 'internal'],
  ];

  for (const [name, error, code] of cases) {
    it(`maps ${name} to ${code}`, () => {
      expect(classifyMysqlError(error)).toBe(code);
    });
  }
});

describe('error wrapping', () => {
  it('keeps the driver code, names the connection and marks network failures retryable', () => {
    const e = mysqlError(
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3306'), { code: 'ECONNREFUSED' }),
      'prod',
    );
    expect(e).toBeInstanceOf(DbRexError);
    expect(e.code).toBe('network');
    expect(e.details.nativeCode).toBe('ECONNREFUSED');
    expect(e.details.connection).toBe('prod');
    expect(e.details.retryable).toBe(true);
    expect(e.cause).toBeInstanceOf(Error);
  });

  it('does not mark a rejected statement retryable', () => {
    const e = mysqlError(Object.assign(new Error('syntax'), { code: 'ER_PARSE_ERROR' }), 'prod');
    expect(e.code).toBe('sql');
    expect(e.details.retryable).toBe(false);
    expect(e.details.nativeCode).toBe('ER_PARSE_ERROR');
  });

  it('passes an DbRexError through untouched', () => {
    const original = new DbRexError('cancelled', 'query cancelled');
    expect(mysqlError(original, 'prod')).toBe(original);
  });
});

describe('the default database does not scope the explorer', () => {
  // Upstream hit this: setting `database` on a connection made the schema tree
  // show only that database's tables and hid every other one, because the
  // explorer reused the connection's default database as a filter. `database`
  // means "what an unqualified table name resolves to", not "what you are
  // allowed to look at".
  //
  // It cannot happen here: browse is a function of the path alone, so no
  // connection option is in scope to leak into the query. These tests pin that
  // down so the shortcut stays unavailable.
  it('lists every user database at the root, filtering only system ones', () => {
    const { sql, params } = mysqlBrowseQuery([]);
    expect(params).toEqual(['mysql', 'information_schema', 'performance_schema', 'sys']);
    expect(sql).not.toMatch(/TABLE_SCHEMA|SCHEMA_NAME\s*=/);
  });

  it('filters by the database the user expanded, not by a configured one', () => {
    const { params } = mysqlBrowseQuery(['analytics']);
    expect(params).toEqual(['analytics']);
  });

  it('declares database as a query default, so nothing reads it as a filter', () => {
    const field = mysqlProvider.fields.find(f => f.name === 'database');
    expect(field).toBeDefined();
    expect(field?.required).not.toBe(true);
  });
});
