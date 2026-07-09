/**
 * Per-session artifact recorder. Owns the session directory under
 * .agent-artifacts/sessions/<id>/ and appends every action to actions.jsonl in
 * the schema the replay generator consumes. Screenshots and state snapshots are
 * written as files and referenced by relative path.
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ARTIFACTS_ROOT = path.join(repoRoot, '.agent-artifacts', 'sessions');
const RETAIN_SESSIONS = 20;

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
  params: unknown;
  resolved?: unknown;
  outcome: { ok: boolean; durationMs: number; error?: string };
  result?: unknown;
  artifacts?: { screenshot?: string; stateSnapshot?: string };
  post?: unknown;
}

/** Prune all but the newest `keep` session dirs (best-effort). */
function pruneOldSessions(keep: number): void {
  let dirs: string[];
  try {
    dirs = fs
      .readdirSync(ARTIFACTS_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return;
  }
  const toDelete = dirs.slice(0, Math.max(0, dirs.length - keep));
  for (const name of toDelete) {
    try {
      fs.rmSync(path.join(ARTIFACTS_ROOT, name), { recursive: true, force: true });
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

  constructor(sessionId: string) {
    this.dir = path.join(ARTIFACTS_ROOT, sessionId);
    this.screenshotsDir = path.join(this.dir, 'screenshots');
    this.stateDir = path.join(this.dir, 'state');
    this.findingsDir = path.join(this.dir, 'findings');
    this.jsonlPath = path.join(this.dir, 'actions.jsonl');
    fs.mkdirSync(this.screenshotsDir, { recursive: true });
    fs.mkdirSync(this.stateDir, { recursive: true });
    fs.mkdirSync(this.findingsDir, { recursive: true });
    pruneOldSessions(RETAIN_SESSIONS);
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
