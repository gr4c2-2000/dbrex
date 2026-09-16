import { describe, expect, it } from 'vitest';
import { DbRexError, validateOptions, type ErrorCode, type FieldSpec } from '@dbrex/core';
import {
  classifyClickhouseError,
  clickhouseBrowseNodes,
  clickhouseBrowseQuery,
  clickhouseError,
  clickhousePosition,
  clickhouseProvider,
  clickhouseSettings,
  columnsOfHeader,
  quoteClickhouseIdent,
} from '../src/providers/clickhouse';

function field(name: string): FieldSpec | undefined {
  return clickhouseProvider.fields.find(f => f.name === name);
}

describe('field declarations', () => {
  it('declares every option the provider reads, including the protocol knob', () => {
    expect(clickhouseProvider.fields.map(f => f.name).sort())
      .toEqual(['database', 'host', 'port', 'protocol', 'user']);
  });

  it('defaults the port to 8123 and the protocol to http', () => {
    expect(field('port')?.default).toBe(8123);
    expect(field('protocol')?.default).toBe('http');
    expect(field('user')?.default).toBe('default');
    expect(field('database')?.default).toBe('default');
  });

  it('substitutes $user/$home/$env in the identity fields only', () => {
    expect(field('user')?.substitute).toBe(true);
    expect(field('database')?.substitute).toBe(true);
    expect(field('host')?.substitute).toBeUndefined();
    expect(field('protocol')?.substitute).toBeUndefined();
  });

  it('describes every field for the wizard', () => {
    for (const f of clickhouseProvider.fields) {
      expect(f.description.length).toBeGreaterThan(10);
      expect(f.prompt).toBe(true);
    }
  });

  it('accepts a well-formed options bag and rejects anything else', () => {
    const fields = clickhouseProvider.fields;
    expect(validateOptions({ host: 'ch', port: 8443, user: 'ro', database: 'events', protocol: 'https' }, fields))
      .toEqual([]);
    expect(validateOptions({ host: 'ch', password: 'hunter2' }, fields))
      .toEqual([{ field: 'password', message: 'unknown option "password"' }]);
  });
});

describe('capabilities', () => {
  const caps = clickhouseProvider.capabilities;

  it('does not claim a server-side row limit it cannot enforce', () => {
    expect(caps.streams).toBe(true);
  });

  it('claims server-side cancellation, which KILL QUERY backs', () => {
    expect(caps.cancel).toBe('server');
  });

  it('claims LIMIT, plan-only EXPLAIN, browse, validate and settings passthrough', () => {
    expect(caps.limit).toBe('limit');
    expect(caps.explain).toBe('plan');
    expect(caps.browse).toBe(true);
    expect(caps.validate).toBe(true);
    expect(caps.settings).toBe(true);
  });

  it('offers dialect keywords', () => {
    expect(caps.keywords).toContain('PREWHERE');
    expect(caps.keywords).toContain('SELECT');
  });
});

describe('identifier quoting', () => {
  it('escapes with a backslash the way ClickHouse expects', () => {
    expect(quoteClickhouseIdent('events')).toBe('`events`');
    expect(quoteClickhouseIdent('we`ird')).toBe('`we\\`ird`');
    expect(quoteClickhouseIdent('back\\slash')).toBe('`back\\\\slash`');
  });
});

describe('introspection SQL', () => {
  it('lists user databases at the root', () => {
    const { sql, params } = clickhouseBrowseQuery([]);
    expect(sql).toContain('system.databases');
    expect(sql).toContain('{sys0:String}');
    expect(params).toEqual({ sys0: 'system', sys1: 'information_schema', sys2: 'INFORMATION_SCHEMA' });
  });

  it('binds the database and table instead of interpolating them', () => {
    const nasty = "ev'ents";
    const tables = clickhouseBrowseQuery([nasty]);
    expect(tables.sql).toContain('database = {database:String}');
    expect(tables.sql).not.toContain(nasty);
    expect(tables.params).toEqual({ database: nasty });

    const columns = clickhouseBrowseQuery([nasty, 'hi`ts']);
    expect(columns.sql).toContain('table = {table:String}');
    expect(columns.sql).not.toContain('hi`ts');
    expect(columns.params).toEqual({ database: nasty, table: 'hi`ts' });
  });

  it('refuses to go below a column', () => {
    try {
      clickhouseBrowseQuery(['events', 'hits', 'url']);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(DbRexError.is(e) && e.code).toBe('not_found');
    }
  });
});

