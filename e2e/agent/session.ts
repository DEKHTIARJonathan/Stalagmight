/**
 * AppSession owns a persistent WebdriverIO session against the real Tauri debug
 * binary: build freshness, an isolated profile, tauri-driver, the remote()
 * attach, and teardown. One session per process. All WebDriver traffic is
 * serialized through a command mutex so a heartbeat/health probe never
 * interleaves with a tool call.
 */
import { spawn, execSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { remote, type Browser } from 'webdriverio';
import { binaryPath, isolatedEnv } from '../lib/env';
import { checkDisplayAvailable, startXvfb, type XvfbHandle } from '../lib/display';
import { checkBuildFreshness, buildApp } from './lib/build';
import {
  findFreePort,
  isPidAlive,
  recordPid,
  reapPidsFromFile,
  waitForPortListening,
} from './lib/procs';
import { Recorder, ARTIFACTS_ROOT } from './lib/recorder';
import { waitForAppReady, waitForE2EHooks, disableOnboardingGuides } from './lib/waiters';

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

const BASE_PORT = Number.parseInt(process.env.STALAGMIGHT_AGENT_BASE_PORT ?? '4544', 10);
const XVFB_DISPLAYS = [':89', ':88', ':87', ':86', ':85'];

function timestampId(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const rand = Math.floor((now.getTime() % 100000)).toString(36).padStart(4, '0').slice(-4);
  return `${stamp}-${rand}`;
}

function gitHead(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

export class AppSession {
  state: SessionState = 'idle';
  private browserInstance: Browser | null = null;
  private driver: ChildProcess | null = null;
  private xvfb: XvfbHandle | null = null;
  private profileRoot: string | null = null;
  private profileDataHome: string | null = null;
  private display = '';
  private driverPort = 0;
  private nativePort = 0;
  private recorderInstance: Recorder | null = null;
  private sessionId = '';
  private startedAtMs = 0;
  private queue: Promise<unknown> = Promise.resolve();

  get browser(): Browser {
    if (!this.browserInstance) throw new Error('no live session (call app_start)');
    return this.browserInstance;
  }

  get recorder(): Recorder {
    if (!this.recorderInstance) throw new Error('no recorder (session not started)');
    return this.recorderInstance;
  }

  get sessionDir(): string {
    return this.recorderInstance?.dir ?? '';
  }

  get hasRecorder(): boolean {
    return this.recorderInstance !== null;
  }

  /** The app's isolated XDG_DATA_HOME (crash markers/logs live under here). */
  get profileDataDir(): string | null {
    return this.profileDataHome;
  }

  /** Serialize a WebDriver interaction; sets state busy->ready around it. */
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      if (this.state !== 'ready' && this.state !== 'busy') {
        throw new Error(`session not ready (state=${this.state})`);
      }
      this.state = 'busy';
      try {
        return await fn();
      } finally {
        if (this.state === 'busy') this.state = 'ready';
      }
    });
    // Keep the queue chained even if this call rejects.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private pidFile(): string {
    return path.join(this.recorder.dir, 'pids');
  }

  /** Recursively find crash-*.json markers under the isolated data dir. */
  findCrashMarkers(): string[] {
    const root = this.profileDataHome;
    if (!root) return [];
    const out: string[] = [];
    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.startsWith('crash-') && e.name.endsWith('.json')) out.push(full);
      }
    };
    walk(root);
    return out;
  }

  async start(opts: StartOptions = {}): Promise<StartResult> {
    if (this.state !== 'idle' && this.state !== 'crashed') {
      throw new Error(`cannot start from state ${this.state}`);
    }
    // webdriverio 9's HTTP layer creates an undici Agent from its bundled undici
    // and hands it to Node's built-in fetch. That only works when the two undici
    // versions match, i.e. on the repo-pinned Node 22 (.nvmrc). On Node >= 23 it
    // fails with UND_ERR_INVALID_ARG at POST /session. Warn early.
    const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
    if (nodeMajor !== 22) {
      process.stderr.write(
        `[agent] WARNING: running on Node ${process.versions.node}; the harness is tested on Node 22 (see .nvmrc). ` +
          'If app_start fails with UND_ERR_INVALID_ARG, switch to Node 22 (nvm use).\n',
      );
    }
    const build = opts.build ?? 'auto';
    const freshProfile = opts.freshProfile ?? true;

    // Reap orphans from previous sessions (scoped to recorded pidfiles).
    this.reapPreviousSessions();

    // 1. Build freshness.
    let buildAction: StartResult['buildAction'] = 'skipped';
    if (build !== 'skip') {
      const freshness = checkBuildFreshness();
      if (build === 'force' || !freshness.fresh) {
        this.state = 'building';
        buildApp((line) => process.stderr.write(`${line}\n`));
        buildAction = 'built';
      } else {
        buildAction = 'fresh';
      }
    }

    this.state = 'launching';

    // 2. Display.
    if (checkDisplayAvailable()) {
      this.display = process.env.DISPLAY ?? ':0';
    } else {
      if (opts.headed) {
        this.state = 'idle';
        throw new Error('headed:true requested but no DISPLAY is available');
      }
      this.xvfb = await startXvfb(XVFB_DISPLAYS, '1280x720x24');
      if (!this.xvfb) {
        this.state = 'idle';
        throw new Error('no display available and Xvfb could not start');
      }
      this.display = this.xvfb.display;
    }

    // 3. Isolated profile. A profile kept alive by stop(keepProfile) is reused
    // when freshProfile=false; a fresh start discards any kept one first.
    this.sessionId = timestampId();
    this.recorderInstance = new Recorder(this.sessionId);
    if (freshProfile && this.profileRoot) {
      try {
        fs.rmSync(this.profileRoot, { recursive: true, force: true });
      } catch {
        // Best-effort.
      }
      this.profileRoot = null;
    }
    this.profileRoot = this.profileRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), 'stalagmight-agent-'));
    const profileEnv = isolatedEnv(this.profileRoot);
    this.profileDataHome = profileEnv.XDG_DATA_HOME ?? profileEnv.HOME ?? this.profileRoot;

    // 4. Ports.
    this.driverPort = await findFreePort(BASE_PORT);
    this.nativePort = await findFreePort(this.driverPort + 1000);

    // 5. tauri-driver, with the isolated env + test hooks (app inherits it).
    const driverLog = fs.createWriteStream(path.join(this.recorder.dir, 'tauri-driver.log'), {
      flags: 'a',
    });
    this.driver = spawn(
      'tauri-driver',
      ['--port', String(this.driverPort), '--native-port', String(this.nativePort)],
      {
        // detached makes tauri-driver a process-group leader so stop() can kill
        // the whole tree (tauri-driver + WebKitWebDriver + the app) with one
        // scoped process.kill(-pid); killing tauri-driver alone orphans the
        // WebKitWebDriver daemon it spawns.
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...profileEnv,
          DISPLAY: this.display,
          STALAGMIGHT_TEST_HOOKS: '1',
          RUST_BACKTRACE: '1',
        },
      },
    );
    if (this.driver.pid) recordPid(this.pidFile(), this.driver.pid);
    this.driver.stdout?.on('data', (d: Buffer) => driverLog.write(d));
    this.driver.stderr?.on('data', (d: Buffer) => driverLog.write(d));
    this.driver.on('exit', (code) => {
      if (this.state !== 'stopping') {
        this.state = 'crashed';
        this.recorderInstance?.event('crash-detected', { reason: 'driver-exit', exitCode: code });
      }
    });

    // Wait for tauri-driver to actually accept connections before attaching
    // (a fixed sleep is both slower and flakier on a loaded box).
    const bound = await waitForPortListening(this.driverPort, 15000, () => !this.driverAlive());
    if (!bound) {
      await this.stop('driver-bind-timeout');
      throw new Error(
        `tauri-driver did not start listening on port ${this.driverPort} within 15s ` +
          `(see tauri-driver.log in the session dir)`,
      );
    }

    // 6. Attach. Mirror wdio.conf.ts's capabilities exactly (no browserName;
    // tauri-driver reads the non-standard tauri:options).
    const capabilities = {
      platformName: 'linux',
      'wdio:enforceWebDriverClassic': true,
      'tauri:options': { application: binaryPath },
    };
    try {
      this.browserInstance = await remote({
        hostname: '127.0.0.1',
        port: this.driverPort,
        path: '/',
        logLevel: 'silent',
        connectionRetryCount: 3,
        connectionRetryTimeout: 30000,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        capabilities: capabilities as any,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.stop('attach-failed');
      if (msg.includes('UND_ERR_INVALID_ARG')) {
        throw new Error(
          'Failed to attach to tauri-driver (UND_ERR_INVALID_ARG). This is a webdriverio + Node ' +
            `version mismatch: you are on Node ${process.versions.node}. Run the harness under the ` +
            'repo-pinned Node 22 (see .nvmrc / nvm use).',
        );
      }
      throw new Error(`Failed to attach to tauri-driver on port ${this.driverPort}: ${msg}`);
    }

    // 7. Ready + hook verification.
    await waitForAppReady(this.browserInstance);
    const hooksReady = await waitForE2EHooks(this.browserInstance);
    if (!hooksReady) {
      await this.stop('hooks-missing');
      throw new Error(
        'window.__E2E_TEST__ not present: the binary was built without VITE_E2E=1. Rerun app_start with build:"force".',
      );
    }
    await disableOnboardingGuides(this.browserInstance);

    this.state = 'ready';
    this.startedAtMs = Date.now();
    this.recorder.sessionStart({
      sessionId: this.sessionId,
      startedAt: new Date().toISOString(),
      gitHead: gitHead(),
      binaryPath,
      binaryMtime: safeMtime(binaryPath),
      display: this.display,
      headed: Boolean(opts.headed),
      profileDir: this.profileRoot,
      freshProfile,
    });

    return {
      state: this.state,
      appPidKnown: false,
      driverPort: this.driverPort,
      nativePort: this.nativePort,
      display: this.display,
      profileDir: this.profileRoot,
      buildAction,
      sessionDir: this.recorder.dir,
    };
  }

  private reapPreviousSessions(): void {
    let dirs: string[];
    try {
      dirs = fs.readdirSync(ARTIFACTS_ROOT);
    } catch {
      return;
    }
    for (const name of dirs) {
      reapPidsFromFile(path.join(ARTIFACTS_ROOT, name, 'pids'), [
        'stalagmight',
        'tauri-driver',
        'WebKitWebDriver',
      ]);
    }
  }

  uptimeMs(): number {
    return this.startedAtMs ? Date.now() - this.startedAtMs : 0;
  }

  driverAlive(): boolean {
    return Boolean(this.driver && this.driver.pid && isPidAlive(this.driver.pid));
  }

  /**
   * Stop the session. `keepProfile` preserves the isolated profile dir so a
   * following start({freshProfile: false}) sees the same persisted state
   * (app_restart's persisted-state repro mode depends on this).
   */
  async stop(reason = 'app_stop', opts: { keepProfile?: boolean } = {}): Promise<void> {
    this.state = 'stopping';
    if (this.browserInstance) {
      try {
        await this.browserInstance.deleteSession();
      } catch {
        // Session may already be dead.
      }
      this.browserInstance = null;
    }
    if (this.driver?.pid) {
      const groupPid = this.driver.pid;
      // Kill the whole process group (tauri-driver + WebKitWebDriver + app).
      try {
        process.kill(-groupPid, 'SIGTERM');
      } catch {
        // Group already gone.
      }
      await new Promise((r) => setTimeout(r, 1500));
      try {
        process.kill(-groupPid, 'SIGKILL');
      } catch {
        // Group already gone.
      }
      this.driver = null;
    }
    // Backstop: scoped reap of anything this session recorded, by verified comm.
    if (this.recorderInstance) {
      reapPidsFromFile(this.pidFile(), ['stalagmight', 'tauri-driver', 'WebKitWebDriver']);
    }
    if (this.xvfb) {
      try {
        this.xvfb.proc.kill();
      } catch {
        // Already gone.
      }
      this.xvfb = null;
    }
    if (this.profileRoot && !opts.keepProfile) {
      try {
        fs.rmSync(this.profileRoot, { recursive: true, force: true });
      } catch {
        // Best-effort.
      }
      this.profileRoot = null;
      this.profileDataHome = null;
    }
    this.recorderInstance?.sessionEnd(reason);
    this.state = 'idle';
  }
}

function safeMtime(file: string): number {
  try {
    return Math.floor(fs.statSync(file).mtimeMs);
  } catch {
    return 0;
  }
}
