/**
 * Platform-neutral session contract. `AgentSession` is exactly the surface the
 * MCP server, the oracles, the scenario framework and the smokes consume, so a
 * platform implementation (Linux tauri-driver today, macOS tauri-wd next) can be
 * swapped in behind createSession() without touching a caller. It structurally
 * satisfies the existing `OracleTarget` and `ScenarioTarget` seams.
 */
import type { Browser } from 'webdriverio';
import type { Recorder } from './lib/recorder';

export type SessionState =
  | 'idle'
  | 'building'
  | 'launching'
  | 'ready'
  | 'busy'
  | 'crashed'
  | 'stopping';

export type BuildMode = 'auto' | 'skip' | 'force';

export interface StartOptions {
  build?: BuildMode;
  headed?: boolean;
  freshProfile?: boolean;
}

export interface StartResult {
  state: SessionState;
  appPidKnown: boolean;
  driverPort: number;
  nativePort: number;
  display: string;
  profileDir: string;
  buildAction: 'skipped' | 'built' | 'fresh';
  sessionDir: string;
}

export interface AgentSession {
  /** Mutable: driver_script's wedge handler poisons a session by writing 'crashed'. */
  state: SessionState;
  readonly browser: Browser;
  readonly recorder: Recorder;
  readonly hasRecorder: boolean;
  readonly sessionDir: string;
  /** The app's isolated data dir (crash markers/logs live under here). */
  readonly profileDataDir: string | null;
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
  findCrashMarkers(): string[];
  start(opts?: StartOptions): Promise<StartResult>;
  stop(reason?: string, opts?: { keepProfile?: boolean }): Promise<void>;
  uptimeMs(): number;
  driverAlive(): boolean;
}
