// Updater manifest generator (issue #579).
//
// Builds one Tauri v2 updater manifest (a static JSON, not signed itself -
// each platform entry carries its own minisign signature) from a directory of
// release artifacts. Two tracks exist, `latest-stable.json` and
// `latest-weekly.json`; this script emits ONE manifest per invocation, so the
// release workflow picks the file name via `--out` and uploads it to the
// rolling `updater` GitHub release afterward (see docs/releasing.md).
//
// Usage:
//   node scripts/gen-updater-manifest.mjs \
//     --version 0.5.1 --tag v0.5.1 --dir release-artifacts \
//     --notes-file notes.md --out latest-stable.json [--include-darwin true]
//
// `--version` is what the updater compares against the running app's own
// version - it is the manifest version, not necessarily the tag (a weekly
// build carries a `-weekly.YYYYMMDD` suffix so it never collides with, or
// looks older than, a stable release of the same base number).
//
// `--tag` names the GitHub release the artifacts were uploaded to; asset URLs
// are built from it as
// `https://github.com/Stalagmight/Stalagmight/releases/download/<tag>/<file>`.
//
// Each platform's update artifact and its detached `.sig` file (the `.sig`
// file's content becomes the manifest's `signature` field, verbatim) must
// both be present in `--dir`:
//   - linux-x86_64:   *.AppImage        + *.AppImage.sig
//   - windows-x86_64: *-setup.exe       + *-setup.exe.sig  (NOT the MSI)
//   - darwin-aarch64: *.app.tar.gz      + *.app.tar.gz.sig (only when
//                                                            --include-darwin true)
//
// Deterministic key order, so a manifest diff is reviewable: version, notes,
// pub_date, platforms (in the fixed order above). `pub_date` is always "now",
// UTC, RFC 3339 - it stamps when the manifest was generated, not when the
// artifacts were built.

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const GITHUB_RELEASE_BASE = 'https://github.com/Stalagmight/Stalagmight/releases/download';

// X.Y.Z, optionally followed by a dot/alnum suffix (`-rc1`, `-weekly.20260817`).
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;

// Order here is the order platforms appear in the emitted manifest.
const PLATFORMS = [
  { key: 'linux-x86_64', label: 'Linux', artifactRe: /\.AppImage$/, required: true },
  { key: 'windows-x86_64', label: 'Windows', artifactRe: /-setup\.exe$/, required: true },
  { key: 'darwin-aarch64', label: 'macOS', artifactRe: /\.app\.tar\.gz$/, required: false },
];

export function parseArgs(argv) {
  const getFlag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const version = getFlag('--version');
  const tag = getFlag('--tag');
  const dir = getFlag('--dir');
  const notes = getFlag('--notes');
  const notesFile = getFlag('--notes-file');
  const out = getFlag('--out');
  const includeDarwinRaw = getFlag('--include-darwin') ?? 'false';

  const missing = [];
  if (!version) missing.push('--version');
  if (!tag) missing.push('--tag');
  if (!dir) missing.push('--dir');
  if (!out) missing.push('--out');
  if (missing.length > 0) {
    throw new Error(`missing required flag(s): ${missing.join(', ')}`);
  }
  if (notes !== undefined && notesFile !== undefined) {
    throw new Error('--notes and --notes-file are mutually exclusive');
  }
  if (includeDarwinRaw !== 'true' && includeDarwinRaw !== 'false') {
    throw new Error(`--include-darwin must be "true" or "false", got "${includeDarwinRaw}"`);
  }
  return { version, tag, dir, notes, notesFile, out, includeDarwin: includeDarwinRaw === 'true' };
}

function findOne(dir, re, label) {
  const entries = fs.readdirSync(dir).filter((f) => re.test(f));
  if (entries.length > 1) {
    throw new Error(`multiple ${label} update artifacts matched in ${dir}: ${entries.join(', ')}`);
  }
  return entries[0];
}

function readSig(dir, artifactFile, label) {
  const sigFile = `${artifactFile}.sig`;
  const sigPath = path.join(dir, sigFile);
  if (!fs.existsSync(sigPath)) {
    throw new Error(`missing ${label} update signature: ${sigFile} (expected alongside ${artifactFile} in ${dir})`);
  }
  const sig = fs.readFileSync(sigPath, 'utf8').trim();
  if (sig.length === 0) {
    throw new Error(`${label} update signature is empty: ${sigPath}`);
  }
  return sig;
}

// Pure: builds the manifest object from already-resolved inputs. Takes real
// filesystem reads on `dir` (artifact discovery + sig content), but nothing
// else - no writes, no network. `notes` is the already-resolved string (the
// CLI layer resolves --notes vs --notes-file before calling this).
export function buildManifest({ version, tag, dir, notes, includeDarwin }) {
  if (!VERSION_RE.test(version)) {
    throw new Error(`--version "${version}" is not a valid version (expected X.Y.Z or X.Y.Z-suffix)`);
  }

  const platforms = {};
  for (const plat of PLATFORMS) {
    if (plat.key === 'darwin-aarch64' && !includeDarwin) continue;
    const artifact = findOne(dir, plat.artifactRe, plat.label);
    if (!artifact) {
      throw new Error(`no ${plat.label} update artifact found in ${dir} (expected to match ${plat.artifactRe})`);
    }
    const signature = readSig(dir, artifact, plat.label);
    // encodeURIComponent leaves '.', '-', '_' and alphanumerics untouched, so
    // the underscore-separated bundler names round-trip unchanged; it only
    // bites on the characters that would actually break a URL.
    const url = `${GITHUB_RELEASE_BASE}/${tag}/${encodeURIComponent(artifact)}`;
    platforms[plat.key] = { url, signature };
  }

  return {
    version,
    notes: notes ?? '',
    pub_date: new Date().toISOString(),
    platforms,
  };
}

function resolveNotes(opts) {
  if (opts.notesFile === undefined) return opts.notes;
  try {
    return fs.readFileSync(opts.notesFile, 'utf8');
  } catch (e) {
    throw new Error(`could not read --notes-file "${opts.notesFile}": ${e.message}`);
  }
}

function main() {
  const argv = process.argv.slice(2);
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    console.error(
      'Usage: node scripts/gen-updater-manifest.mjs --version <semver> --tag <tag> --dir <dir> ' +
        '(--notes <string>|--notes-file <path>) --out <path> [--include-darwin <true|false>]',
    );
    process.exit(1);
  }

  let manifest;
  try {
    const notes = resolveNotes(opts);
    manifest = buildManifest({ ...opts, notes });
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }

  fs.writeFileSync(opts.out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `wrote ${opts.out}: version ${manifest.version}, ${Object.keys(manifest.platforms).length} platform(s)`,
  );
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
