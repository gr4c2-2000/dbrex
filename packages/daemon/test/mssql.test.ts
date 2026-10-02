import { describe, expect, it } from 'vitest';
import { DbRexError } from '@dbrex/core';
import {
  AUTH_MODES,
  MSSQL_CAPABILITIES,
  classifyMssql,
  mssqlBrowseNodes,
  mssqlBrowseQuery,
  mssqlError,
  mssqlProvider,
  quoteMssqlIdent,
} from '../src/providers/mssql';

describe('identifiers', () => {
  it('uses brackets, which mean the same thing whatever QUOTED_IDENTIFIER is set to', () => {
    expect(quoteMssqlIdent('events')).toBe('[events]');
  });

  it('quotes a name that could not be written bare', () => {
    expect(quoteMssqlIdent('order details')).toBe('[order details]');
  });

  it('doubles a closing bracket inside a name', () => {
    expect(quoteMssqlIdent('odd]name')).toBe('[odd]]name]');
  });
});

describe('introspection SQL', () => {
  it('asks for schemas at the root, and binds nothing', () => {
    const { sql, params } = mssqlBrowseQuery([]);
    expect(sql).toContain('sys.schemas');
    expect(params).toEqual([]);
  });

  it('leaves the built-in role schemas out, which nobody opened the tree to see', () => {
    const { sql } = mssqlBrowseQuery([]);
    expect(sql).toContain("'db_datareader'");
    expect(sql).toContain("'INFORMATION_SCHEMA'");
  });

  it('asks INFORMATION_SCHEMA for tables, binding the schema', () => {
    const { sql, params } = mssqlBrowseQuery(['dbo']);
    expect(sql).toContain('INFORMATION_SCHEMA.TABLES');
    expect(params).toEqual(['dbo']);
  });

  it('asks for columns in ordinal order, binding both names', () => {
    const { sql, params } = mssqlBrowseQuery(['dbo', 'events']);
    expect(sql).toContain('INFORMATION_SCHEMA.COLUMNS');
    expect(sql).toContain('ORDINAL_POSITION');
    expect(params).toEqual(['dbo', 'events']);
  });

  it('never interpolates a name into the statement', () => {
    // A schema named after an apostrophe is the case a hand-written escape gets
    // wrong, so the names must travel as parameters and not as text.
    const { sql, params } = mssqlBrowseQuery(["o'brien", "it's"]);
    expect(sql).not.toContain("o'brien");
    expect(params).toEqual(["o'brien", "it's"]);
  });
});

describe('tree nodes', () => {
  it('turns schemas into expandable nodes', () => {
    expect(mssqlBrowseNodes([], [['dbo'], ['reporting']])).toEqual([
      { kind: 'schema', name: 'dbo', hasChildren: true, insert: '[dbo]' },
      { kind: 'schema', name: 'reporting', hasChildren: true, insert: '[reporting]' },
    ]);
  });

  it('distinguishes a view from a table', () => {
    const nodes = mssqlBrowseNodes(['dbo'], [['events', 'BASE TABLE'], ['busy', 'VIEW']]);
    expect(nodes.map(n => n.kind)).toEqual(['table', 'view']);
  });

  it('offers a table as a schema-qualified name, not a bare one', () => {
    const [node] = mssqlBrowseNodes(['dbo'], [['events', 'BASE TABLE']]);
    expect(node?.insert).toBe('[dbo].[events]');
  });

  it('hands a statement that runs, with the limit T-SQL accepts', () => {
    const [node] = mssqlBrowseNodes(['dbo'], [['events', 'BASE TABLE']]);
    expect(node?.query).toBe('SELECT TOP 100 *\nFROM [dbo].[events]');
  });

  it('describes a column with its length and its nullability', () => {
    const nodes = mssqlBrowseNodes(['dbo', 'events'], [
      ['kind', 'nvarchar', 'YES', 32],
      ['hits', 'bigint', 'NO', null],
    ]);
    expect(nodes.map(n => n.detail)).toEqual(['nvarchar(32) NULL', 'bigint NOT NULL']);
  });

  it('leaves the length off a type that has none', () => {
    const [node] = mssqlBrowseNodes(['dbo', 'events'], [['day', 'date', 'NO', null]]);
    expect(node?.detail).toBe('date NOT NULL');
    expect(node?.hasChildren).toBe(false);
  });
});

