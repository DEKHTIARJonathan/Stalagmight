/**
 * Shared X display helpers for running the real Tauri binary headless. Used by
 * wdio.conf.ts and the agent harness. On Linux with no DISPLAY/WAYLAND, start a
 * throwaway Xvfb server so the webview has somewhere to render.
 */
import { spawn, execSync, type ChildProcess } from 'child_process';

/** True if a usable display is already available (or the platform always has one). */
export function checkDisplayAvailable(): boolean {
  if (process.platform === 'win32') return true;
  if (process.platform === 'darwin') return true;
  if (process.env.DISPLAY) return true;
  if (process.env.WAYLAND_DISPLAY) return true;
  return false;
}

export interface XvfbHandle {
  /** The `:N` display the server bound to. */
  display: string;
  /** The Xvfb child process (kill it when done). */
  proc: ChildProcess;
}

/**
 * Try to start an Xvfb server on one of `displays` at `screen` (e.g.
 * "1280x720x24"). Returns a handle with the chosen display and child process,
 * or null if Xvfb is missing or every candidate failed to start.
 *
 * Does NOT mutate `process.env`: the caller sets DISPLAY on whatever
 * environment it will hand to child processes. This is what lets the agent run
 * a headless app without changing the MCP server's own environment.
 */
export async function startXvfb(displays: string[], screen: string): Promise<XvfbHandle | null> {
  if (process.platform === 'win32') return null;

  try {
    execSync('which Xvfb', { stdio: 'ignore' });
  } catch {
    return null;
  }

  for (const display of displays) {
    const child = spawn('Xvfb', [display, '-screen', '0', screen, '-ac', '-nolisten', 'tcp'], {
      stdio: 'ignore',
    });

    const started = await new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(child.exitCode === null);
        }
      }, 250);
      child.once('error', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(false);
        }
      });
      child.once('exit', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(false);
        }
      });
    });

    if (started) {
      return { display, proc: child };
    }
  }

  return null;
}
