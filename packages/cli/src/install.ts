/**
 * `dbrex install` — put the command somewhere a shell can find it.
 *
 * The extension does this too, on activation. It could not be the only place
 * that does it: the CLI and the daemon are the whole product for anyone driving
 * dbrex from a terminal or over MCP, and making them appear only after an
 * editor has been installed and opened once is backwards. The daemon outliving
 * the editor is the point of the design, so the daemon has to be installable
 * without one.
 *
 * What it does is deliberately small and repeatable: copy the two bundles into
 * the configuration directory, write the shim that picks an interpreter for
 * them, and link the shim onto PATH when there is an obvious place for it.
 * Running it twice changes nothing the second time.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { shimSource } from '@dbrex/core';

export interface InstallOptions {
  /** Directory holding the built `dbrex.js` and `dbrexd.js`. */
  readonly from: string;
  /** Configuration directory; the bundles land in `bin` under it. */
  readonly configDir: string;
  /** Where to link the command. Absent skips linking. */
  readonly linkDir?: string;
  /** Directories the shell searches, for deciding whether the link is reachable. */
  readonly pathEntries?: readonly string[];
}

export interface InstallReport {
  readonly binDir: string;
  readonly shim: string;
  readonly copied: readonly string[];
  readonly linked?: string;
  /** Set when the command is installed but the shell will not find it. */
  readonly notOnPath?: string;
}

const BUNDLES = ['dbrexd.js', 'dbrex.js'] as const;

export function install(options: InstallOptions): InstallReport {
  const binDir = path.join(options.configDir, 'bin');
  // 0700: the daemon's socket and vault live under here, and the bundles beside
  // them are what every client executes.
  fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });

  const copied: string[] = [];
  for (const name of BUNDLES) {
    const source = path.join(options.from, name);
    if (!fs.existsSync(source)) continue;
    fs.copyFileSync(source, path.join(binDir, name));
    copied.push(name);
  }
  if (!copied.includes('dbrex.js')) {
    throw new Error(`no dbrex.js in ${options.from}; run the build first`);
  }

  const shim = path.join(binDir, 'dbrex');
  fs.writeFileSync(shim, shimSource(path.join(binDir, 'dbrex.js')), { mode: 0o755 });

  const report: InstallReport = { binDir, shim, copied };
  if (options.linkDir === undefined) return report;

  // Only into a directory that already exists. Creating one the shell was never
  // told about installs the command into a place nothing looks.
  if (!isDirectory(options.linkDir)) {
    return { ...report, notOnPath: `${options.linkDir} does not exist` };
  }

  const link = path.join(options.linkDir, 'dbrex');
  fs.rmSync(link, { force: true });
  fs.symlinkSync(shim, link);

  const onPath = (options.pathEntries ?? []).some(entry => path.resolve(entry) === path.resolve(options.linkDir!));
  return onPath
    ? { ...report, linked: link }
    : { ...report, linked: link, notOnPath: `${options.linkDir} is not on PATH` };
}

/** The directory this CLI bundle was loaded from, which is where its sibling daemon is. */
export function bundleDir(): string {
  return __dirname;
}

/**
 * Where to link the command.
 *
 * `~/.local/bin` is the one place a user-level install can put a binary and
 * expect a modern shell to find it. Anything else is the caller's to choose.
 */
export function defaultLinkDir(home: string = os.homedir()): string {
  return path.join(home, '.local', 'bin');
}

export function pathEntries(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env['PATH'] ?? '').split(path.delimiter).filter(entry => entry.length > 0);
}

export function describe(report: InstallReport): string {
  const lines = [
    `  installed ${report.copied.join(', ')} into ${report.binDir}`,
    `  wrote ${report.shim}`,
  ];
  if (report.linked !== undefined) lines.push(`  linked ${report.linked}`);
  if (report.notOnPath !== undefined) {
    lines.push('', `  ${report.notOnPath}. Add this to your shell profile:`, '',
      `    export PATH="${report.binDir}:$PATH"`);
  }
  return `${lines.join('\n')}\n`;
}

function isDirectory(at: string): boolean {
  try {
    return fs.statSync(at).isDirectory();
  } catch {
    return false;
  }
}
