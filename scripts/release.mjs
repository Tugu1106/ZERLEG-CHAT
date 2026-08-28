/**
 * Cuts a release: bumps the version everywhere, turns the "Unreleased" section
 * of the changelog into the new version, commits, and tags.
 *
 *   npm run release patch     1.1.0 -> 1.1.1
 *   npm run release minor     1.1.0 -> 1.2.0
 *   npm run release major     1.1.0 -> 2.0.0
 *
 * Then `git push --follow-tags` and GitHub Actions builds and publishes.
 *
 * The version lives in two package.json files and the changelog; keeping them
 * in step by hand is exactly how a release ends up mislabelled, so this does it
 * in one place or not at all.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const kind = process.argv[2];

if (!['patch', 'minor', 'major'].includes(kind)) {
  console.error('usage: npm run release <patch|minor|major>');
  process.exit(1);
}

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

// Refuse to build a release on top of half-finished work.
if (git('status', '--porcelain')) {
  console.error('You have uncommitted changes. Commit or stash them first.');
  process.exit(1);
}

const pkgPaths = [resolve(root, 'package.json'), resolve(root, 'desktop/package.json')];
const current = JSON.parse(readFileSync(pkgPaths[0], 'utf8')).version;

const [major, minor, patch] = current.split('.').map(Number);
const next =
  kind === 'major' ? `${major + 1}.0.0` : kind === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;

// ------------------------------------------------------------------ changelog

const changelogPath = resolve(root, 'CHANGELOG.md');
const changelog = readFileSync(changelogPath, 'utf8');

const unreleased = changelog.match(/^## Unreleased\s*$/m);
if (!unreleased) {
  console.error('CHANGELOG.md has no "## Unreleased" section to release.');
  process.exit(1);
}

const afterHeading = changelog.slice(unreleased.index + unreleased[0].length);
const nextHeading = afterHeading.search(/^## /m);
const notes = (nextHeading === -1 ? afterHeading : afterHeading.slice(0, nextHeading)).trim();

if (!notes) {
  console.error('The "## Unreleased" section is empty - write what changed first.');
  process.exit(1);
}

// Rename Unreleased to the new version, and open a fresh empty Unreleased.
writeFileSync(
  changelogPath,
  changelog.replace(/^## Unreleased\s*$/m, `## Unreleased\n\n## ${next}`),
  'utf8',
);

// ----------------------------------------------------------------- versions

for (const file of pkgPaths) {
  const json = JSON.parse(readFileSync(file, 'utf8'));
  json.version = next;
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
}

// -------------------------------------------------------------- commit + tag

git('add', '-A');
git('commit', '-m', `Release ${next}`);
git('tag', '-a', `v${next}`, '-m', `Zerleg Chat ${next}`);

console.log('');
console.log(`  ${current} -> ${next}`);
console.log('');
console.log('  Committed and tagged. Now run:');
console.log('');
console.log('      git push --follow-tags');
console.log('');
console.log('  GitHub Actions will build Windows + macOS and publish the release.');
console.log('');
