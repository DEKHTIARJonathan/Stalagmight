/**
 * The Tier 2 gate: a per-process grant flag plus the TCC preflight.
 *
 * Two independent locks, and both must be open before any os_* action touches
 * the machine:
 *
 * 1. The GRANT is consent. `os_grant` is deliberately never added to any tool
 *    allowlist, so a model calling it always raises a real harness permission
 *    prompt: the human at the keyboard flips this flag, never the model. It is
 *    per-server-process and lives until the MCP server exits - a fresh server
 *    starts ungranted.
 * 2. The PERMISSIONS are capability. Accessibility and Screen Recording belong
 *    to the process that spawned the helper (the terminal or editor running
 *    the server), and a denied grant does NOT produce an error at the point of
 *    use: input events are silently dropped and `screencapture` writes a
 *    wallpaper-only image. Both would score as real evidence, so preflight is
 *    mandatory and its result rides every os_* result.
 */
import { runHelper, type HelperError, type PreflightResult } from './helper';

let granted = false;

/** Record the human's consent for this server process. */
export function grant(): void {
  granted = true;
}

export function isGranted(): boolean {
  return granted;
}

export const GRANT_REQUIRED_MESSAGE =
  'Tier 2 OS input is not granted for this session. These tools drive the REAL ' +
  'cursor and keyboard on the desktop you are sharing with a human, so consent ' +
  'is per-session and cannot be inferred: call os_grant and approve the prompt ' +
  'it raises. The grant lasts until this MCP server exits.';

/**
 * Throw the instructive refusal unless consent was recorded. Call this BEFORE
 * anything that would move the cursor, so a refusal costs the machine nothing.
 */
export function requireGrant(): void {
  if (!granted) {
    throw new Error(GRANT_REQUIRED_MESSAGE);
  }
}

/**
 * Current TCC state. Read-only: neither underlying call prompts, so this is
 * safe to run before a grant and safe to run unattended.
 */
export async function preflight(): Promise<PreflightResult> {
  const result = await runHelper<PreflightResult | HelperError>(['preflight']);
  if (!result.ok) {
    throw new Error(`os helper preflight failed: ${result.error}`);
  }
  return result;
}

/** Instructions for the one permission a caller found missing. */
export function permissionHelp(missing: 'accessibility' | 'screenRecording'): string {
  const pane =
    missing === 'accessibility'
      ? 'Privacy & Security > Accessibility'
      : 'Privacy & Security > Screen Recording';
  const consequence =
    missing === 'accessibility'
      ? 'input events would be posted and silently dropped, which reads as "the app ignored the click"'
      : 'screencapture still exits 0 but writes a desktop-wallpaper image with no app window in it';
  return (
    `macOS ${missing === 'accessibility' ? 'Accessibility' : 'Screen Recording'} permission ` +
    `is not granted, and without it ${consequence}. Grant it in System Settings > ${pane} ` +
    'to the app that runs this harness (your terminal or editor - not the helper binary, ' +
    'and not the Stalagmight app), then restart that app so the new grant is picked up.'
  );
}
