/**
 * Ring-buffer log cursor. Wraps the get_recent_logs_since IPC command so the
 * agent can ask "any new log lines since I last checked", classifying error /
 * warning lines. The cursor only ever moves forward (never regresses on an
 * empty read), which guards the app-side latest_seq=0-on-empty edge case.
 */
import type { Browser } from 'webdriverio';
import { invokeInApp } from './page';

interface RingLogEntry {
  seq: number;
  ts_ms: number;
  line: string;
}
interface LogsSince {
  entries: RingLogEntry[];
  latest_seq: number;
  dropped: boolean;
}

export type LogLevel = 'all' | 'warn' | 'error';

export interface LogReadResult {
  newEntries: string[];
  errorCount: number;
  warnCount: number;
  dropped: boolean;
  latestSeq: number;
}

/** Is this ring line an error (backend ERROR or a captured frontend crash)? */
export function isErrorLine(line: string): boolean {
  return (
    line.startsWith('ERROR') ||
    line.includes('[unhandled-error]') ||
    line.includes('[unhandled-rejection]') ||
    line.includes('PANIC:')
  );
}

export function isWarnLine(line: string): boolean {
  return line.startsWith('WARN');
}

export class LogCursor {
  private cursor = 0;

  constructor(private readonly browser: Browser) {}

  /** Reset the cursor to the current tail (call after seeding to ignore startup noise). */
  async checkpoint(): Promise<void> {
    const res = await invokeInApp<LogsSince>(this.browser, 'get_recent_logs_since', { afterSeq: this.cursor });
    this.cursor = Math.max(this.cursor, res.latest_seq);
  }

  /**
   * Read entries since the cursor. `peek` reads without advancing. `level`
   * filters which lines are returned (counts are always over all new lines).
   */
  async read(level: LogLevel = 'error', peek = false): Promise<LogReadResult> {
    const res = await invokeInApp<LogsSince>(this.browser, 'get_recent_logs_since', { afterSeq: this.cursor });
    const errorCount = res.entries.filter((e) => isErrorLine(e.line)).length;
    const warnCount = res.entries.filter((e) => isWarnLine(e.line)).length;
    const filtered = res.entries.filter((e) => {
      if (level === 'all') return true;
      if (level === 'warn') return isWarnLine(e.line) || isErrorLine(e.line);
      return isErrorLine(e.line);
    });
    if (!peek) this.cursor = Math.max(this.cursor, res.latest_seq);
    return {
      newEntries: filtered.map((e) => e.line),
      errorCount,
      warnCount,
      dropped: res.dropped,
      latestSeq: res.latest_seq,
    };
  }
}
