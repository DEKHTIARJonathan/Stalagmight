import { spawn, spawnSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isPidAlive, pidComm, pidPgid, reapPidsFromFile } from './procs';

/**
 * A live child of THIS process, used as the subject instead of process.pid:
 * vitest renames its own workers ("node (vitest 5)"), which both platforms
 * report as the comm name. It signals readiness so the assertions cannot race
 * the exec that gives the process its name.
 */
async function liveChild(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)'], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout?.once('data', () => resolve());
    child.once('error', reject);
    child.once('exit', () => reject(new Error('probe child exited before signalling ready')));
  });
  return child;
}

/** A pid that is certainly dead: spawnSync only returns once the child is reaped. */
function deadPid(): number {
  const { pid } = spawnSync(process.execPath, ['-e', '']);
  expect(pid).toBeGreaterThan(0);
  return pid;
}

describe('pidComm / pidPgid on a live process', () => {
  let child: ChildProcess;

  beforeAll(async () => {
    child = await liveChild();
  });
  afterAll(() => {
    child.kill('SIGKILL');
  });

  it('names the executable', () => {
    expect(pidComm(child.pid ?? 0)).toBe(path.basename(process.execPath));
  });

  it('reports the process group, which a non-detached child shares with us', () => {
    const pgid = pidPgid(child.pid ?? 0);
    expect(pgid).toBeGreaterThan(0);
    // Asserting on OUR pgid, not on the leader's liveness: whether the group
    // leader is alive is a property of the test runner's process tree, not of
    // pidPgid, and can legitimately differ across CI environments.
    expect(pgid).toBe(pidPgid(process.pid));
  });
});

describe('pidComm / pidPgid on a pid that is not running', () => {
  it('falls back to empty/0 for a dead pid', () => {
    const pid = deadPid();
    expect(pidComm(pid)).toBe('');
    expect(pidPgid(pid)).toBe(0);
  });

  it('falls back to empty/0 for a pid that never existed', () => {
    expect(pidComm(0x7fffffff)).toBe('');
    expect(pidPgid(0x7fffffff)).toBe(0);
  });
});

describe('reapPidsFromFile', () => {
  it('kills nothing when the pidfile does not exist', () => {
    expect(reapPidsFromFile(path.join(os.tmpdir(), 'no-such-agent-pidfile'), ['stalagmight'])).toEqual([]);
  });

  // The safety property the scoped reap exists for (#127): a recorded pid whose
  // comm does not match is LEFT ALONE, even though it is in the pidfile - that
  // is what stands between the harness and killing a user's unrelated process
  // when a pid gets reused.
  it('skips a live pid whose comm does not match, then kills it on a matching comm', async () => {
    const child = await liveChild();
    const pid = child.pid ?? 0;
    expect(pid).toBeGreaterThan(0);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stalagmight-reap-'));
    const pidFile = path.join(dir, 'pids');
    fs.writeFileSync(pidFile, `${pid}\n`);
    try {
      expect(reapPidsFromFile(pidFile, ['no-such-comm-name'])).toEqual([]);
      expect(isPidAlive(pid)).toBe(true);

      const comm = path.basename(process.execPath);
      expect(reapPidsFromFile(pidFile, [comm])).toEqual([pid]);
      // SIGKILL delivery is async; poll briefly rather than sleeping blind.
      const deadline = Date.now() + 2000;
      while (isPidAlive(pid) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(isPidAlive(pid)).toBe(false);
    } finally {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already dead - the expected case.
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
