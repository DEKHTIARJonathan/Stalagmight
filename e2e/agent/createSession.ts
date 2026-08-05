/**
 * Picks the session implementation for the running platform. Every consumer
 * (MCP server, smokes) goes through here instead of naming a platform class, so
 * adding one is a change to this file only.
 *
 * An unsupported platform is refused HERE, immediately and by name. It used to
 * be discovered as a 15 s "tauri-driver did not start listening" timeout on
 * macOS, which reads as a broken driver rather than an unsupported OS (#422).
 */
// FIRST import on purpose, before anything can pull in webdriverio: it patches
// webdriver's undici. See the module comment for the Node >= 26 failure it fixes.
import './lib/undici-dispatcher-pin';
import { AppSession } from './session';
import type { AgentSession } from './sessionTypes';

const DESIGN_DOC = 'docs/plans/2026-08-05_macos-agent-harness.md';

/** Override for tests and for forcing a platform path; defaults to the real OS. */
function targetPlatform(): string {
  return process.env.STALAGMIGHT_AGENT_PLATFORM ?? process.platform;
}

export function createSession(): AgentSession {
  const plat = targetPlatform();
  if (plat === 'linux') return new AppSession();
  if (plat === 'darwin') {
    throw new Error(
      'the agent harness has no macOS session yet: MacSession lands in PR2 of the macOS ' +
        `agent-harness work (issue #421, ${DESIGN_DOC}). tauri-driver, which the Linux ` +
        'session drives, has no macOS support, so running it here would only hang and then ' +
        'report a misleading port timeout (#422). Run the harness on Linux until PR2 lands.',
    );
  }
  throw new Error(
    `the agent harness has no session backend for platform "${plat}": it requires Linux ` +
      '(tauri-driver: `cargo install tauri-driver --locked`, plus webkit2gtk-driver) or macOS ' +
      `(tauri-wd, pending - see issue #421 and ${DESIGN_DOC}).`,
  );
}
