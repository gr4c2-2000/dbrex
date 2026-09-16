/** Where the daemon keeps its things, and how a client finds them. */

import * as os from 'node:os';
import * as path from 'node:path';
import { configDirFor, resolveSocketPath, type SocketEnvironment } from '@dbrex/core';

export function socketEnvironment(env: NodeJS.ProcessEnv = process.env): SocketEnvironment {
  return {
    dbrexSocket: env['DBREX_SOCKET'],
    dbrexHome: env['DBREX_HOME'],
    home: os.homedir(),
    tmpDir: os.tmpdir(),
    uid: typeof process.getuid === 'function' ? process.getuid() : 0,
  };
}

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return configDirFor(socketEnvironment(env));
}

export function socketPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveSocketPath(socketEnvironment(env)).socketPath;
}

/**
 * The daemon entry point to spawn.
 *
 * `DBREX_DAEMON` exists so a development checkout can point at a build without
 * installing anything; the packaged default sits next to this file.
 */
export function daemonPath(env: NodeJS.ProcessEnv = process.env): string {
  return env['DBREX_DAEMON'] ?? path.join(__dirname, 'dbrexd.js');
}
