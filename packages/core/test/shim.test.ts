import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MINIMUM_NODE_MAJOR, shimSource } from '../src/index';

function writeShim(dir: string, cliPath: string): string {
  const file = path.join(dir, 'dbrex');
  fs.writeFileSync(file, shimSource(cliPath), { mode: 0o755 });
  return file;
}

describe('the dbrex shim', () => {
  it('is valid shell', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbrex-shim-'));
    try {
      const file = writeShim(dir, '/nowhere/dbrex.js');
      expect(() => execFileSync('sh', ['-n', file])).not.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs the CLI with a Node new enough, passing arguments through', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbrex-shim-'));
    try {
      const cli = path.join(dir, 'cli.js');
      fs.writeFileSync(cli, 'console.log(process.argv.slice(2).join(" "));');
      const shim = writeShim(dir, cli);

      const run = spawnSync(shim, ['install-duckdb', '--dry'], { encoding: 'utf8' });
      expect(run.status).toBe(0);
      expect(run.stdout.trim()).toBe('install-duckdb --dry');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prefers DBREX_NODE when it is usable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbrex-shim-'));
    try {
      const cli = path.join(dir, 'cli.js');
      fs.writeFileSync(cli, 'console.log(process.execPath);');
      const shim = writeShim(dir, cli);

      const run = spawnSync(shim, [], {
        encoding: 'utf8',
        env: { ...process.env, DBREX_NODE: process.execPath },
      });
      expect(run.stdout.trim()).toBe(process.execPath);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a Node that is too old instead of failing obscurely', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbrex-shim-'));
    try {
      const fakeNode = path.join(dir, 'node');
      // A stand-in for the Node 11 that `nvm alias default` so often points at.
      fs.writeFileSync(fakeNode, '#!/bin/sh\necho 11\n', { mode: 0o755 });
      const shim = writeShim(dir, path.join(dir, 'cli.js'));

      const run = spawnSync(shim, [], {
        encoding: 'utf8',
        env: { PATH: dir, HOME: dir },
      });
      expect(run.status).toBe(127);
      expect(run.stderr).toContain(`Node ${MINIMUM_NODE_MAJOR} or newer`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
