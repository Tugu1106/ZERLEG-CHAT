/**
 * Installs the desktop app's dependencies.
 *
 * Deliberately spawns `npm install` with `cwd` set, rather than using
 * `npm --prefix <dir> install`: run from the repo root, the --prefix form makes
 * npm install the *root* package into the sub-package as a `"file:.."`
 * dependency, which creates a node_modules symlink back to the repo and breaks
 * packaging.
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packages = ['desktop'];

const run = (cwd) =>
  new Promise((resolveRun, rejectRun) => {
    const child = spawn('npm', ['install', '--no-audit', '--no-fund'], {
      cwd,
      stdio: 'inherit',
      shell: true,
    });
    child.on('exit', (code) =>
      code === 0 ? resolveRun() : rejectRun(new Error(`npm install failed in ${cwd}`)),
    );
  });

for (const name of packages) {
  console.log(`\n> installing ${name}\n`);
  await run(resolve(root, name));
}

console.log('\nBoth packages installed.');
