/**
 * AppSession is the LINUX session: build freshness, Xvfb, tauri-driver, the
 * remote() attach and a process-group teardown. Everything platform-neutral
 * (state machine, command mutex, recorder, profile, orphan reaping) lives in
 * SessionCore; the attach + readiness steps live in lib/sessionShared. One
 * session per process. All WebDriver traffic is serialized through the command
 * mutex so a heartbeat/health probe never interleaves with a tool call.
 *
 * Instantiate through createSession(), not directly: it picks the platform.
 */
// FIRST import on purpose: patches webdriver's undici before webdriverio (linked
// transitively below) links it. See the module comment for the Node >= 26 failure
// it fixes.
import './lib/undici-dispatcher-pin';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { binaryPath } from '../lib/env';
import { checkDisplayAvailable, startXvfb, type XvfbHandle } from '../lib/display';
import { checkBuildFreshness, buildApp } from './lib/build';
import { findFreePort, isPidAlive, recordPid, reapPidsFromFile, waitForPortListening } from './lib/procs';
import { SessionCore, gitHead, safeMtime } from './lib/sessionCore';
import { attachBrowser, verifyReadiness, E2EHooksMissingError } from './lib/sessionShared';
import type { StartOptions, StartResult } from './sessionTypes';

export type {
  SessionState,
  BuildMode,
  StartOptions,
  StartResult,
  AgentSession,
} from './sessionTypes';

const BASE_PORT = Number.parseInt(process.env.STALAGMIGHT_AGENT_BASE_PORT ?? '4544', 10);
const XVFB_DISPLAYS = [':89', ':88', ':87', ':86', ':85'];
const REAP_COMM_NAMES = ['stalagmight', 'tauri-driver', 'WebKitWebDriver'];

export class AppSession extends SessionCore {
  private driver: ChildProcess | null = null;
  private xvfb: XvfbHandle | null = null;
  private display = '';
  private driverPort = 0;
  private nativePort = 0;
  private driverLog: fs.WriteStream | null = null;

  protected reapCommNames(): string[] {
    return REAP_COMM_NAMES;
  }

