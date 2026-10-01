import { describe, expect, it } from 'vitest';
import { DbRexError, validateOptions, type ErrorCode, type FieldSpec } from '@dbrex/core';
import {
  SSL_MODES,
  classifyPostgresError,
  columnsOfFields,
  postgresBrowseNodes,
  postgresBrowseQuery,
  postgresError,
  postgresProvider,
  postgresTypeName,
  quotePostgresIdent,
  sslOptionFor,
} from '../src/providers/postgres';
import { builtinProviders } from '../src/providers/builtin';

function field(name: string): FieldSpec | undefined {
  return postgresProvider.fields.find(f => f.name === name);
}

const endpoint = { host: 'db.example', port: 5432 };

describe('registration', () => {
  it('ships in the build under a kind a connection file can name', () => {
    expect(builtinProviders().map(p => p.id)).toContain('postgres');
  });

  it('claims an id nothing else claims', () => {
    const ids = builtinProviders().map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('field declarations', () => {
  it('declares every option the provider reads', () => {
    expect(postgresProvider.fields.map(f => f.name).sort())
      .toEqual(['database', 'host', 'port', 'sslmode', 'user']);
  });

  it('defaults the port to 5432 and requires host and user', () => {
    expect(field('port')?.default).toBe(5432);
    expect(field('host')?.required).toBe(true);
    expect(field('user')?.required).toBe(true);
    expect(field('database')?.required).toBeUndefined();
  });

  it('defaults sslmode to disable, so a local container needs no ceremony', () => {
    expect(field('sslmode')?.default).toBe('disable');
    expect(field('sslmode')?.required).toBeUndefined();
  });

  it('substitutes $user/$home/$env in the identity fields only', () => {
    expect(field('user')?.substitute).toBe(true);
    expect(field('database')?.substitute).toBe(true);
    expect(field('host')?.substitute).toBeUndefined();
    expect(field('port')?.substitute).toBeUndefined();
  });

  it('describes every field for the wizard', () => {
    for (const f of postgresProvider.fields) {
      expect(f.description.length).toBeGreaterThan(10);
      expect(f.prompt).toBe(true);
    }
  });

  it('tells a RisingWave user which port and database to expect', () => {
    expect(field('port')?.description).toMatch(/4566/);
    expect(field('database')?.description).toMatch(/dev/);
  });

  it('accepts a well-formed options bag and rejects anything else', () => {
    const fields = postgresProvider.fields;
    expect(validateOptions({ host: 'db', port: 5432, user: 'app', database: 'shop', sslmode: 'disable' }, fields))
      .toEqual([]);
    expect(validateOptions({ host: 'db', user: 'app', password: 'hunter2' }, fields))
      .toEqual([{ field: 'password', message: 'unknown option "password"' }]);
    expect(validateOptions({ host: 'db', user: 'app', port: '5432' }, fields))
      .toEqual([{ field: 'port', message: 'option "port" must be a number, got string' }]);
  });
});

describe('capabilities', () => {
  const caps = postgresProvider.capabilities;

  it('bounds its own memory, because rows come through a cursor', () => {
    expect(caps.streams).toBe(true);
  });

  it('claims only transport-level cancellation, since pg sends no CancelRequest', () => {
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

  it('offers both dialects of keyword, so RisingWave completes too', () => {
    expect(caps.keywords).toContain('SELECT');
    expect(caps.keywords).toContain('ILIKE');
    expect(caps.keywords).toContain('CREATE MATERIALIZED VIEW');
    expect(caps.keywords).toContain('EMIT ON WINDOW CLOSE');
  });
});

describe('column shaping', () => {
  it('names built-in type oids and falls back visibly', () => {
    expect(postgresTypeName(23)).toBe('int4');
    expect(postgresTypeName(1184)).toBe('timestamptz');
    expect(postgresTypeName(3802)).toBe('jsonb');
    // A user-defined type has an oid assigned at creation time, so no table
    // can know its name. Say the oid rather than guess.
    expect(postgresTypeName(987654)).toBe('oid_987654');
    expect(postgresTypeName(undefined)).toBe('unknown');
  });

  it('turns field metadata into columns', () => {
    // Only the two fields the provider reads; `pg` sends five more that say
    // where the value came from, and none of them shape a column.
    const fields = [
      { name: 'id', dataTypeID: 23 },
      { name: 'created', dataTypeID: 1184 },
      { name: 'payload', dataTypeID: 3802 },
    ] as unknown as Parameters<typeof columnsOfFields>[0];
    expect(columnsOfFields(fields)).toEqual([
      { name: 'id', type: 'int4' },
      { name: 'created', type: 'timestamptz' },
      { name: 'payload', type: 'jsonb' },
    ]);
  });

  it('has no columns when there was no result set', () => {
    expect(columnsOfFields(undefined)).toEqual([]);
  });
});

describe('identifier quoting', () => {
  it('doubles double quotes the way PostgreSQL expects', () => {
    expect(quotePostgresIdent('events')).toBe('"events"');
    expect(quotePostgresIdent('odd"name')).toBe('"odd""name"');
    // Quoting is also what keeps a mixed-case or reserved name addressable.
    expect(quotePostgresIdent('Order')).toBe('"Order"');
  });
});

describe('introspection SQL', () => {
  it('lists user schemas at the root, not databases', () => {
    const { sql, params } = postgresBrowseQuery([]);
    expect(sql).toMatch(/pg_namespace/);
    expect(params).toEqual(['{pg_catalog,information_schema,rw_catalog}']);
  });

  it('hides the temporary and toast schemas as well', () => {
    expect(postgresBrowseQuery([]).sql).toMatch(/pg_toast%/);
    expect(postgresBrowseQuery([]).sql).toMatch(/pg_temp%/);
  });

  it('binds the schema and relation instead of interpolating them', () => {
    const tables = postgresBrowseQuery(['public']);
    expect(tables.sql).toMatch(/n\.nspname = \$1/);
    expect(tables.params[0]).toBe('public');

    const columns = postgresBrowseQuery(['public', "o'clock"]);
    expect(columns.sql).toMatch(/c\.relname = \$2/);
    expect(columns.params).toEqual(['public', "o'clock"]);
    expect(columns.sql).not.toMatch(/o'clock/);
  });

  it('reads materialized views, which information_schema would have hidden', () => {
    const { sql, params } = postgresBrowseQuery(['public']);
    expect(sql).not.toMatch(/information_schema/);
    expect(params[1]).toBe('{r,p,v,m,f}');
  });

  it('asks pg_type for a column type rather than calling format_type', () => {
    const { sql } = postgresBrowseQuery(['public', 'events']);
    expect(sql).toMatch(/pg_type/);
    expect(sql).not.toMatch(/format_type/);
  });

  it('skips dropped and system columns', () => {
    const { sql } = postgresBrowseQuery(['public', 'events']);
    expect(sql).toMatch(/a\.attnum > 0/);
    expect(sql).toMatch(/NOT a\.attisdropped/);
  });

  it('refuses to go below a column', () => {
    expect(() => postgresBrowseQuery(['public', 'events', 'id']))
      .toThrow(DbRexError);
    try {
      postgresBrowseQuery(['public', 'events', 'id']);
    } catch (e) {
      expect((e as DbRexError).code).toBe('not_found');
    }
  });
});

describe('browse nodes', () => {
  it('shapes schemas with a quoted insert', () => {
    expect(postgresBrowseNodes([], [['public'], ['Reporting']])).toEqual([
      { kind: 'schema', name: 'public', hasChildren: true, insert: '"public"' },
      { kind: 'schema', name: 'Reporting', hasChildren: true, insert: '"Reporting"' },
    ]);
  });

  it('tells each relation kind apart and qualifies the insert', () => {
    const nodes = postgresBrowseNodes(['public'], [
      ['events', 'r'],
      ['events_v', 'v'],
      ['events_mv', 'm'],
      ['events_part', 'p'],
      ['events_ext', 'f'],
    ]);
    expect(nodes.map(n => [n.name, n.kind, n.detail])).toEqual([
      ['events', 'table', undefined],
      ['events_v', 'view', undefined],
      ['events_mv', 'view', 'materialized view'],
      ['events_part', 'table', 'partitioned'],
      ['events_ext', 'table', 'foreign'],
    ]);
    expect(nodes[0]?.insert).toBe('"public"."events"');
    expect(nodes[0]?.query).toBe('SELECT *\nFROM "public"."events"\nLIMIT 100');
  });

  it('puts the column type in the detail line and offers no query', () => {
    expect(postgresBrowseNodes(['public', 'events'], [['id', 'int4'], ['body', null]])).toEqual([
      { kind: 'column', name: 'id', detail: 'int4', hasChildren: false, insert: '"id"' },
      { kind: 'column', name: 'body', detail: '', hasChildren: false, insert: '"body"' },
    ]);
  });
});

describe('error classification', () => {
  const cases: readonly [string, string, ErrorCode][] = [
    ['28P01', 'invalid_password', 'auth'],
    ['28000', 'invalid_authorization_specification', 'auth'],
    ['42601', 'syntax_error', 'sql'],
    ['42P01', 'undefined_table', 'sql'],
    ['42501', 'insufficient_privilege', 'sql'],
    ['3D000', 'invalid_catalog_name', 'sql'],
    ['3F000', 'invalid_schema_name', 'sql'],
    ['23505', 'unique_violation', 'sql'],
    ['22012', 'division_by_zero', 'sql'],
    ['53300', 'too_many_connections', 'sql'],
    ['08006', 'connection_failure', 'network'],
    ['08001', 'sqlclient_unable_to_establish', 'network'],
    ['57014', 'query_canceled', 'cancelled'],
    ['57P01', 'admin_shutdown', 'network'],
    ['57P03', 'cannot_connect_now', 'network'],
    ['ECONNREFUSED', 'nothing listening', 'network'],
    ['ENOTFOUND', 'no such host', 'network'],
    ['CERT_HAS_EXPIRED', 'stale certificate', 'network'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'wrong hostname in cert', 'network'],
  ];

  for (const [code, name, expected] of cases) {
    it(`maps ${code} (${name}) to ${expected}`, () => {
      expect(classifyPostgresError(Object.assign(new Error(name), { code }))).toBe(expected);
    });
  }

  it('reads an abort as a cancellation however the driver spelled it', () => {
    expect(classifyPostgresError(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      .toBe('cancelled');
  });

  it('reads a server that hung up without a code as a network failure', () => {
    expect(classifyPostgresError(new Error('Connection terminated unexpectedly'))).toBe('network');
  });

  it('does not mistake a message for a SQLSTATE', () => {
    expect(classifyPostgresError(new Error('something odd'))).toBe('internal');
    // Five characters, but not a state: a parser error from somewhere else.
    expect(classifyPostgresError(Object.assign(new Error('x'), { code: '28abc' }))).toBe('internal');
  });
});

describe('error wrapping', () => {
  it('keeps the SQLSTATE, names the connection and marks network failures retryable', () => {
    const wrapped = postgresError(
      Object.assign(new Error('connection failure'), { code: '08006' }),
      'warehouse',
    );
    expect(wrapped.code).toBe('network');
    expect(wrapped.details.connection).toBe('warehouse');
    expect(wrapped.details.nativeCode).toBe('08006');
    expect(wrapped.details.retryable).toBe(true);
    expect(wrapped.details.hint).toMatch(/sslmode/);
  });

  it('does not mark a rejected statement retryable', () => {
    const wrapped = postgresError(Object.assign(new Error('syntax error'), { code: '42601' }), 'warehouse');
    expect(wrapped.code).toBe('sql');
    expect(wrapped.details.retryable).toBe(false);
  });

  it('passes a DbRexError through untouched', () => {
    const original = new DbRexError('forbidden', 'no');
    expect(postgresError(original, 'warehouse')).toBe(original);
  });
});

describe('sslmode', () => {
  it('turns TLS off for disable, which is what a local container wants', () => {
    expect(sslOptionFor('disable', endpoint, 'local')).toBe(false);
  });

  it('encrypts without judging the certificate for require', () => {
    expect(sslOptionFor('require', endpoint, 'staging'))
      .toEqual({ rejectUnauthorized: false });
  });

  it('verifies the chain but not the hostname for verify-ca', () => {
    const option = sslOptionFor('verify-ca', endpoint, 'prod');
    expect(option).toMatchObject({ rejectUnauthorized: true });
    expect(typeof (option as { checkServerIdentity?: unknown }).checkServerIdentity).toBe('function');
  });

  it('verifies the real hostname for verify-full, even through a tunnel', () => {
    expect(sslOptionFor('verify-full', endpoint, 'prod'))
      .toEqual({ rejectUnauthorized: true, servername: 'db.example' });
    expect(sslOptionFor(
      'verify-full',
      { host: '127.0.0.1', port: 15432, tlsServerName: 'warehouse.internal' },
      'prod',
    )).toEqual({ rejectUnauthorized: true, servername: 'warehouse.internal' });
  });

  it('rejects an unknown mode as a config error naming the alternatives', () => {
    try {
      sslOptionFor('prefer', endpoint, 'prod');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as DbRexError).code).toBe('config');
      expect((e as DbRexError).details.hint).toBe(`sslmode must be one of: ${SSL_MODES.join(', ')}`);
    }
  });
});
