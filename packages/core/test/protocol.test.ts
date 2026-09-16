import { describe, expect, it } from 'vitest';
import { canAnswerSecrets, canRelayBrowser, type ClientRole } from '../src/protocol';

const roles: ClientRole[] = ['ui', 'tty', 'agent', 'headless'];

describe('role permissions', () => {
  it('lets only interactive local clients answer secrets', () => {
    expect(roles.filter(canAnswerSecrets)).toEqual(['ui', 'tty']);
  });

  it('never lets an agent answer a secret', () => {
    // A password typed into a chat window lands in a transcript and in model
    // logs. This is the one rule the protocol exists to enforce.
    expect(canAnswerSecrets('agent')).toBe(false);
  });

  it('lets an agent relay a login URL, which is public and single-use', () => {
    expect(roles.filter(canRelayBrowser)).toEqual(['ui', 'tty', 'agent']);
  });
});
