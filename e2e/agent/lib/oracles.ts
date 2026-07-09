/**
 * Problem oracles. Two sweeps over the running app:
 *
 *  - cheapSweep: runs after every mutating tool call (goal < ~50 ms of extra
 *    WebDriver traffic). Crash markers (fs only), a React error-boundary probe,
 *    and new error/warn ring lines since an internal cursor.
 *  - fullSweep: cheapSweep plus project-integrity, leftover .stalx.tmp files,
 *    a memory-growth check against a session baseline, dialog residue, and a
 *    read-only responsiveness probe (command-lock deadlock detector).
 *
 * Oracles take a structural OracleTarget (AppSession satisfies it) so this
 * module does not import session.ts (no cycle). Findings are deduplicated by
 * kind+message; the first time a fatal/error finding is seen, runSweep captures
 * a screenshot + finding.json + any crash markers into the recorder's findings
 * dir and emits a `finding` event to the action log.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Browser } from 'webdriverio';
import { invokeInApp, evalInApp } from './page';
import { readStore } from './stores';
import { isErrorLine, isWarnLine } from './logs';

export type Severity = 'fatal' | 'error' | 'warning';

export interface Finding {
  severity: Severity;
  kind: string;
  message: string;
  detail?: unknown;
}

export interface OracleTarget {
  readonly browser: Browser;
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
  findCrashMarkers(): string[];
}

export interface RecorderLike {
  readonly findingsDir: string;
  event(name: string, detail?: unknown): void;
}

export interface OracleState {
  reportedCrashMarkers: Set<string>;
  logCursor: number;
  memoryBaselineRssKb: number | null;
  reported: Set<string>;
  findingCount: number;
}

export function newOracleState(): OracleState {
  return {
    reportedCrashMarkers: new Set(),
    logCursor: 0,
    memoryBaselineRssKb: null,
    reported: new Set(),
    findingCount: 0,
  };
}

/** Warn lines that are known-benign dev noise; kept tiny and explicit. */
const WARN_ALLOWLIST: string[] = [
  'source map',
  'Download the React DevTools',
];
function isAllowedWarn(line: string): boolean {
  return WARN_ALLOWLIST.some((s) => line.includes(s));
}

interface LogsSince {
  entries: { seq: number; ts_ms: number; line: string }[];
  latest_seq: number;
  dropped: boolean;
}

/**
 * Cheap post-action sweep. Never throws: a probe failure is itself surfaced as
 * a warning (an unresponsive webview is a finding, not a crash of the harness).
 */
