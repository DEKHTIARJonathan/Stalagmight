// Updater pubkey/endpoint sanity gate (issue #579).
//
// `src-tauri/tauri.conf.json`'s `plugins.updater` block does not exist yet -
// the real minisign keypair lands in a follow-up commit once it is generated
// (see docs/releasing.md). This gate is a tripwire for that day: IF the
// block exists, its `pubkey` must be non-placeholder, valid base64, and
// every `endpoints` entry must be an https `github.com` URL. With the block
// absent (today) it passes trivially, so it costs nothing now and turns a
// typo or a leftover placeholder pubkey red the moment the block is
// committed, rather than surfacing later as a client-side verification
// failure nobody can reproduce from the repo alone.
//
// Usage:  node scripts/check-updater-pubkey.mjs   (or: pnpm lint:updater-pubkey)

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CONF = 'src-tauri/tauri.conf.json';

function isValidBase64(s) {
  if (typeof s !== 'string' || s.length === 0) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return false;
  if (s.length % 4 !== 0) return false;
  return Buffer.from(s, 'base64').length > 0;
}

// Returns a list of problem strings; empty means either the updater plugin
// is not configured yet, or its config is sane.
export function checkUpdaterConfig(root) {
  const confPath = path.join(root, CONF);
  let conf;
  try {
    conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));
  } catch (e) {
    return [`${CONF} is missing or not valid JSON: ${e.message}`];
  }

  const updater = conf.plugins?.updater;
  if (!updater) return [];

  const problems = [];
  if (!isValidBase64(updater.pubkey)) {
    problems.push(`${CONF}: plugins.updater.pubkey is not a valid non-empty base64 string`);
  }

  const endpoints = Array.isArray(updater.endpoints) ? updater.endpoints : [];
  if (endpoints.length === 0) {
    problems.push(`${CONF}: plugins.updater.endpoints is empty`);
  }
  for (const ep of endpoints) {
    let url;
    try {
      url = new URL(ep);
    } catch {
      problems.push(`${CONF}: endpoint "${ep}" is not a valid URL`);
      continue;
    }
    if (url.protocol !== 'https:') {
      problems.push(`${CONF}: endpoint "${ep}" is not https`);
    }
    if (url.hostname !== 'github.com') {
      problems.push(`${CONF}: endpoint "${ep}" is not a github.com URL`);
    }
  }
  return problems;
}

function main() {
  const problems = checkUpdaterConfig(REPO_ROOT);
  if (problems.length === 0) {
    console.log('✓ updater pubkey/endpoint config: none configured yet, or configured and sane');
    return;
  }
  for (const p of problems) console.error(`✗ ${p}`);
  process.exit(1);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
