import { spawn, spawnSync, type ChildProcess } from 'child_process';
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
    expect(pgid).toBe(pidPgid(process.pid));
    // A group kill (kill(-pgid)) is only aimable at a live leader.
    expect(isPidAlive(pgid)).toBe(true);
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
});
