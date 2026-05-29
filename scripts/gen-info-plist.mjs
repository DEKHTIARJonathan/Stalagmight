// Generates src-tauri/Info.plist with the current git hash as CFBundleVersion
// so the native macOS "About" panel shows it as the build number.
// Tauri merges this file into the bundle's generated Info.plist.
// Wired into beforeDevCommand/beforeBuildCommand; the file is gitignored.
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const plistPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'Info.plist');

function gitHash() {
  try {
    const opts = { stdio: ['ignore', 'pipe', 'ignore'] };
    const hash = execSync('git rev-parse --short HEAD', opts).toString().trim();
    const dirty = execSync('git status --porcelain --untracked-files=no', opts).toString().trim().length > 0;
    return dirty ? `${hash}-dirty` : hash;
  } catch {
    return 'unknown';
  }
}

const build = gitHash();
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleVersion</key>
  <string>${build}</string>
</dict>
</plist>
`;

writeFileSync(plistPath, plist);
console.log(`[gen-info-plist] CFBundleVersion=${build} -> ${plistPath}`);
