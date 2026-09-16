import { describe, expect, it } from 'vitest';
import { Options, validateOptions, withDefaults, type FieldSpec } from '../src/spec';
import { substituteDeep, substituteVars } from '../src/vars';
import { DbRexError } from '../src/errors';

const fields: readonly FieldSpec[] = [
  { name: 'host', type: 'string', description: 'host', required: true },
  { name: 'port', type: 'number', description: 'port', default: 3306 },
  { name: 'ssl', type: 'boolean', description: 'ssl' },
];

describe('validateOptions', () => {
  it('accepts a valid bag', () => {
    expect(validateOptions({ host: 'db', port: 3306 }, fields)).toEqual([]);
  });

  it('reports every problem at once', () => {
    const problems = validateOptions({ port: 'nope', bogus: 1 }, fields);
    expect(problems.map(p => p.field).sort()).toEqual(['bogus', 'host', 'port']);
  });

  it('does not require a field that has a default', () => {
    expect(validateOptions({ host: 'db' }, fields)).toEqual([]);
  });
});

describe('withDefaults', () => {
  it('fills only absent fields', () => {
    expect(withDefaults({ host: 'db' }, fields)).toEqual({ host: 'db', port: 3306 });
    expect(withDefaults({ host: 'db', port: 1 }, fields)).toEqual({ host: 'db', port: 1 });
  });
});

describe('Options', () => {
  const o = new Options({ host: 'db', port: 3306, ssl: true, empty: '' }, 'prod');

  it('reads typed values', () => {
    expect(o.str('host')).toBe('db');
    expect(o.num('port')).toBe(3306);
    expect(o.bool('ssl')).toBe(true);
  });

  it('treats an empty string as absent', () => {
    expect(o.str('empty')).toBeUndefined();
  });

  it('throws a config error naming the connection and the option', () => {
    try {
      o.reqStr('database');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(DbRexError.is(e)).toBe(true);
      expect((e as DbRexError).code).toBe('config');
      expect((e as DbRexError).message).toContain('database');
      expect((e as DbRexError).details.connection).toBe('prod');
    }
  });
});

describe('substituteVars', () => {
  const ctx = { user: 'marc', home: '/home/marc', env: { TOKEN: 's3cr3t' } };

  it('substitutes user, home, env and a leading tilde', () => {
    expect(substituteVars('$user', ctx)).toBe('marc');
    expect(substituteVars('$home/x', ctx)).toBe('/home/marc/x');
    expect(substituteVars('$env:TOKEN', ctx)).toBe('s3cr3t');
    expect(substituteVars('~/.ssh/id_ed25519', ctx)).toBe('/home/marc/.ssh/id_ed25519');
  });

  it('substitutes an unset env var to empty', () => {
    expect(substituteVars('$env:NOPE', ctx)).toBe('');
  });

  it('leaves a tilde that is not a path prefix alone', () => {
    expect(substituteVars('a~b', ctx)).toBe('a~b');
  });

  it('walks nested structures', () => {
    expect(substituteDeep({ a: ['$user', { b: '$home' }], n: 1 }, ctx))
      .toEqual({ a: ['marc', { b: '/home/marc' }], n: 1 });
  });
});