describe('browse nodes', () => {
  it('shapes databases with a quoted insert', () => {
    expect(clickhouseBrowseNodes([], [['ev`ents']])).toEqual([
      { kind: 'database', name: 'ev`ents', hasChildren: true, insert: '`ev\\`ents`' },
    ]);
  });

  it('tells views from tables and shows the engine', () => {
    const rows = [['hits', 'MergeTree'], ['hits_v', 'View'], ['hits_mv', 'MaterializedView']];
    expect(clickhouseBrowseNodes(['events'], rows)).toEqual([
      {
        kind: 'table', name: 'hits', detail: 'MergeTree', hasChildren: true, insert: '`events`.`hits`',
        query: 'SELECT *\nFROM `events`.`hits`\nLIMIT 100',
      },
      {
        kind: 'view', name: 'hits_v', detail: 'View', hasChildren: true, insert: '`events`.`hits_v`',
        query: 'SELECT *\nFROM `events`.`hits_v`\nLIMIT 100',
      },
      {
        kind: 'view', name: 'hits_mv', detail: 'MaterializedView', hasChildren: true, insert: '`events`.`hits_mv`',
        query: 'SELECT *\nFROM `events`.`hits_mv`\nLIMIT 100',
      },
    ]);
  });

  it('puts the column type in the detail line', () => {
    expect(clickhouseBrowseNodes(['events', 'hits'], [['url', 'Nullable(String)']])).toEqual([
      { kind: 'column', name: 'url', detail: 'Nullable(String)', hasChildren: false, insert: '`url`' },
    ]);
  });
});

describe('result header', () => {
  it('pairs the names row with the types row', () => {
    expect(columnsOfHeader(['id', 'url'], ['UInt64', 'String'])).toEqual([
      { name: 'id', type: 'UInt64' },
      { name: 'url', type: 'String' },
    ]);
  });

  it('does not invent a type it was not given', () => {
    expect(columnsOfHeader(['id'], [])).toEqual([{ name: 'id', type: 'Unknown' }]);
  });
});

describe('per-query settings', () => {
  it('passes the caller settings through untouched', () => {
    expect(clickhouseSettings({ settings: { max_threads: 4, join_use_nulls: true } }))
      .toEqual({ max_threads: 4, join_use_nulls: true });
  });

  it('derives max_execution_time from the deadline, rounding up to a whole second', () => {
    expect(clickhouseSettings({ timeoutMs: 4200 })).toEqual({ max_execution_time: 5 });
    expect(clickhouseSettings({ timeoutMs: 10 })).toEqual({ max_execution_time: 1 });
  });

  it('never overrides an explicit max_execution_time', () => {
    expect(clickhouseSettings({ timeoutMs: 60_000, settings: { max_execution_time: 5 } }))
      .toEqual({ max_execution_time: 5 });
  });

  it('adds nothing when there is no deadline', () => {
    expect(clickhouseSettings(undefined)).toEqual({});
    expect(clickhouseSettings({ rowLimit: 100 })).toEqual({});
  });
});

describe('syntax error position', () => {
  it('converts the 1-based position ClickHouse reports to an offset', () => {
    const message = "Code: 62. DB::Exception: Syntax error: failed at position 8 ('FRM'): FRM hits.";
    expect(clickhousePosition(message)).toBe(7);
  });

  it('has no offset when the engine did not report one', () => {
    expect(clickhousePosition('Code: 60. DB::Exception: Table events.hits does not exist.')).toBeUndefined();
  });
});

