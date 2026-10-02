import { describe, expect, it } from 'vitest';
import type { FieldSpec } from '@dbrex/core';
import {
  buildEntry,
  coerceField,
  formProvider,
  scopeOptions,
  validateSubmission,
} from '../src/connectionEntry';
import type { FormSubmission } from '../src/connectionFormProtocol';

const field = (over: Partial<FieldSpec> & { name: string }): FieldSpec =>
  ({ type: 'string', description: '', ...over });

const submission = (over: Partial<FormSubmission> = {}): FormSubmission => ({
  name: 'prod',
  kind: 'mysql',
  reference: '',
  scope: 'global',
  options: {},
  password: '',
  ...over,
});

describe('coercing what a control produced', () => {
  it('keeps a string, trimmed', () => {
    expect(coerceField(field({ name: 'host' }), '  db.example  ')).toBe('db.example');
  });

  it('turns a numeric field into a number', () => {
    expect(coerceField(field({ name: 'port', type: 'number' }), '3306')).toBe(3306);
  });

  it('reports a number that is not one, rather than writing the text', () => {
    expect(coerceField(field({ name: 'port', type: 'number' }), 'threeish')).toBeNaN();
  });

  it('reads a checkbox as a boolean, in each spelling a form might send', () => {
    const f = field({ name: 'encrypt', type: 'boolean' });
    expect(coerceField(f, 'true')).toBe(true);
    expect(coerceField(f, 'on')).toBe(true);
    expect(coerceField(f, '1')).toBe(true);
    expect(coerceField(f, 'false')).toBe(false);
  });

  it('leaves a blank out entirely rather than writing an empty string', () => {
    // A provider tells an absent option from a present empty one: absent means
    // "use the default", and empty means "the host is the empty string".
    expect(coerceField(field({ name: 'database' }), '')).toBeUndefined();
    expect(coerceField(field({ name: 'database' }), '   ')).toBeUndefined();
    expect(coerceField(field({ name: 'database' }), undefined)).toBeUndefined();
  });

  it('leaves out a boolean the form never drew', () => {
    expect(coerceField(field({ name: 'encrypt', type: 'boolean' }), undefined)).toBeUndefined();
  });

  it('keeps a zero, which is a value and not a blank', () => {
    expect(coerceField(field({ name: 'maxFiles', type: 'number' }), '0')).toBe(0);
  });
});

describe('validating a submission', () => {
  it('accepts a complete one', () => {
    expect(validateSubmission(
      submission({ options: { host: 'db' } }),
      [field({ name: 'host', required: true })],
      [],
    )).toEqual([]);
  });

  it('requires a name', () => {
    expect(validateSubmission(submission({ name: '  ' }), [], []))
      .toEqual([{ field: 'name', message: 'a name is required' }]);
  });

  it('refuses a name already taken', () => {
    // Caught here rather than by the daemon, which would load both entries and
    // let one of them silently win.
    const problems = validateSubmission(submission({ name: 'prod' }), [], ['prod']);
    expect(problems).toEqual([{ field: 'name', message: 'a connection named "prod" already exists' }]);
  });

  it('compares the trimmed name against what exists', () => {
    expect(validateSubmission(submission({ name: ' prod ' }), [], ['prod'])).toHaveLength(1);
  });

  it('requires a kind', () => {
    expect(validateSubmission(submission({ kind: '' }), [], []).map(p => p.field)).toContain('kind');
  });

  it('names each missing required field', () => {
    const problems = validateSubmission(
      submission(),
      [field({ name: 'host', required: true }), field({ name: 'user', required: true })],
      [],
    );
    expect(problems.map(p => p.field)).toEqual(['host', 'user']);
  });

  it('does not require an optional field', () => {
    expect(validateSubmission(submission(), [field({ name: 'database' })], [])).toEqual([]);
  });

  it('reports a number that is not one', () => {
    const problems = validateSubmission(
      submission({ options: { port: 'abc' } }),
      [field({ name: 'port', type: 'number' })],
      [],
    );
    expect(problems).toEqual([{ field: 'port', message: 'port must be a number' }]);
  });

  it('reports a required field before complaining it is not a number', () => {
    // One problem per field: two messages about the same empty box is noise.
    const problems = validateSubmission(
      submission({ options: { port: '' } }),
      [field({ name: 'port', type: 'number', required: true })],
      [],
    );
    expect(problems).toEqual([{ field: 'port', message: 'port is required' }]);
  });

  it('collects everything wrong at once, so the form reports it in one pass', () => {
    const problems = validateSubmission(
      submission({ name: '', options: { port: 'x' } }),
      [field({ name: 'host', required: true }), field({ name: 'port', type: 'number' })],
      [],
    );
    expect(problems.map(p => p.field)).toEqual(['name', 'host', 'port']);
  });
});

