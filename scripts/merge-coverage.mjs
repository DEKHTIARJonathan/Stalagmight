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

function hasCoverageFiles(dir) {
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir).some((file) => file.endsWith('.json'));
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

if (!hasCoverageFiles(rawDir)) {
  console.log('No raw E2E coverage files found under docs/coverage/raw.');
} else {
  console.log('Merging raw E2E coverage...');
  runNyc(['merge', rawDir, e2eOut]);
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
