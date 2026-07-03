/**
 * Process + port helpers for the agent harness. Port probing and SCOPED
 * process reaping: only PIDs recorded in a session pidfile whose /proc/<pid>/comm
 * matches an expected name are killed. Never a broad `pkill stalagmight` (that
 * lesson is baked into scripts/wdio.sh).
 */
import * as fs from 'fs';
import * as net from 'net';

/** True if `port` on 127.0.0.1 can be bound right now. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

/** Return the first free port in [base, base + span), or throw. */
export async function findFreePort(base: number, span = 10): Promise<number> {
  for (let port = base; port < base + span; port++) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port found in [${base}, ${base + span})`);
}

/** True if `pid` is alive (owned by us or not). */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH => dead; EPERM => alive but not ours (still "alive").
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Read `/proc/<pid>/comm` (Linux), or '' if unavailable. */
export function pidComm(pid: number): string {
  try {
    return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * Kill each PID listed in `pidFile` whose comm name contains one of
 * `commSubstrings`. Returns the PIDs actually signalled. Best-effort and
 * scoped: a PID whose comm does not match (e.g. reused by an unrelated process)
 * is left alone.
 */
export function reapPidsFromFile(pidFile: string, commSubstrings: string[]): number[] {
  if (!fs.existsSync(pidFile)) return [];
  let pids: number[];
  try {
    pids = fs
      .readFileSync(pidFile, 'utf8')
      .split('\n')
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
  const killed: number[] = [];
  for (const pid of pids) {
    const comm = pidComm(pid);
    if (comm && commSubstrings.some((s) => comm.includes(s))) {
      try {
        process.kill(pid, 'SIGKILL');
        killed.push(pid);
      } catch {
        // Already gone.
      }
    }
  }
  return killed;
}

/** Append a PID to a pidfile (one per line), best-effort. */
export function recordPid(pidFile: string, pid: number): void {
  try {
    fs.appendFileSync(pidFile, `${pid}\n`);
  } catch {
    // Best-effort tracking.
  }
}
