/**
 * Per-session artifact recorder. Owns the session directory under
 * .agent-artifacts/sessions/<id>/ and appends every action to actions.jsonl in
 * the schema the replay generator consumes. Screenshots and state snapshots are
 * written as files and referenced by relative path.
 */
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ARTIFACTS_ROOT = path.join(repoRoot, '.agent-artifacts', 'sessions');
const RETAIN_SESSIONS = 20;
/** The ownership marker `reapPreviousSessions` reads: the owning harness pid. */
export const OWNER_FILE = 'owner';
/** How many ids `allocateSessionDir` draws before it gives up. */
const ALLOCATE_ATTEMPTS = 16;

/**
 * A session id: the local wall-clock SECOND it was allocated in, then the
 * millisecond, the allocating PROCESS and a random tail -
 * `YYYYMMDD-HHMMSS-mmm-p<pid base 36>-<6 hex>`.
 *
 * The second leads so a sorted listing stays chronological, which is what
 * `pruneOldSessions` keeps the newest of. Everything after it is there to make
 * two allocations different. The id used to be the second plus
 * `getTime() % 100000` in base 36, which is the clock again: two harness
 * processes allocating in the same millisecond got the SAME id, and with it one
 * directory, one `owner` file (two pids concatenated), one `pids` file and one
 * materialized fixture copy. Each then tore the other down - a self-check file
 * deleted under the other run, its app SIGKILLed by the other run's stop(), a
 * database overwritten while the other app had it open (#576 HFI-14, twice in
 * ~1,700 sessions, both on a runner's mass start). The pid separates two
 * processes by construction and the tail separates two allocations of one
 * process; `allocateSessionDir` still creates the directory EXCLUSIVELY, so an
 * id that collided anyway is redrawn rather than shared.
 */
export function sessionIdFor(now: Date, pid: number, tail: string): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${pad(now.getMilliseconds(), 3)}-p${pid.toString(36)}-${tail}`;
}

/** What `allocateSessionDir` reads from the world, injectable so a test can pin it. */
export interface AllocateDeps {
  now?: () => Date;
  pid?: number;
  /** Six hex characters per call; `crypto.randomBytes` by default. */
  tail?: () => string;
}

/**
 * Create a NEW session directory under `root` and claim it, atomically.
 *
 * `mkdirSync` without `recursive` fails with EEXIST when the directory already
 * exists, which makes the create itself the lock: whichever process gets there
 * first owns the id, and the other draws a new one. The `owner` marker is
 * written in the same breath (exclusive create too), before the directory is
 * handed to anything that could prune or reap - it used to be written by the
 * caller AFTER the recorder had already pruned, into a directory that might
 * not have been its own.
 */
export function allocateSessionDir(
  root: string = ARTIFACTS_ROOT,
  deps: AllocateDeps = {},
): { id: string; dir: string } {
  const now = deps.now ?? (() => new Date());
  const pid = deps.pid ?? process.pid;
  const tail = deps.tail ?? (() => randomBytes(3).toString('hex'));
  fs.mkdirSync(root, { recursive: true });
  for (let attempt = 0; attempt < ALLOCATE_ATTEMPTS; attempt += 1) {
    const id = sessionIdFor(now(), pid, tail());
    const dir = path.join(root, id);
    try {
      fs.mkdirSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
    fs.writeFileSync(path.join(dir, OWNER_FILE), String(pid), { flag: 'wx' });
    return { id, dir };
  }
  throw new Error(`could not allocate a unique session directory under ${root} in ${ALLOCATE_ATTEMPTS} attempts`);
}

export interface SessionStartMeta {
  sessionId: string;
  startedAt: string;
  gitHead: string;
  binaryPath: string;
  binaryMtime: number;
  display: string;
  headed: boolean;
  profileDir: string;
  freshProfile: boolean;
}

export interface ActionRecord {
  seq: number;
  ts: string;
  tool: string;
  /**
   * Whether this call changed application state, decided by the tool that made
   * it. Repro reports list mutating actions as the steps to reproduce, and
   * before this field they re-derived that from a hand-maintained name list in
   * `scripts/generate-repro-report.mjs` - which silently omitted every tool
   * added after it was written. Recording the fact at the one place that knows
   * it means a new tool cannot drop out of a repro report by omission.
   */
  mutating?: boolean;
  params: unknown;
  resolved?: unknown;
  outcome: { ok: boolean; durationMs: number; error?: string };
  result?: unknown;
  artifacts?: { screenshot?: string; stateSnapshot?: string } | undefined;
  post?: unknown;
}

/** Prune all but the newest `keep` session dirs (best-effort). */
function pruneOldSessions(root: string, keep: number): void {
  let dirs: string[];
  try {
    dirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return;
  }
  const toDelete = dirs.slice(0, Math.max(0, dirs.length - keep));
  for (const name of toDelete) {
    try {
      fs.rmSync(path.join(root, name), { recursive: true, force: true });
    } catch {
      // Best-effort.
    }
  }
}

export class Recorder {
  readonly dir: string;
  readonly screenshotsDir: string;
  readonly stateDir: string;
  readonly findingsDir: string;
  private readonly jsonlPath: string;
  private seq = 0;

  /**
   * `sessionId` names a directory `allocateSessionDir` already created and
   * claimed under `root`; the recorder only adds its subdirectories to it.
   */
  constructor(sessionId: string, root: string = ARTIFACTS_ROOT) {
    this.dir = path.join(root, sessionId);
    this.screenshotsDir = path.join(this.dir, 'screenshots');
    this.stateDir = path.join(this.dir, 'state');
    this.findingsDir = path.join(this.dir, 'findings');
    this.jsonlPath = path.join(this.dir, 'actions.jsonl');
    fs.mkdirSync(this.screenshotsDir, { recursive: true });
    fs.mkdirSync(this.stateDir, { recursive: true });
    fs.mkdirSync(this.findingsDir, { recursive: true });
    pruneOldSessions(root, RETAIN_SESSIONS);
  }

  private append(line: object): void {
    fs.appendFileSync(this.jsonlPath, `${JSON.stringify(line)}\n`);
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  sessionStart(meta: SessionStartMeta): void {
    this.append({ type: 'session-start', v: 1, ...meta });
  }

  action(record: ActionRecord): void {
    this.append({ type: 'action', v: 1, ...record });
  }

  event(event: string, detail?: unknown): void {
    this.append({ type: 'event', v: 1, seq: this.seq, ts: new Date().toISOString(), event, detail });
  }

  sessionEnd(reason: string): void {
    this.append({ type: 'session-end', v: 1, ts: new Date().toISOString(), reason, actions: this.seq });
  }

  /** Write a PNG (base64) into screenshots/ and return the session-relative path. */
  writeScreenshot(seq: number, name: string, base64: string): string {
    // Confine the caller-supplied name to a plain basename: a name containing
    // separators or `..` segments must not climb out of screenshots/.
    const safe = path.basename(name).replace(/[^\w.-]+/g, '_') || 'shot';
    const file = `${String(seq).padStart(4, '0')}-${safe}.png`;
    fs.writeFileSync(path.join(this.screenshotsDir, file), Buffer.from(base64, 'base64'));
    return path.join('screenshots', file);
  }

  /** Write a JSON state snapshot into state/ and return the session-relative path. */
  writeState(seq: number, value: unknown): string {
    const file = `${String(seq).padStart(4, '0')}.json`;
    fs.writeFileSync(path.join(this.stateDir, file), JSON.stringify(value, null, 2));
    return path.join('state', file);
  }
}

export { ARTIFACTS_ROOT };