  protected async startInner(opts: StartOptions): Promise<StartResult> {
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
        if (build !== 'force' && freshness.reasons.length > 0) {
          process.stderr.write(`Rebuilding: ${freshness.reasons.join('; ')}\n`);
        }
        buildApp((line) => process.stderr.write(`${line}\n`));
        buildAction = 'built';
      } else {
        buildAction = 'fresh';
      }
    }

    this.state = 'launching';

    // 2. Display. headed:true shows the window on the real desktop; the
    // default is a throwaway Xvfb EVEN IF a desktop display exists, so agent
    // runs never pop a window or steal focus while someone is working.
    if (opts.headed) {
      if (!checkDisplayAvailable()) {
        this.state = 'idle';
        throw new Error('headed:true requested but no display (DISPLAY/WAYLAND_DISPLAY) is available');
      }
      this.display = process.env.DISPLAY ?? ':0';
    } else {
      // 1920x1080 screen so window-size testing has headroom up to full HD
      // (the app window starts smaller; resizing is capped by the screen).
      this.xvfb = await startXvfb(XVFB_DISPLAYS, '1920x1080x24');
      if (this.xvfb) {
        this.display = this.xvfb.display;
      } else if (checkDisplayAvailable()) {
        process.stderr.write(
          '[agent] WARNING: Xvfb unavailable; falling back to the real display (the app window WILL be visible).\n',
        );
        this.display = process.env.DISPLAY ?? ':0';
      } else {
        this.state = 'idle';
        throw new Error('no display available and Xvfb could not start');
      }
    }

    // 3. Session dir + isolated profile.
    const { profileRoot, profileEnv } = this.prepareSession(freshProfile);

    // 4. Ports.
    this.driverPort = await findFreePort(BASE_PORT);
    this.nativePort = await findFreePort(this.driverPort + 1000);

    // 5. tauri-driver, with the isolated env + test hooks (app inherits it).
    this.driverLog = fs.createWriteStream(path.join(this.recorder.dir, 'tauri-driver.log'), {
      flags: 'a',
    });
    const driverLog = this.driverLog;
    const driverEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...profileEnv,
      DISPLAY: this.display,
      STALAGMIGHT_TEST_HOOKS: '1',
      RUST_BACKTRACE: '1',
    };
    if (this.xvfb) {
      // Pin GTK to the X11 backend on the virtual display. With WAYLAND_DISPLAY
      // set (a Wayland desktop), GTK prefers Wayland and would render the
      // "headless" app onto the real compositor, ignoring DISPLAY entirely.
      driverEnv.GDK_BACKEND = 'x11';
      delete driverEnv.WAYLAND_DISPLAY;
    }
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
        env: driverEnv,
      },
    );
    if (this.driver.pid) recordPid(this.pidFile(), this.driver.pid);
    this.driver.stdout?.on('data', (d: Buffer) => driverLog.write(d));
    this.driver.stderr?.on('data', (d: Buffer) => driverLog.write(d));
    const driverChild = this.driver;
    this.driver.on('exit', (code) => {
      // Only the CURRENT driver dying unexpectedly is a crash. A late exit
      // event from a driver this session already stopped or replaced (e.g. a
      // SIGKILL-path stop reaps after stop() returned and reset state, or
      // app_restart already spawned a successor) must not flip a healthy
      // session to 'crashed' with a bogus crash-detected log line.
      if (this.driver !== driverChild) return;
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
    try {
      this.browserInstance = await attachBrowser(this.driverPort, {
        platformName: 'linux',
        'wdio:enforceWebDriverClassic': true,
        'tauri:options': { application: binaryPath },
      });
    } catch (err) {
      await this.stop('attach-failed');
      throw err;
    }

    // 7. Ready + hook verification.
    try {
      await verifyReadiness(this.browserInstance);
    } catch (err) {
      // Only the hooks failure gets its own stop reason; anything else falls
      // through to start()'s generic 'start-failed' teardown.
      if (err instanceof E2EHooksMissingError) await this.stop('hooks-missing');
      throw err;
    }

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
      profileDir: profileRoot,
      freshProfile,
    });

    return {
      state: this.state,
      appPidKnown: false,
      driverPort: this.driverPort,
      nativePort: this.nativePort,
      display: this.display,
      profileDir: profileRoot,
      buildAction,
      sessionDir: this.recorder.dir,
    };
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
        // Bounded: an unresponsive driver would otherwise block stop() for the
        // full webdriverio connectionRetryTimeout (30s) before the group kill
        // below ever runs.
        await Promise.race([
          this.browserInstance.deleteSession(),
          new Promise((r) => setTimeout(r, 5000)),
        ]);
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
    // Close the tauri-driver log stream; without this the fd leaks across
    // every app_restart cycle for the life of the MCP server process.
    this.driverLog?.end();
    this.driverLog = null;
    // Backstop: scoped reap of anything this session recorded, by verified comm.
    if (this.recorderInstance) {
      reapPidsFromFile(this.pidFile(), REAP_COMM_NAMES);
    }
    if (this.xvfb) {
      const xvfbPid = this.xvfb.proc.pid;
      try {
        this.xvfb.proc.kill();
      } catch {
        // Already gone.
      }
      // Escalate: nothing reaps a wedged Xvfb across runs, and a leaked one
      // holds its display slot from the fixed XVFB_DISPLAYS pool forever.
      if (xvfbPid) {
        await new Promise((r) => setTimeout(r, 300));
        if (isPidAlive(xvfbPid)) {
          try {
            process.kill(xvfbPid, 'SIGKILL');
          } catch {
            // Already gone.
          }
        }
      }
      this.xvfb = null;
    }
    this.disposeProfile(opts.keepProfile);
    this.finishStop(reason);
  }
}