export async function cheapSweep(target: OracleTarget, state: OracleState): Promise<Finding[]> {
  const findings: Finding[] = [];

  // 1. Backend crash markers (filesystem only; fatal even if the process survived).
  for (const marker of target.findCrashMarkers()) {
    if (state.reportedCrashMarkers.has(marker)) continue;
    state.reportedCrashMarkers.add(marker);
    let detail: unknown = { file: marker };
    try {
      detail = JSON.parse(fs.readFileSync(marker, 'utf8'));
    } catch {
      // Marker unreadable; keep the path.
    }
    findings.push({
      severity: 'fatal',
      kind: 'crash-marker',
      message: `backend panic marker: ${path.basename(marker)}`,
      detail,
    });
  }

  // 2 + 3. One exclusive block: DOM error-boundary probe, then new ring lines.
  try {
    const probe = await target.exclusive(async () => {
      const dom = await evalInApp<{ errorBoundary: boolean; text?: string }>(
        target.browser,
        `
        const el = document.querySelector('[data-testid="error-boundary-fallback"]');
        return { errorBoundary: !!el, text: el ? (el.textContent || '').slice(0, 300) : undefined };
      `,
      );
      const logs = await invokeInApp<LogsSince>(target.browser, 'get_recent_logs_since', {
        afterSeq: state.logCursor,
      });
      return { dom, logs };
    });

    if (probe.dom.errorBoundary) {
      findings.push({
        severity: 'error',
        kind: 'error-boundary',
        message: 'React error boundary is showing its fallback UI',
        detail: probe.dom.text,
      });
    }
    if (probe.logs.dropped) {
      findings.push({
        severity: 'warning',
        kind: 'ring-overflow',
        message: 'log ring rotated past the oracle cursor; some lines were lost',
      });
    }
    for (const e of probe.logs.entries) {
      if (isErrorLine(e.line)) {
        findings.push({ severity: 'error', kind: 'log-error', message: e.line.slice(0, 400) });
      } else if (isWarnLine(e.line) && !isAllowedWarn(e.line)) {
        findings.push({ severity: 'warning', kind: 'log-warn', message: e.line.slice(0, 400) });
      }
    }
    state.logCursor = Math.max(state.logCursor, probe.logs.latest_seq);
  } catch (err) {
    findings.push({
      severity: 'warning',
      kind: 'sweep-probe-failed',
      message: `oracle probe failed (webview may be unresponsive): ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  return findings;
}

/** Full sweep: cheap sweep plus the expensive, less-frequent checks. */
export async function fullSweep(target: OracleTarget, state: OracleState): Promise<Finding[]> {
  const findings = await cheapSweep(target, state);

  // 4. Project integrity.
  try {
    const integrity = await target.exclusive(() =>
      invokeInApp<{ messages: string[]; save_blocked: boolean }>(target.browser, 'check_project_integrity'),
    );
    if (integrity.save_blocked) {
      findings.push({
        severity: 'fatal',
        kind: 'integrity-save-blocked',
        message: 'project integrity: saving is blocked (unresolvable cross-references)',
        detail: integrity.messages,
      });
    } else if (integrity.messages.length > 0) {
      findings.push({
        severity: 'error',
        kind: 'integrity-messages',
        message: `project integrity reported ${integrity.messages.length} issue(s)`,
        detail: integrity.messages,
      });
    }
  } catch (err) {
    findings.push({ severity: 'warning', kind: 'integrity-probe-failed', message: String(err) });
  }

  // 5. Leftover atomic-write temp files next to the project.
  try {
    const projectPath = await target.exclusive(async () => {
      const v = (await readStore(target.browser, 'project', 'projectPath')) as { value?: unknown };
      return typeof v.value === 'string' ? v.value : null;
    });
    if (projectPath) {
      const dir = path.dirname(projectPath);
      let leftovers: string[] = [];
      try {
        leftovers = fs.readdirSync(dir).filter((n) => n.endsWith('.stalx.tmp'));
      } catch {
        // Directory gone / unreadable.
      }
      if (leftovers.length > 0) {
        findings.push({
          severity: 'error',
          kind: 'leftover-temp',
          message: `leftover atomic-write temp file(s) beside the project: ${leftovers.join(', ')}`,
          detail: { dir, leftovers },
        });
      }
    }
  } catch (err) {
    findings.push({ severity: 'warning', kind: 'temp-probe-failed', message: String(err) });
  }

  // 6. Memory growth vs the session baseline (first full sweep sets the baseline).
  try {
    const mem = await target.exclusive(() =>
      invokeInApp<{ total_rss_kb: number; webkit_processes: { role: string; rss_kb: number }[]; backend: { rss_kb: number } }>(
        target.browser,
        'get_memory_stats',
      ),
    );
    if (state.memoryBaselineRssKb === null) {
      state.memoryBaselineRssKb = mem.total_rss_kb;
    } else {
      const threshold = state.memoryBaselineRssKb * 1.5 + 300 * 1024;
      if (mem.total_rss_kb > threshold) {
        findings.push({
          severity: 'warning',
          kind: 'memory-growth',
          message: `total RSS ${mb(mem.total_rss_kb)} exceeds baseline ${mb(state.memoryBaselineRssKb)} * 1.5 + 300MB`,
          detail: {
            baselineMb: Math.round(state.memoryBaselineRssKb / 1024),
            currentMb: Math.round(mem.total_rss_kb / 1024),
            backendMb: Math.round(mem.backend.rss_kb / 1024),
            webkit: mem.webkit_processes.map((p) => ({ role: p.role, mb: Math.round(p.rss_kb / 1024) })),
          },
        });
      }
    }
  } catch (err) {
    findings.push({ severity: 'warning', kind: 'memory-probe-failed', message: String(err) });
  }

  // 7. Responsiveness probe: a read-only IPC under a hard timeout. A hang here
  // points at a command-lock deadlock. Read-only so it never mutates the repro.
  try {
    const responsive = await target.exclusive(() =>
      raceTimeout(invokeInApp(target.browser, 'get_recent_logs_since', { afterSeq: 0 }), 5000),
    );
    if (responsive === TIMEOUT) {
      findings.push({
        severity: 'fatal',
        kind: 'unresponsive',
        message: 'IPC did not return within 5s; possible command-lock deadlock',
      });
    }
  } catch (err) {
    findings.push({ severity: 'warning', kind: 'responsiveness-probe-failed', message: String(err) });
  }

  return findings;
}

const TIMEOUT = Symbol('timeout');
async function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function mb(kb: number): string {
  return `${Math.round(kb / 1024)}MB`;
}

export interface SweepResult {
  findings: Finding[];
  newFindings: Finding[];
  worst: Severity | null;
}

const SEVERITY_RANK: Record<Severity, number> = { warning: 1, error: 2, fatal: 3 };

/**
 * Run a sweep, deduplicate against already-reported findings, and for each new
 * fatal/error finding capture a screenshot + finding.json + crash markers into
 * the recorder's findings dir. Emits a `finding` event per new finding.
 */
export async function runSweep(
  target: OracleTarget,
  state: OracleState,
  opts: { full?: boolean; recorder?: RecorderLike } = {},
): Promise<SweepResult> {
  const findings = opts.full ? await fullSweep(target, state) : await cheapSweep(target, state);
  const newFindings: Finding[] = [];
  for (const f of findings) {
    const key = `${f.kind}:${f.message}`;
    if (state.reported.has(key)) continue;
    state.reported.add(key);
    newFindings.push(f);
    opts.recorder?.event('finding', { severity: f.severity, kind: f.kind, message: f.message });
    if (opts.recorder && (f.severity === 'fatal' || f.severity === 'error')) {
      await captureFinding(target, opts.recorder, ++state.findingCount, f).catch(() => undefined);
    }
  }
  let worst: Severity | null = null;
  for (const f of findings) {
    if (!worst || SEVERITY_RANK[f.severity] > SEVERITY_RANK[worst]) worst = f.severity;
  }
  return { findings, newFindings, worst };
}

async function captureFinding(
  target: OracleTarget,
  recorder: RecorderLike,
  index: number,
  finding: Finding,
): Promise<void> {
  const dir = path.join(recorder.findingsDir, String(index).padStart(3, '0'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'finding.json'), JSON.stringify(finding, null, 2));
  // Screenshot (best-effort).
  try {
    const b64 = await target.exclusive(() => target.browser.takeScreenshot());
    fs.writeFileSync(path.join(dir, 'screenshot.png'), Buffer.from(b64, 'base64'));
  } catch {
    // Webview may be dead; the finding is still recorded.
  }
  // Copy any crash markers.
  for (const marker of target.findCrashMarkers()) {
    try {
      fs.copyFileSync(marker, path.join(dir, path.basename(marker)));
    } catch {
      // Best-effort.
    }
  }
}
