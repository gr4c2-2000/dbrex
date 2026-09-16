import { describe, expect, it } from 'vitest';
import { DbRexError, isAbortError, messageOf } from '../src/errors';

describe('DbRexError', () => {
  it('survives a round trip over the wire', () => {
    const original = new DbRexError('auth', 'bad password', { connection: 'prod', retryable: true });
    const revived = DbRexError.fromWire(JSON.parse(JSON.stringify(original.toWire())));
    expect(revived.code).toBe('auth');
    expect(revived.message).toBe('bad password');
    expect(revived.details.connection).toBe('prod');
  });

  it('wraps a driver error without losing the cause', () => {
    const driver = new Error('ECONNREFUSED');
    const wrapped = DbRexError.wrap('network', driver, { connection: 'prod' });
    expect(wrapped.code).toBe('network');
    expect(wrapped.message).toBe('ECONNREFUSED');
    expect(wrapped.cause).toBe(driver);
  });

  it('passes an DbRexError through unchanged rather than reclassifying it', () => {
    const already = new DbRexError('sql', 'syntax error');
    expect(DbRexError.wrap('network', already)).toBe(already);
  });
});

describe('messageOf', () => {
  it('handles the shapes drivers actually throw', () => {
    expect(messageOf(new Error('boom'))).toBe('boom');
    expect(messageOf('boom')).toBe('boom');
    expect(messageOf({ message: '' })).toBe('[object Object]');
    expect(messageOf(null)).toBe('null');
  });
});

describe('isAbortError', () => {
  it('recognises an AbortSignal rejection', () => {
    const c = new AbortController();
    c.abort();
    expect(isAbortError(c.signal.reason)).toBe(true);
    expect(isAbortError(new Error('nope'))).toBe(false);
  });
});
