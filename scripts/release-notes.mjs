/**
 * Pulls one version's section out of CHANGELOG.md so the GitHub release body
 * and the changelog can never disagree - the changelog is the single source.
 *
 *   node scripts/release-notes.mjs 1.2.0 > RELEASE_NOTES.md
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = (process.argv[2] ?? '').replace(/^v/, '');

if (!version) {
  console.error('usage: node scripts/release-notes.mjs <version>');
  process.exit(1);
}

const changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');

// Everything between "## <version>" and the next "## " heading.
const start = changelog.search(new RegExp(`^## ${version.replace(/\./g, '\\.')}\\s*$`, 'm'));
if (start === -1) {
  console.error(`No "## ${version}" section in CHANGELOG.md.`);
  process.exit(1);
}

const rest = changelog.slice(start);
const nextHeading = rest.slice(1).search(/^## /m);
const section = (nextHeading === -1 ? rest : rest.slice(0, nextHeading + 1)).trim();

// Drop the heading itself; GitHub shows the version as the release title.
const body = section.split('\n').slice(1).join('\n').trim();

process.stdout.write(
  [
    body,
    '',
    '---',
    '',
    '**Windows:** download `ZerlegChat-Setup.exe` below.',
    '',
    'Windows will warn that the publisher is unknown (the build is not code-signed) -',
    'click **More info → Run anyway**. On first launch, allow it through the firewall on',
    '**Private networks**, or nobody will be able to see you.',
    '',
    '**macOS:** builds are attached but have never been tested on a Mac. Expect',
    'Gatekeeper (right-click → Open) and a Local Network permission prompt.',
    '',
  ].join('\n'),
);
