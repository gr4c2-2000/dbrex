/**
 * Installing DuckDB on demand.
 *
 * DuckDB's native binding is roughly 70 MB per platform, and the old extension
 * depended on all seven at once — that is where its 195 MB download came from,
 * paid by every user whether or not they ever opened a bucket. Here it is one
 * command, run once, only by people who query object stores.
 *
 * It lands in the config directory rather than beside the extension so it
 * survives an extension upgrade, which replaces its own directory wholesale.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const PACKAGE = '@duckdb/node-api';

export async function installDuckDB(configDir: string): Promise<number> {
  const target = path.join(configDir, 'duckdb');
  fs.mkdirSync(target, { recursive: true });

  const installed = path.join(target, 'node_modules', PACKAGE);
  if (fs.existsSync(installed)) {
    process.stdout.write(`DuckDB is already installed: ${installed}\n`);
    return 0;
  }

  process.stdout.write(`Installing ${PACKAGE} into ${target} (about 70 MB)…\n`);

  const code = await new Promise<number>(resolve => {
    const child = spawn('npm', ['install', '--prefix', target, '--no-audit', '--no-fund', PACKAGE], {
      stdio: 'inherit',
    });
    child.on('error', () => resolve(127));
    child.on('exit', status => resolve(status ?? 1));
  });

  if (code !== 0) {
    process.stderr.write(
      'dbrex: npm could not install DuckDB.\n' +
      `  You can do it by hand: npm install --prefix ${target} ${PACKAGE}\n` +
      '  Or point DBREX_DUCKDB at an existing installation.\n',
    );
    return code;
  }

  process.stdout.write('DuckDB installed. Object-store queries will work from the next query.\n');
  return 0;
}