describe('error classification', () => {
  /** Shaped like `ClickHouseError`: a numeric server code carried as a string. */
  const serverError = (code: string, message: string): Error =>
    Object.assign(new Error(`Code: ${code}. DB::Exception: ${message}`), { code, type: 'SERVER' });

  const socketError = (code: string, message: string): Error =>
    Object.assign(new Error(message), { code, syscall: 'connect' });

  const cases: ReadonlyArray<readonly [string, unknown, ErrorCode]> = [
    ['failed authentication', serverError('516', 'default: Authentication failed'), 'auth'],
    ['unknown user', serverError('192', "There is no user 'app' in user directories"), 'auth'],
    ['wrong password', serverError('193', 'Wrong password'), 'auth'],
    ['denied access', serverError('497', 'app: Not enough privileges'), 'auth'],
    ['syntax error', serverError('62', "Syntax error: failed at position 8 ('FRM')"), 'sql'],
    ['unknown table', serverError('60', 'Table events.hit does not exist'), 'sql'],
    ['unknown identifier', serverError('47', "Missing columns: 'urls'"), 'sql'],
    ['exceeded max_execution_time', serverError('159', 'Timeout exceeded: elapsed 61 seconds'), 'timeout'],
    ['socket timeout', serverError('209', 'Timeout: connect timed out'), 'timeout'],
    ['killed query', serverError('394', 'Query was cancelled'), 'cancelled'],
    ['server-side network failure', serverError('210', 'Connection refused'), 'network'],
    ['nothing listening', socketError('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:8123'), 'network'],
    ['bad hostname', socketError('ENOTFOUND', 'getaddrinfo ENOTFOUND ch.internal'), 'network'],
    ['untrusted certificate', socketError('SELF_SIGNED_CERT_IN_CHAIN', 'self signed certificate in chain'), 'network'],
    ['abort signal', Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }), 'cancelled'],
    [
      'server exception with no code parsed out',
      new Error('DB::Exception: Unknown expression identifier `usr`'),
      'sql',
    ],
    ['a bug of ours', new Error('cannot read properties of undefined'), 'internal'],
    ['not even an error', 42, 'internal'],
  ];

  for (const [name, error, code] of cases) {
    it(`maps ${name} to ${code}`, () => {
      expect(classifyClickhouseError(error)).toBe(code);
    });
  }
});

describe('error wrapping', () => {
  it('keeps the server exception code and names the connection', () => {
    const e = clickhouseError(
      Object.assign(new Error('Code: 62. DB::Exception: Syntax error'), { code: '62' }),
      'events',
    );
    expect(e).toBeInstanceOf(DbRexError);
    expect(e.code).toBe('sql');
    expect(e.details.nativeCode).toBe('62');
    expect(e.details.connection).toBe('events');
    expect(e.details.retryable).toBe(false);
  });

  it('marks an unreachable server retryable and hints at the address', () => {
    const e = clickhouseError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }), 'events');
    expect(e.code).toBe('network');
    expect(e.details.retryable).toBe(true);
    expect(e.details.hint).toContain('protocol');
  });

  it('passes an DbRexError through untouched', () => {
    const original = new DbRexError('timeout', 'query exceeded its deadline');
    expect(clickhouseError(original, 'events')).toBe(original);
  });
});

describe('the default database does not scope the explorer', () => {
  // Same regression as MySQL: a connection's default database is for resolving
  // unqualified names, not for deciding what the schema tree may show. Browse
  // takes a path and nothing else, which is what makes that mistake impossible.
  it('lists every user database at the root, filtering only system ones', () => {
    const { sql, params } = clickhouseBrowseQuery([]);
    expect(params).toEqual({ sys0: 'system', sys1: 'information_schema', sys2: 'INFORMATION_SCHEMA' });
    expect(sql).not.toContain('{database:String}');
  });

  it('filters by the database the user expanded, not by a configured one', () => {
    const { params } = clickhouseBrowseQuery(['analytics']);
    expect(params).toEqual({ database: 'analytics' });
  });
});

describe('the driver giving up on its own', () => {
  it('files a bare "Timeout error." as a timeout, not as a bug in us', () => {
    // @clickhouse/client defaults to a 30-second request timeout and reports
    // hitting it with this message and no code, so it used to surface as
    // `internal` — indistinguishable from a crash.
    expect(classifyClickhouseError(new Error('Timeout error.'))).toBe('timeout');
    expect(classifyClickhouseError(new Error('socket hang up'))).toBe('timeout');
  });

  it('does not mistake a server message that merely mentions timeouts', () => {
    const serverSide = Object.assign(new Error('DB::Exception: Timeout error. while reading'), {
      code: '241',
    });
    expect(classifyClickhouseError(serverSide)).not.toBe('timeout');
  });
});
