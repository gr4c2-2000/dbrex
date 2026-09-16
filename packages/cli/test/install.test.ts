import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { defaultLinkDir, describe as report, install, pathEntries } from '../src/install';

let root: string;
let from: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dbrex-install-'));
  from = path.join(root, 'build');
  fs.mkdirSync(from, { recursive: true });
  fs.writeFileSync(path.join(from, 'dbrex.js'), 'console.log("cli");');
  fs.writeFileSync(path.join(from, 'dbrexd.js'), 'console.log("daemon");');
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const configDir = () => path.join(root, '.dbrex');

describe('installing the command', () => {
  it('copies both bundles into the configuration directory', () => {
    const result = install({ from, configDir: configDir() });
    expect(result.copied).toEqual(['dbrexd.js', 'dbrex.js']);
    expect(fs.existsSync(path.join(result.binDir, 'dbrex.js'))).toBe(true);
    expect(fs.existsSync(path.join(result.binDir, 'dbrexd.js'))).toBe(true);
  });

  it('writes a shim that is valid shell', () => {
    const { shim } = install({ from, configDir: configDir() });
    expect(() => execFileSync('sh', ['-n', shim])).not.toThrow();
  });

  it('writes an executable shim', () => {
    const { shim } = install({ from, configDir: configDir() });
    expect(fs.statSync(shim).mode & 0o111).not.toBe(0);
  });

  it('keeps the bin directory private, since the vault sits beside it', () => {
    const { binDir } = install({ from, configDir: configDir() });
    expect(fs.statSync(binDir).mode & 0o777).toBe(0o700);
  });

  it('points the shim at the installed copy, not at the build it came from', () => {
    const { shim, binDir } = install({ from, configDir: configDir() });
    const source = fs.readFileSync(shim, 'utf8');
    expect(source).toContain(path.join(binDir, 'dbrex.js'));
    expect(source).not.toContain(from);
  });

  it('refuses a directory that was never built', () => {
    const empty = path.join(root, 'empty');
    fs.mkdirSync(empty);
    expect(() => install({ from: empty, configDir: configDir() })).toThrow(/run the build first/);
  });

  it('changes nothing on a second run', () => {
    const first = install({ from, configDir: configDir() });
    const before = fs.readFileSync(first.shim, 'utf8');
    const second = install({ from, configDir: configDir() });
    expect(fs.readFileSync(second.shim, 'utf8')).toBe(before);
    expect(second.binDir).toBe(first.binDir);
  });
});

describe('putting it on PATH', () => {
  it('links into a directory that exists', () => {
    const linkDir = path.join(root, 'bin');
    fs.mkdirSync(linkDir);
    const result = install({ from, configDir: configDir(), linkDir, pathEntries: [linkDir] });
    expect(result.linked).toBe(path.join(linkDir, 'dbrex'));
    expect(result.notOnPath).toBeUndefined();
    expect(fs.realpathSync(result.linked!)).toBe(fs.realpathSync(result.shim));
  });

  it('replaces a link left by an earlier install', () => {
    const linkDir = path.join(root, 'bin');
    fs.mkdirSync(linkDir);
    fs.symlinkSync('/nowhere/old', path.join(linkDir, 'dbrex'));
    const result = install({ from, configDir: configDir(), linkDir, pathEntries: [linkDir] });
    expect(fs.realpathSync(result.linked!)).toBe(fs.realpathSync(result.shim));
  });

  it('does not create a directory the shell was never told about', () => {
    const linkDir = path.join(root, 'nothing-here');
    const result = install({ from, configDir: configDir(), linkDir });
    expect(fs.existsSync(linkDir)).toBe(false);
    expect(result.linked).toBeUndefined();
    expect(result.notOnPath).toContain('does not exist');
  });

  it('says so when the link lands somewhere PATH does not reach', () => {
    const linkDir = path.join(root, 'bin');
    fs.mkdirSync(linkDir);
    const result = install({ from, configDir: configDir(), linkDir, pathEntries: ['/usr/bin'] });
    expect(result.linked).toBeDefined();
    expect(result.notOnPath).toContain('not on PATH');
  });

  it('skips linking entirely when no directory is given', () => {
    const result = install({ from, configDir: configDir() });
    expect(result.linked).toBeUndefined();
    expect(result.notOnPath).toBeUndefined();
  });
});

describe('what it tells the user', () => {
  it('names the directory to add when PATH will not find it', () => {
    const linkDir = path.join(root, 'bin');
    fs.mkdirSync(linkDir);
    const text = report(install({ from, configDir: configDir(), linkDir, pathEntries: [] }));
    expect(text).toContain('export PATH=');
    expect(text).toContain(path.join(configDir(), 'bin'));
  });

  it('says nothing about PATH when the link is reachable', () => {
    const linkDir = path.join(root, 'bin');
    fs.mkdirSync(linkDir);
    const text = report(install({ from, configDir: configDir(), linkDir, pathEntries: [linkDir] }));
    expect(text).not.toContain('export PATH=');
  });
});

describe('defaults', () => {
  it('links into ~/.local/bin, the one place a user install is looked for', () => {
    expect(defaultLinkDir('/home/someone')).toBe('/home/someone/.local/bin');
  });

  it('reads PATH as the shell splits it', () => {
    expect(pathEntries({ PATH: `/usr/bin${path.delimiter}/opt/bin` })).toEqual(['/usr/bin', '/opt/bin']);
  });

  it('copes with no PATH at all', () => {
    expect(pathEntries({})).toEqual([]);
  });
});
