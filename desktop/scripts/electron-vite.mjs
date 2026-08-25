/**
 * Launcher for electron-vite.
 *
 * Two jobs:
 *
 * 1. VS Code's integrated terminal (and anything spawned from an Electron-based
 *    editor) exports ELECTRON_RUN_AS_NODE=1. Electron honours it and boots as a
 *    plain Node process, so `require('electron')` yields a path string instead
 *    of the API and the app dies with:
 *
 *      TypeError: Cannot read properties of undefined (reading 'app')
 *
 *    Stripping it here means `npm run dev` works from any terminal.
 *
 * 2. Forwarding app arguments. electron-vite only passes arguments through to
 *    the Electron process when they come after a `--` separator, so
 *    `npm run dev -- --profile alice` gets rewritten to
 *    `electron-vite dev -- --profile alice`.
 */
import { spawn } from 'node:child_process';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const [command, ...rest] = process.argv.slice(2);
const forwardsArgs = command === 'dev' || command === 'preview';

const args = [command];
if (rest.length > 0) {
  // `build` takes no app arguments, so only dev/preview get the separator.
  if (forwardsArgs && rest[0] !== '--') args.push('--');
  args.push(...rest);
}

const child = spawn('electron-vite', args, { stdio: 'inherit', env, shell: true });

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
