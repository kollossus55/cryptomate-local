#!/usr/bin/env node
/**
 * One command to run everything.
 *
 * Builds the UI if it has not been built, then starts the server, which serves
 * both the API and the app on a single port.
 */

import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

if (!existsSync(path.join(ROOT, 'dist', 'index.html'))) {
  console.log('Building the UI (first run only, takes about a minute)…\n');
  const build = spawnSync(npm, ['run', 'build'], {
    cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32',
  });
  if (build.status !== 0) {
    console.error('\nBuild failed. Fix the errors above, then run `npm start` again.');
    process.exit(1);
  }
  console.log('');
}

const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
  cwd: ROOT, stdio: 'inherit',
});

server.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.kill(sig));
}
