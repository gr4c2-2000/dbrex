/**
 * Where the socket lives.
 *
 * Every client and the daemon itself must agree on this, so it is computed in
 * one place from the environment rather than assembled independently three
 * times.
 *
 * Derived from the configuration directory and nothing else.
 *
 * It is tempting to prefer `XDG_RUNTIME_DIR`, and an earlier version did. That
 * was a bug: the runtime directory is a property of a login session, not of an
 * installation. A terminal has it and an editor-spawned child process may not,
 * so the two ended up looking for the daemon in different places — the terminal
 * found it, an MCP bridge did not, and nothing about the symptom pointed at the
 * cause. Everything sharing a configuration directory must agree on one socket.
 *
 * The remaining constraint: a Unix domain socket path is limited to 108 bytes on
 * Linux and 104 on macOS, including the terminator. A configuration directory
 * nested a few levels deep blows through that and `listen` fails with an opaque
 * `EINVAL`, so an over-long path falls back to a short directory keyed by user
 * id — still the same answer for every process.
 */

const MAX_SOCKET_BYTES = 100;

export interface SocketEnvironment {
  readonly dbrexSocket?: string | undefined;
  readonly dbrexHome?: string | undefined;
  readonly home: string;
  readonly tmpDir: string;
  /** Numeric user id, used to keep the fallback directory private per user. */
  readonly uid: number;
}

export interface SocketLocation {
  readonly socketPath: string;
  /** The directory to create at mode 0700 before binding. */
  readonly socketDir: string;
  /** Set when the preferred location was too long and we moved. */
  readonly fallbackReason?: string;
}

export function configDirFor(env: SocketEnvironment): string {
  return env.dbrexHome ?? join(env.home, '.dbrex');
}

export function resolveSocketPath(env: SocketEnvironment): SocketLocation {
  if (env.dbrexSocket !== undefined && env.dbrexSocket.length > 0) {
    return { socketPath: env.dbrexSocket, socketDir: dirname(env.dbrexSocket) };
  }

  const preferred = join(configDirFor(env), 'run');

  const candidate = join(preferred, 'dbrexd.sock');
  if (byteLength(candidate) <= MAX_SOCKET_BYTES) {
    return { socketPath: candidate, socketDir: preferred };
  }

  const shortDir = join(env.tmpDir, `dbrex-${env.uid}`);
  return {
    socketPath: join(shortDir, 'dbrexd.sock'),
    socketDir: shortDir,
    fallbackReason:
      `${candidate} is ${byteLength(candidate)} bytes, over the ${MAX_SOCKET_BYTES}-byte ` +
      'limit for a Unix socket path',
  };
}

function byteLength(text: string): number {
  // Path length is measured in bytes, and a non-ASCII home directory costs more
  // than its character count suggests.
  let bytes = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** Join without importing node:path, so core stays free of platform modules. */
function join(...parts: readonly string[]): string {
  return parts
    .map((part, i) => (i === 0 ? part.replace(/\/+$/, '') : part.replace(/^\/+|\/+$/g, '')))
    .filter(part => part.length > 0)
    .join('/');
}

function dirname(filePath: string): string {
  const at = filePath.lastIndexOf('/');
  return at <= 0 ? '/' : filePath.slice(0, at);
}
