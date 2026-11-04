/**
 * Session directories: how one is claimed, and which ones retention may delete.
 *
 * Every case runs in a throwaway root, never `.agent-artifacts/`, so a test can
 * neither prune nor claim a real session's directory.
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OWNER_FILE, allocateSessionDir, sessionIdFor } from './recorder';

const here = path.dirname(fileURLToPath(import.meta.url));
let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'stalagmight-recorder-test-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const ownerOf = (dir: string): string => fs.readFileSync(path.join(dir, OWNER_FILE), 'utf8');

describe('session ids (#576 HFI-14)', () => {
  const instant = new Date(2026, 10, 4, 0, 2, 31, 417);

  it('leads with the wall-clock second, so a sorted listing stays chronological', () => {
    const earlier = sessionIdFor(new Date(2026, 10, 4, 0, 2, 30, 999), 99999, 'ffffff');
    const later = sessionIdFor(instant, 1, '000000');
    expect(later.startsWith('20261104-000231-417-')).toBe(true);
    expect([later, earlier].sort()).toEqual([earlier, later]);
  });

  it('gives two processes different ids in the same millisecond, even on the same random tail', () => {
    expect(sessionIdFor(instant, 404520, 'abcdef')).not.toBe(sessionIdFor(instant, 404616, 'abcdef'));
  });

  it('hands two creates in the SAME millisecond two directories, each with its own owner', () => {
    // The worst case the old id could not survive: one clock reading for both
    // creates. Here even the pid and the first random draw are the same, so the
    // second create's first candidate IS the first create's directory - only the
    // exclusive mkdir can tell, and it has to make the second one draw again.
    const draws = ['aaaaaa', 'aaaaaa', 'bbbbbb'];
    const deps = { now: () => instant, pid: 4242, tail: () => draws.shift() ?? 'cccccc' };
    const first = allocateSessionDir(root, deps);
    const second = allocateSessionDir(root, deps);
    expect(second.id).not.toBe(first.id);
    expect(second.dir).not.toBe(first.dir);
    expect(fs.statSync(first.dir).isDirectory()).toBe(true);
    expect(fs.statSync(second.dir).isDirectory()).toBe(true);
    // One pid per marker: the collision wrote '404520404616' into one file.
    expect(ownerOf(first.dir)).toBe('4242');
    expect(ownerOf(second.dir)).toBe('4242');
    expect(draws).toEqual([]);
  });

  it('never shares a directory between two processes creating at once', async () => {
    // Two REAL processes, released by one shared deadline, each claiming a
    // session directory under the same root with the production defaults.
    const tsx = path.resolve(here, '..', '..', '..', 'node_modules', '.bin', 'tsx');
    const recorderModule = path.resolve(here, 'recorder.ts');
    const releaseAt = Date.now() + 1500;
    const script =
      `(async () => {` +
      `const { allocateSessionDir } = await import(${JSON.stringify(recorderModule)});` +
      `while (Date.now() < ${releaseAt}) {}` +
      `const at = Date.now();` +
      `const claimed = allocateSessionDir(${JSON.stringify(root)});` +
      `process.stdout.write(JSON.stringify({ at, pid: process.pid, ...claimed }));` +
      `})();`;
    const run = (): Promise<{ at: number; pid: number; id: string; dir: string }> =>
      new Promise((resolve, reject) => {
        const child = spawn(tsx, ['--eval', script], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
        child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
        child.on('error', reject);
        child.on('close', (code) => {
          if (code !== 0) reject(new Error(`child exited ${code}: ${err}`));
          else resolve(JSON.parse(out) as { at: number; pid: number; id: string; dir: string });
        });
      });
    const [a, b] = await Promise.all([run(), run()]);
    expect(a.id).not.toBe(b.id);
    expect(fs.readdirSync(root).sort()).toEqual([a.id, b.id].sort());
    expect(ownerOf(a.dir)).toBe(String(a.pid));
    expect(ownerOf(b.dir)).toBe(String(b.pid));
  }, 30_000);
});
