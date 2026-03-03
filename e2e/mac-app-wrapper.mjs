#!/usr/bin/env node
// mac-app-wrapper.mjs — Stdout delay wrapper for tauri-wd on macOS
//
// tauri-wd creates a WebDriver session as soon as it sees the plugin's
// "[webdriver] listening on port" message on stdout.  But the Tauri window
// hasn't been created yet at that point (~100ms race), causing "no window"
// errors from getWindowHandle.
//
// This wrapper launches the real binary and delays forwarding the port
// announcement by 500ms, giving the window time to be created.
//
// Usage:
//   STALAGMIGHT_BINARY=/path/to/stalagmight node e2e/mac-app-wrapper.mjs

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const binary = process.env.STALAGMIGHT_BINARY;
if (!binary) {
  process.stderr.write('mac-app-wrapper: STALAGMIGHT_BINARY env var not set\n');
  process.exit(1);
}

const child = spawn(binary, [], {
  stdio: ['inherit', 'pipe', 'inherit'],
});

// Forward signals to the real binary
process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));

const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });

rl.on('line', (line) => {
  if (line.includes('[webdriver] listening on port')) {
    // Delay the port announcement so tauri-wd creates the session
    // after the Tauri window exists (preventing "no window" race)
    setTimeout(() => {
      process.stdout.write(line + '\n');
    }, 500);
  } else {
    process.stdout.write(line + '\n');
  }
});

child.on('exit', (code) => {
  process.exit(code ?? 1);
});
