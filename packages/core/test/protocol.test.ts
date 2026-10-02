import { describe, expect, it } from 'vitest';
import {
  canAnswerSecrets,
  canRelayBrowser,
  originLabel,
  originOfRole,
  type ClientRole,
} from '../src/protocol';

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

describe('where a result came from', () => {
  it('maps every client role to an origin', () => {
    expect(originOfRole('ui')).toBe('editor');
    expect(originOfRole('tty')).toBe('terminal');
    expect(originOfRole('agent')).toBe('agent');
    // A script writes to the same history and is none of the three.
    expect(originOfRole('headless')).toBe('unknown');
  });

  it('labels each origin with the word the user asked for', () => {
    expect(originLabel('editor')).toBe('vscode');
    expect(originLabel('terminal')).toBe('cmd');
    expect(originLabel('agent')).toBe('mcp');
    expect(originLabel('unknown')).toBe('script');
  });

  it('labels a result stored before provenance was recorded', () => {
    expect(originLabel(undefined)).toBe('—');
  });

  it('gives every origin a label, so a listing cannot print undefined', () => {
    for (const origin of ['editor', 'terminal', 'agent', 'unknown'] as const) {
      expect(originLabel(origin)).not.toBe('');
      expect(originLabel(origin)).not.toContain('undefined');
    }
  });
});
