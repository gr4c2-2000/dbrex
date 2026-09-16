import { describe, expect, it } from 'vitest';
import { configDirFor, resolveSocketPath, type SocketEnvironment } from '../src/paths';

const base: SocketEnvironment = {
  home: '/home/marc',
  tmpDir: '/tmp',
  uid: 1000,
};

describe('resolveSocketPath', () => {
  it('lives under the config directory', () => {
    expect(resolveSocketPath(base).socketPath).toBe('/home/marc/.dbrex/run/dbrexd.sock');
  });

  it('gives every caller the same answer, whatever their session looks like', () => {
    // An earlier version preferred XDG_RUNTIME_DIR. A terminal has it; a process
    // spawned by an editor may not — so the two looked for the daemon in
    // different places, one found it and the other reported "not connected",
    // and nothing about the symptom pointed at the cause.
    const fromTerminal = resolveSocketPath({ ...base, home: '/home/marc' });
    const fromSpawnedChild = resolveSocketPath({ home: '/home/marc', tmpDir: '/tmp', uid: 1000 });
    expect(fromTerminal.socketPath).toBe(fromSpawnedChild.socketPath);
  });

  it('honours an explicit DBREX_SOCKET', () => {
    const location = resolveSocketPath({ ...base, dbrexSocket: '/tmp/custom/x.sock' });
    expect(location).toMatchObject({ socketPath: '/tmp/custom/x.sock', socketDir: '/tmp/custom' });
  });

  it('honours DBREX_HOME', () => {
    expect(resolveSocketPath({ ...base, dbrexHome: '/opt/dbrex' }).socketPath)
      .toBe('/opt/dbrex/run/dbrexd.sock');
  });

  it('keeps an explicit DBREX_HOME off the shared runtime socket', () => {
    // Otherwise a sandbox pointed at its own config directory would connect to
    // whichever daemon already owns the runtime socket and quietly read that
    // daemon's connections instead of its own.
    const location = resolveSocketPath({ ...base, dbrexHome: '/opt/sandbox' });
    expect(location.socketPath).toBe('/opt/sandbox/run/dbrexd.sock');
  });

  it('moves to a short path rather than failing with EINVAL', () => {
    // A Unix socket path is capped at 108 bytes; a deep config directory blows
    // through it and `listen` fails with an error that says nothing useful.
    const deep = `/home/marc/${'nested/'.repeat(20)}dbrex`;
    const location = resolveSocketPath({ ...base, dbrexHome: deep });

    expect(location.socketPath).toBe('/tmp/dbrex-1000/dbrexd.sock');
    expect(location.fallbackReason).toMatch(/over the 100-byte limit/);
  });

  it('counts bytes, not characters', () => {
    const home = `/home/${'ż'.repeat(48)}`;
    // 48 two-byte characters plus the rest is over the limit even though the
    // character count is not.
    expect(resolveSocketPath({ ...base, dbrexHome: `${home}/.dbrex` }).fallbackReason).toBeDefined();
  });

  it('keeps the directory to create alongside the socket', () => {
    expect(resolveSocketPath(base).socketDir).toBe('/home/marc/.dbrex/run');
  });
});

describe('configDirFor', () => {
  it('defaults to ~/.dbrex and honours DBREX_HOME', () => {
    expect(configDirFor(base)).toBe('/home/marc/.dbrex');
    expect(configDirFor({ ...base, dbrexHome: '/opt/dbrex' })).toBe('/opt/dbrex');
  });
});
