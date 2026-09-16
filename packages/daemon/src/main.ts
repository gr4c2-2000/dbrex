/**
 * `dbrexd` — the daemon.
 *
 * It owns database sessions, secrets and results; VSCode, the CLI and any AI
 * agent are clients of equal standing. That is the difference from the old
 * design, where the extension host owned everything and a router process merely
 * proxied to it: close the editor and the agent went blind. Here closing the
 * editor removes a display, not the machinery.
 *
 * Started by whichever client notices it is missing, or by hand for debugging:
 *
 *   dbrexd --foreground
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DbRexError,
  configDirFor,
  messageOf,
  resolveSocketPath,
  type SettingsPatch,
  type SocketEnvironment,
} from '@dbrex/core';
import { Broker } from './broker';
import { ConnectionRegistry, globalFile, workspaceFile } from './connections';
import { Logger, type Level } from './log';
import { builtinProviders } from './providers/builtin';
import { ProviderRegistry } from './providers/registry';
import { SecretResolver } from './secrets';
import { Server } from './server';
import { SessionPool } from './sessions';
import { ResultStore } from './store/results';
import { Vault } from './vault';
import { ConfigWatcher } from './watch';

export const VERSION = '0.1.0';

export interface Settings {
  readonly logLevel: Level;
  readonly logRetentionDays: number;
  readonly logMaxBytes: number;
  readonly resultsMode: 'sliding' | 'unlimited';
  readonly resultsMaxBytes: number;
  /** Exit after this long with no clients attached. 0 keeps the daemon alive. */
  readonly idleExitMs: number;
  /**
   * Show an agent's results on screen the moment they land.
   *
   * On by default, as it was in the previous generation of this tool: an agent
   * that queries your database while you watch is the entire point, and work
   * you cannot see is work you cannot check.
   */
  readonly showAgentResults: boolean;
  readonly identityUser?: string;
}

const DEFAULTS: Settings = {
  logLevel: 'info',
  logRetentionDays: 14,
  logMaxBytes: 100 * 1024 * 1024,
  resultsMode: 'sliding',
  resultsMaxBytes: 500 * 1024 * 1024,
  // Long enough that closing VSCode does not strand an agent mid-conversation,
  // short enough that a forgotten daemon does not live forever.
  idleExitMs: 30 * 60 * 1000,
  showAgentResults: true,
};

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

/** Merge a patch into settings.json, keeping whatever else is in the file. */
export function writeSettings(dir: string, patch: SettingsPatch): Settings {
  const current = readSettings(dir);
  const next: Settings = { ...current, ...stripUndefined(patch) };
  const file = path.join(dir, 'settings.json');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return next;
}

function stripUndefined(patch: SettingsPatch): Partial<Settings> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<Settings>;
}

export function readSettings(dir: string): Settings {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')) as Partial<Settings>;
    return { ...DEFAULTS, ...raw };
  } catch {
    return DEFAULTS;
  }
}

export interface StartOptions {
  readonly dir?: string;
  readonly foreground?: boolean;
}

export interface RunningDaemon {
  readonly server: Server;
  readonly socketPath: string;
  stop(): Promise<void>;
}

export async function start(options: StartOptions = {}): Promise<RunningDaemon> {
  const dir = options.dir ?? configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const settings = readSettings(dir);
  const logger = new Logger({
    dir: path.join(dir, 'logs'),
    level: settings.logLevel,
    retentionDays: settings.logRetentionDays,
    maxTotalBytes: settings.logMaxBytes,
    echo: options.foreground ?? false,
  });

  const providers = new ProviderRegistry(builtinProviders());
  const connections = new ConnectionRegistry(providers, {
    configDir: dir,
    ...(settings.identityUser === undefined ? {} : { identityUser: settings.identityUser }),
  });
  for (const problem of connections.loadProblems()) logger.warn('connection config problem', { problem });

  const vault = Vault.open(dir);
  const broker = new Broker();
  const secrets = new SecretResolver(vault, broker);
  const sessions = new SessionPool(providers, secrets, broker, logger);
  const store = new ResultStore(path.join(dir, 'cache'), {
    mode: settings.resultsMode,
    maxBytes: settings.resultsMaxBytes,
  });

  let idleTimer: NodeJS.Timeout | undefined;
  const watcher = new ConfigWatcher(() => {
    logger.info('connection files changed, reloading');
    void server.reload();
  });
  const location = resolveSocketPath(socketEnvironment());
  if (location.fallbackReason) logger.info('socket moved', { reason: location.fallbackReason });
  const socketPath = location.socketPath;

  const server = new Server({
    socketPath,
    version: VERSION,
    logger,
    providers,
    connections,
    sessions,
    secrets,
    store,
    broker,
    vault,
    showAgentResults: () => readSettings(dir).showAgentResults,
    onWorkspace: workspace => watcher.add(workspaceFile(workspace)),
    onSettings: async patch => {
      const next = writeSettings(dir, patch);
      // Applied now, not at the next start. The old tool read every setting
      // once at activation and had a `setLevel` it never called, so changing
      // any of this meant reloading the window.
      logger.setLevel(next.logLevel);
      store.setOptions({ mode: next.resultsMode, maxBytes: next.resultsMaxBytes });
      connections.setOptions({
        configDir: dir,
        ...(next.identityUser === undefined ? {} : { identityUser: next.identityUser }),
      });
      await server.reload();
    },
    onIdle: () => {
      if (settings.idleExitMs <= 0) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (server.clientCount() > 0) return;
        logger.info('idle, shutting down');
        void stop().then(() => process.exit(0));
      }, settings.idleExitMs);
      idleTimer.unref();
    },
  });

  watcher.add(globalFile(dir));
  await server.listen();

  const stop = async (): Promise<void> => {
    clearTimeout(idleTimer);
    watcher.dispose();
    await server.close();
    await sessions.invalidateAll();
    vault.lock();
    await logger.drain();
  };

  return { server, socketPath, stop };
}

/* c8 ignore start — process wiring, exercised by running the daemon */
if (require.main === module) {
  const foreground = process.argv.includes('--foreground');
  start({ foreground })
    .then(daemon => {
      const shutdown = (signal: string): void => {
        void daemon.stop().then(() => {
          process.stderr.write(`dbrexd: stopped on ${signal}\n`);
          process.exit(0);
        });
      };
      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));
      if (foreground) process.stderr.write(`dbrexd ${VERSION} listening on ${daemon.socketPath}\n`);
    })
    .catch((e: unknown) => {
      const error = DbRexError.is(e) ? e : undefined;
      process.stderr.write(`dbrexd: ${messageOf(e)}\n`);
      if (error?.details.hint) process.stderr.write(`  ${error.details.hint}\n`);
      process.exit(1);
    });
}
/* c8 ignore stop */