describe('building the entry', () => {
  const fields = [
    field({ name: 'host' }),
    field({ name: 'port', type: 'number' }),
    field({ name: 'encrypt', type: 'boolean' }),
    field({ name: 'database' }),
  ];

  it('puts the options in an options block', () => {
    // Nested rather than at the top level, so a provider option called `name` or
    // `kind` cannot collide with a key the file format owns.
    const entry = buildEntry(submission({ options: { host: 'db', port: '3306' } }), fields);
    expect(entry).toEqual({ name: 'prod', kind: 'mysql', options: { host: 'db', port: 3306 } });
  });

  it('trims the name and the kind', () => {
    const entry = buildEntry(submission({ name: ' prod ', kind: ' mysql ' }), fields);
    expect(entry['name']).toBe('prod');
    expect(entry['kind']).toBe('mysql');
  });

  it('leaves out an option that was not filled in', () => {
    const entry = buildEntry(submission({ options: { host: 'db', database: '' } }), fields);
    expect(entry['options']).toEqual({ host: 'db' });
  });

  it('writes a false checkbox, because false is an answer', () => {
    const entry = buildEntry(submission({ options: { encrypt: 'false' } }), fields);
    expect(entry['options']).toEqual({ encrypt: false });
  });

  it('includes a reference when there is one, and omits it when not', () => {
    expect(buildEntry(submission({ reference: ' orders ' }), fields)['reference']).toBe('orders');
    expect(buildEntry(submission({ reference: '  ' }), fields)['reference']).toBeUndefined();
  });

  it('declares a vault secret when a password was typed', () => {
    // The password itself goes to the vault; the file only records where to look.
    const entry = buildEntry(submission({ password: 'hunter2' }), fields);
    expect(entry['secret']).toEqual({ from: 'vault' });
    expect(JSON.stringify(entry)).not.toContain('hunter2');
  });

  it('declares no secret source when no password was typed', () => {
    expect(buildEntry(submission(), fields)['secret']).toBeUndefined();
  });

  it('ignores a value for a field the provider does not declare', () => {
    const entry = buildEntry(submission({ options: { host: 'db', nonsense: 'x' } }), fields);
    expect(entry['options']).toEqual({ host: 'db' });
  });
});

describe('what each scope writes to', () => {
  it('shows the global file, which is always available', () => {
    const [global] = scopeOptions('/home/me/.dbrex', '/repo');
    expect(global).toEqual({
      scope: 'global',
      file: '/home/me/.dbrex/connections.json',
      available: true,
    });
  });

  it('shows the workspace file when a folder is open', () => {
    const workspace = scopeOptions('/home/me/.dbrex', '/repo')[1];
    expect(workspace).toEqual({
      scope: 'workspace',
      file: '/repo/.dbrex/connections.json',
      available: true,
    });
  });

  it('says there is nowhere to put a workspace file when no folder is open', () => {
    // "This workspace" means nothing without one, and the form has to be able
    // to say so rather than offer a path it would fail to write.
    const workspace = scopeOptions('/home/me/.dbrex', undefined)[1];
    expect(workspace?.available).toBe(false);
    expect(workspace?.file).toBe('(no folder is open)');
  });
});

describe('describing a provider to the form', () => {
  const provider = (fields: FieldSpec[]) =>
    formProvider({ id: 'x', displayName: 'X', capabilities: {} as never, fields });

  it('offers a password to an engine that authenticates a user', () => {
    expect(provider([field({ name: 'host' }), field({ name: 'user' })]).takesSecret).toBe(true);
  });

  it('offers none to an engine that has no user, such as a local directory', () => {
    // Read from the declared fields rather than from a list of engine names, so
    // a provider added later is described correctly without editing this.
    expect(provider([field({ name: 'path' })]).takesSecret).toBe(false);
  });

  it('passes the fields through untouched, since the form draws them', () => {
    const fields = [field({ name: 'host' }), field({ name: 'port', type: 'number' })];
    expect(provider(fields).fields).toEqual(fields);
  });
});
