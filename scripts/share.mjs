/**
 * Hands the Zerleg Chat installer to coworkers over the LAN.
 *
 * Run it, read out the URL, and they download from their browser - no USB
 * sticks, no file-size limits, no cloud accounts. The page also tells them what
 * the Windows warnings mean, which is the part people get stuck on.
 *
 *   node scripts/share.mjs            serve on port 8080
 *   node scripts/share.mjs --port 9000
 */
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = resolve(root, 'desktop/release');

const argv = process.argv.slice(2);
const portIndex = argv.indexOf('--port');
const PORT = portIndex === -1 ? 8080 : Number(argv[portIndex + 1]) || 8080;

if (!existsSync(releaseDir)) {
  console.error('No build found. Run `npm run dist` first.');
  process.exit(1);
}

const installer = readdirSync(releaseDir)
  .filter((f) => f.endsWith('.exe') && !f.includes('uninstaller'))
  .map((f) => ({ name: f, path: join(releaseDir, f), size: statSync(join(releaseDir, f)).size }))
  .sort((a, b) => b.size - a.size)[0];

if (!installer) {
  console.error('No installer .exe in desktop/release. Run `npm run dist` first.');
  process.exit(1);
}

const megabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;

/** Every LAN address this machine can be reached on. */
function addresses() {
  const found = [];
  for (const iface of Object.values(os.networkInterfaces()).flat()) {
    if (iface && iface.family === 'IPv4' && !iface.internal) found.push(iface.address);
  }
  return found;
}

const escape = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

const page = () => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Install Zerleg Chat</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 32px 20px;
    font-family: 'Segoe UI', system-ui, sans-serif; color: #e7ecf4;
    background: radial-gradient(circle at 50% 0%, #1b2536, #0b0f17 60%);
  }
  main { width: min(620px, 100%); }
  .badge {
    display: grid; place-items: center; width: 76px; height: 76px; margin: 0 auto 22px;
    background: linear-gradient(160deg, #fb7185, #9f1239);
    box-shadow: 0 14px 40px rgba(159,18,57,.45);
  }
  .badge svg { width: 42px; height: 42px; }
  h1 {
    margin: 0 0 6px; font-size: 34px; font-weight: 700; letter-spacing: .14em;
    text-align: center; text-transform: uppercase;
  }
  .sub { margin: 0 0 28px; text-align: center; color: #8d99ad; font-size: 14.5px; }
  .download {
    display: block; padding: 17px 24px; margin-bottom: 10px; text-align: center;
    font-size: 17px; font-weight: 700; color: #fff; text-decoration: none;
    background: #4f8ef7; border-radius: 12px;
    box-shadow: 0 10px 30px rgba(79,142,247,.35);
  }
  .download:hover { filter: brightness(1.08); }
  .size { margin: 0 0 30px; text-align: center; color: #8d99ad; font-size: 12.5px; }
  ol { margin: 0; padding: 0; list-style: none; counter-reset: step; }
  li {
    position: relative; padding: 0 0 20px 46px; counter-increment: step;
    border-left: 1px solid rgba(255,255,255,.1); margin-left: 15px;
  }
  li:last-child { border-left-color: transparent; padding-bottom: 0; }
  li::before {
    content: counter(step); position: absolute; left: -15px; top: -2px;
    display: grid; place-items: center; width: 30px; height: 30px;
    font-size: 13px; font-weight: 700; color: #bfdbfe;
    background: #1e2635; border: 1px solid rgba(255,255,255,.14); border-radius: 50%;
  }
  h2 { margin: 0 0 4px; font-size: 15px; }
  p { margin: 0; color: #8d99ad; font-size: 13.5px; line-height: 1.55; }
  .warn { color: #fca5a5; font-weight: 600; }
  code {
    padding: 1px 6px; font-size: 12.5px; color: #e7ecf4;
    background: #1e2635; border: 1px solid rgba(255,255,255,.1); border-radius: 5px;
  }
  footer { margin-top: 30px; text-align: center; color: #55627a; font-size: 12px; }
</style>
</head>
<body>
<main>
  <div class="badge">
    <svg viewBox="0 0 96 96" aria-hidden="true">
      <path d="M55 13 L27 55 H44 L40 84 L69 41 H51 Z" fill="#fff"/>
    </svg>
  </div>
  <h1>Zerleg Chat</h1>
  <p class="sub">Chat with everyone in the office. Urgent messages take over the screen.</p>

  <a class="download" href="/download">Download for Windows</a>
  <p class="size">${escape(installer.name)} &middot; ${megabytes(installer.size)}</p>

  <ol>
    <li>
      <h2>Run the downloaded file</h2>
      <p>No admin rights needed. It installs just for you.</p>
    </li>
    <li>
      <h2>Windows will say it doesn't recognise the app</h2>
      <p>
        That is expected &mdash; the app isn't code-signed. Click
        <span class="warn">More info</span> then <span class="warn">Run anyway</span>.
      </p>
    </li>
    <li>
      <h2>Allow it through the firewall &mdash; do not click Cancel</h2>
      <p>
        On first launch Windows asks about network access. Tick
        <span class="warn">Private networks</span> and click
        <span class="warn">Allow access</span>. It will ask for an administrator,
        which is normal &mdash; the app cannot receive messages without it.
      </p>
      <p style="margin-top:6px">
        <strong>Clicking Cancel is hard to undo.</strong> Windows writes a permanent
        block, and clicking Allow later will not fix it. You would see everyone in
        your list but every message would fail.
      </p>
    </li>
    <li>
      <h2>Set your name</h2>
      <p>Click the gear icon and enter your name so people know who is messaging.</p>
    </li>
    <li>
      <h2>Leave it running</h2>
      <p>
        It sits in the system tray by the clock. Closing the window keeps it running so
        urgent messages still reach you. Turn on <code>Start automatically when I sign in</code>
        in Settings.
      </p>
    </li>
  </ol>

  <footer>No server &mdash; Zerleg Chat finds everyone else on this network by itself.</footer>
</main>
</body>
</html>`;

const server = createServer((req, res) => {
  if (req.url === '/download') {
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': installer.size,
      'content-disposition': `attachment; filename="${installer.name.replace(/"/g, '')}"`,
    });
    createReadStream(installer.path).pipe(res);
    console.log(`  -> download started by ${req.socket.remoteAddress}`);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page());
});

server.listen(PORT, '0.0.0.0', () => {
  const urls = addresses().map((a) => `http://${a}:${PORT}`);
  console.log('');
  console.log(`  Sharing: ${installer.name}  (${megabytes(installer.size)})`);
  console.log('');
  console.log('  Tell your coworkers to open:');
  for (const url of urls) console.log(`      ${url}`);
  if (urls.length === 0) console.log('      (no network connection found)');
  console.log('');
  console.log('  Keep this window open until everyone has downloaded. Ctrl+C to stop.');
  console.log('');
});

process.on('SIGINT', () => {
  console.log('\n  Stopped sharing.');
  server.close();
  process.exit(0);
});
