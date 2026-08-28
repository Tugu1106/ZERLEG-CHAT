/**
 * Parses the GitHub Actions workflow so a syntax error is caught here rather
 * than by GitHub after a push - an invalid workflow fails the run with
 * "Invalid workflow file" and never executes a single step, which looks
 * identical to a build failure until you read the file.
 *
 *   npm run check:ci
 *
 * Uses the js-yaml that already ships inside electron-builder, so this adds no
 * dependency of its own.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const file = resolve(root, '.github/workflows/release.yml');

const require = createRequire(import.meta.url);
let yaml;
try {
  yaml = require(require.resolve('js-yaml', { paths: [resolve(root, 'desktop/node_modules')] }));
} catch {
  console.error('js-yaml not found - run `npm run setup` first.');
  process.exit(1);
}

let doc;
try {
  doc = yaml.load(readFileSync(file, 'utf8'));
} catch (err) {
  console.error(`Invalid YAML in ${file}:\n  ${err.message}`);
  process.exit(1);
}

const problems = [];
if (!doc?.jobs) problems.push('no jobs defined');
for (const [name, job] of Object.entries(doc.jobs ?? {})) {
  if (!job.steps && !job.uses) problems.push(`job "${name}" has no steps`);
  for (const step of job.steps ?? []) {
    if (!step.uses && !step.run) problems.push(`a step in "${name}" has neither run nor uses`);
  }
}

if (problems.length) {
  console.error('Workflow problems:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`${file.replace(root, '.')} is valid - jobs: ${Object.keys(doc.jobs).join(', ')}`);
