/**
 * Builds the daemon and the CLI into single files.
 *
 * The CLI bundle ships the daemon next to it so `dbrex mcp` can start a daemon
 * on a machine where nothing else has run yet — that is what lets an agent work
 * before the editor has ever been opened.
 */
const esbuild = require('esbuild');

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  logLevel: 'info',
  sourcemap: process.env.NODE_ENV !== 'production',
  minify: process.env.NODE_ENV === 'production',
};

const targets = [
  { entryPoints: ['packages/extension/src/extension.ts'], outfile: 'packages/extension/dist/extension.js', external: ['vscode'] },
  // The webview and its sandbox are browser code; they must not pull in Node.
  { entryPoints: ['packages/extension/webview/main.ts'], outfile: 'packages/extension/dist/webview.js', platform: 'browser' },
  { entryPoints: ['packages/extension/webview/sandbox.ts'], outfile: 'packages/extension/dist/sandbox.js', platform: 'browser', sourcemap: false },
  // The extension ships the daemon and the CLI so installing it installs everything.
  { entryPoints: ['packages/daemon/src/main.ts'], outfile: 'packages/extension/dist/dbrexd.js' },
  { entryPoints: ['packages/cli/src/main.ts'], outfile: 'packages/extension/dist/dbrex.js' },
  { entryPoints: ['packages/daemon/src/main.ts'], outfile: 'packages/daemon/dist/dbrexd.js' },
  // The CLI spawns the daemon from its own directory, so put a copy there too.
  { entryPoints: ['packages/daemon/src/main.ts'], outfile: 'packages/cli/dist/dbrexd.js' },
  { entryPoints: ['packages/cli/src/main.ts'], outfile: 'packages/cli/dist/dbrex.js', banner: { js: '#!/usr/bin/env node' } },
];

Promise.all(targets.map(t => esbuild.build({ ...shared, ...t })))
  .then(() => require('node:fs').chmodSync('packages/cli/dist/dbrex.js', 0o755))
  .catch(() => process.exit(1));
