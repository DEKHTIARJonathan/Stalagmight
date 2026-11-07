// The one implementation of foldLocalPaths (#576 RV18-W23-4, W58): the agent
// harness imports it through e2e/agent/lib/shareableFailure.ts, and the repo's
// Node tools under scripts/ import it here, so a CLI or env path they echo
// prints folded instead of as a placeholder. The print-site guard knows the
// name as a fold (e2e/agent/lib/printSites/rules.ts FOLDS).

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

/** The checkout: this file is scripts/lib/fold-local-paths.mjs. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The temp directory as `os.tmpdir()` gives it, and its real path when that
 * differs (macOS hands out `/var/folders/...`, which is `/private/var/...`).
 */
function tempRoots() {
  const tmp = os.tmpdir();
  try {
    const real = fs.realpathSync(tmp);
    return real === tmp ? [tmp] : [tmp, real];
  } catch {
    return [tmp];
  }
}

/**
 * `text` with the checkout folded to `<repo>`, the home directory to `~`,
 * `CARGO_TARGET_DIR` to `<target>` and the temp directory to `<tmp>`. A
 * shareable line can carry a path - a `reproduce:` line's fixture or `REPLAY
 * of <trace>`, a headline naming the session directory, a build's `Built
 * application at:` line, a save under the temp directory, a path a tool was
 * given on its command line - and a path under any of these roots names the
 * user or their machine. What follows the folded root is the harness's own
 * layout, or a corpus id the corpus fold already put there. Read at call time,
 * so a changed `HOME`, `CARGO_TARGET_DIR` or `TMPDIR` is honoured; the longest
 * root folds first, and a root of `/` or a relative `CARGO_TARGET_DIR` folds
 * nothing.
 *
 * @param {string} text
 * @returns {string}
 */
export function foldLocalPaths(text) {
  const target = process.env.CARGO_TARGET_DIR;
  const roots = [
    { root: REPO_ROOT, say: '<repo>' },
    { root: os.homedir(), say: '~' },
    ...(target ? [{ root: target, say: '<target>' }] : []),
    ...tempRoots().map((root) => ({ root, say: '<tmp>' })),
  ]
    .filter(({ root }) => path.isAbsolute(root) && path.resolve(root) !== path.parse(root).root)
    .map(({ root, say }) => ({ root: path.resolve(root), say }))
    .sort((a, b) => b.root.length - a.root.length);
  let out = text;
  for (const { root, say } of roots) {
    if (!out.includes(root)) continue;
    const literal = root.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&');
    // Not inside a longer name: `/home/bob` must leave `/home/bobby` alone.
    out = out.replace(new RegExp(`${literal}(?![\\w.-])`, 'g'), say);
  }
  return out;
}
