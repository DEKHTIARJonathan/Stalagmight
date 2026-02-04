import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const root = process.cwd();
const coverageRoot = path.join(root, 'docs', 'coverage');
const rawDir = path.join(coverageRoot, 'raw');
const e2eOut = path.join(coverageRoot, 'coverage-e2e.json');
const vitestOut = path.join(coverageRoot, 'coverage-final.json');
const combinedOut = path.join(coverageRoot, 'coverage-combined.json');
const tmpDir = path.join(coverageRoot, '.nyc_output');
const mergeDir = path.join(coverageRoot, '.merge');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function resetDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function runNyc(args) {
  execFileSync('pnpm', ['exec', 'nyc', ...args], { stdio: 'inherit' });
}

function hasTopLevelCoverageFiles(dir) {
  if (!fs.existsSync(dir)) return false;
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .some((entry) => entry.isFile() && entry.name.endsWith('.json'));
}

function findCoverageSources(dir) {
  if (!fs.existsSync(dir)) return [];
  const sources = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  if (entries.some((entry) => entry.isFile() && entry.name.endsWith('.json'))) {
    sources.push(dir);
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const subdir = path.join(dir, entry.name);
    if (hasTopLevelCoverageFiles(subdir)) {
      sources.push(subdir);
    }
  }
  return sources;
}

function writeReport(jsonFile, reportDir) {
  resetDir(tmpDir);
  ensureDir(reportDir);
  fs.copyFileSync(jsonFile, path.join(tmpDir, 'out.json'));
  runNyc([
    'report',
    '--temp-dir',
    tmpDir,
    '--report-dir',
    reportDir,
    '--reporter',
    'html',
    '--reporter',
    'text',
  ]);
}

const rawSources = findCoverageSources(rawDir);
if (rawSources.length === 0) {
  console.log('No raw E2E coverage files found under docs/coverage/raw.');
} else {
  console.log(`Merging raw E2E coverage from ${rawSources.length} source(s)...`);
  resetDir(mergeDir);
  const partials = rawSources.map((source, index) => {
    const partialOut = path.join(mergeDir, `e2e-${index}.json`);
    runNyc(['merge', source, partialOut]);
    return partialOut;
  });
  if (partials.length === 1) {
    fs.copyFileSync(partials[0], e2eOut);
  } else {
    runNyc(['merge', mergeDir, e2eOut]);
  }
  writeReport(e2eOut, path.join(coverageRoot, 'e2e'));
}

if (!fs.existsSync(vitestOut)) {
  console.log('No Vitest coverage-final.json found under docs/coverage.');
} else if (!fs.existsSync(e2eOut)) {
  console.log('Skipping combined coverage merge (E2E coverage not found).');
} else {
  console.log('Merging Vitest + E2E coverage...');
  resetDir(mergeDir);
  fs.copyFileSync(vitestOut, path.join(mergeDir, 'vitest.json'));
  fs.copyFileSync(e2eOut, path.join(mergeDir, 'e2e.json'));
  runNyc(['merge', mergeDir, combinedOut]);
  writeReport(combinedOut, path.join(coverageRoot, 'combined'));
}