describe('classifying a failure', () => {
  it('reads a login failure as auth, by its number', () => {
    expect(classifyMssql(18456)).toBe('auth');
    expect(classifyMssql(18452)).toBe('auth');
  });

  it('reads an unreachable database as auth, because that is what 4060 means', () => {
    expect(classifyMssql(4060)).toBe('auth');
  });

  it('reads an Azure firewall rejection as auth rather than network', () => {
    // The socket connected; the server refused this client. Calling it a network
    // failure would send the user to check the wrong thing.
    expect(classifyMssql(40615)).toBe('auth');
  });

  it('reads an invalid object name as not_found', () => {
    expect(classifyMssql(208)).toBe('not_found');
  });

  it('reads a permission error as forbidden', () => {
    expect(classifyMssql(229)).toBe('forbidden');
  });

  it('reads anything else the server numbered as a SQL problem', () => {
    expect(classifyMssql(102)).toBe('sql');
    expect(classifyMssql(8134)).toBe('sql');
  });

  it('reads a transport code as network, and a timeout as a timeout', () => {
    expect(classifyMssql(undefined, 'ESOCKET')).toBe('network');
    expect(classifyMssql(undefined, 'ENOTFOUND')).toBe('network');
    expect(classifyMssql(undefined, 'ETIMEOUT')).toBe('timeout');
  });

  it('prefers the transport code over a number, since the socket failed first', () => {
    expect(classifyMssql(18456, 'ESOCKET')).toBe('network');
  });

  it('falls back to a SQL problem when it knows neither', () => {
    expect(classifyMssql()).toBe('sql');
  });
});

describe('the error a failure becomes', () => {
  it('keeps the server message rather than inventing one', () => {
    const e = mssqlError({ number: 208, message: "Invalid object name 'dbo.nope'." }, 'wh');
    expect(e.message).toBe("Invalid object name 'dbo.nope'.");
    expect(e.code).toBe('not_found');
  });

  it('keeps the error number, which is stable where the message is localised', () => {
    expect(mssqlError({ number: 208, message: 'x' }, 'wh').details.nativeCode).toBe('208');
  });

  it('keeps a transport code when there is no number', () => {
    expect(mssqlError({ code: 'ESOCKET', message: 'socket hang up' }, 'wh').details.nativeCode)
      .toBe('ESOCKET');
  });

  it('points an Azure firewall rejection at the firewall', () => {
    expect(mssqlError({ number: 40615, message: 'x' }, 'wh').details.hint).toMatch(/firewall/);
  });

  it('points a login failure at token auth, which is what Fabric needs', () => {
    expect(mssqlError({ number: 18456, message: 'x' }, 'wh').details.hint).toMatch(/token/);
  });

  it('marks a transport failure retryable and a rejected statement not', () => {
    expect(mssqlError({ code: 'ECONNRESET', message: 'x' }, 'wh').details.retryable).toBe(true);
    expect(mssqlError({ number: 102, message: 'x' }, 'wh').details.retryable).toBe(false);
  });

  it('names the connection', () => {
    expect(mssqlError({ number: 102, message: 'x' }, 'warehouse').details.connection).toBe('warehouse');
  });

  it('passes a DbRexError through rather than wrapping it twice', () => {
    const original = new DbRexError('timeout', 'already classified');
    expect(mssqlError(original, 'wh')).toBe(original);
  });

  it('reads an abort as a cancellation, not as a lost connection', () => {
    const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(mssqlError(aborted, 'wh').code).toBe('cancelled');
  });

  it('survives something that is not an error object at all', () => {
    expect(mssqlError('just a string', 'wh').message).toBe('just a string');
  });
});

describe('what the provider declares', () => {
  const field = (name: string) => mssqlProvider.fields.find(f => f.name === name);

  it('is addressed by host and port, which is what earns it SSH tunnelling', () => {
    expect(field('host')?.required).toBe(true);
    expect(field('port')?.default).toBe(1433);
  });

  it('encrypts by default, because every managed one of these requires it', () => {
    expect(field('encrypt')?.default).toBe(true);
  });

  it('verifies the certificate by default', () => {
    expect(field('trustServerCertificate')?.default).toBe(false);
  });

  it('defaults to password auth and offers a token for Entra-only servers', () => {
    expect(field('auth')?.default).toBe('password');
    expect(AUTH_MODES).toEqual(['password', 'token']);
  });

  it('declares TOP, not the standard clause that would not parse', () => {
    expect(MSSQL_CAPABILITIES.limit).toBe('top');
  });

  it('declares a real server-side cancel, which TDS carries', () => {
    expect(MSSQL_CAPABILITIES.cancel).toBe('server');
  });

  it('declares streaming and parse-only validation', () => {
    expect(MSSQL_CAPABILITIES.streams).toBe(true);
    expect(MSSQL_CAPABILITIES.validate).toBe(true);
    expect(MSSQL_CAPABILITIES.explain).toBe('validate');
  });

  it('names all four products it serves, so the wizard says what it covers', () => {
    expect(mssqlProvider.id).toBe('mssql');
    for (const product of ['SQL Server', 'Azure SQL', 'Synapse', 'Fabric']) {
      expect(mssqlProvider.displayName).toContain(product);
    }
  });
});
