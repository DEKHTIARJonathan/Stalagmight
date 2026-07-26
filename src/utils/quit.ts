/**
 * Quit entry point, shared by every affordance (GlobalView menu, in-project
 * menu, the Ctrl+Q shortcut in both shortcut hooks, AND the OS window close
 * button) so the exit guards + close contract live in exactly one place.
 */
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useProjectStore } from '../store/projectStore';
import { useSpeleoStore, type SpeleoLinkState } from '../store/speleoStore';
import { useUIStore } from '../store/uiStore';

/**
 * Set by {@link performQuit} for exactly one `tauri://close-requested` round
 * trip: the quit the user just confirmed in-app must not be re-guarded by
 * {@link guardQuit} when the window close comes back through the App-level
 * close listener. Without it, "Discard & Quit" would re-open the very dialog it
 * came from - an unbreakable loop, since the guard reads live store state that
 * a discard deliberately leaves dirty.
 */
let quitConfirmed = false;

/**
 * Read AND clear the one-shot confirmation. Consuming it (rather than peeking)
 * is what keeps it from going stale: if the close attempt is then abandoned for
 * any other reason, the next close request is guarded normally again.
 */
export function consumeQuitConfirmation(): boolean {
  const confirmed = quitConfirmed;
  quitConfirmed = false;
  return confirmed;
}

/** Test-only reset so a leaked confirmation can't bleed across cases. */
export function resetQuitConfirmationForTests(): void {
  quitConfirmed = false;
}

/**
 * Perform the actual quit: request a window close.
 *
 * The Rust `on_window_event` handler re-emits `tauri://close-requested`, which
 * the App-level `useBeforeUnload` listener turns into a window destroy. The
 * one-shot flag above tells that listener this quit is already confirmed, so it
 * skips {@link guardQuit} instead of re-prompting. Requires the
 * `core:window:allow-close` capability; a rejection is logged (and un-arms the
 * flag, so the next close request is guarded again) so a denied/regressed
 * capability is visible rather than failing silently.
 *
 * Call this only AFTER any exit confirmation - it does NOT prompt.
 */
export function performQuit(): void {
  quitConfirmed = true;
  getCurrentWindow()
    .close()
    .catch((err) => {
      quitConfirmed = false;
      console.error('[quit] window.close() failed:', err);
    });
}

/**
 * Work that exists ONLY on this computer: edits SpeleoDB has never seen.
 *
 * Shared by both exits ({@link guardQuit} and `useProject.handleCloseProject`) so
 * they cannot drift again. The predicate keys on the WORK AT RISK, not on the
 * lock, because the states where the work is most stranded are precisely the ones
 * that drop the lock while keeping the edits: `notifyReverifyDivergence()` sets
 * read-only, and any `ReLogin` error runs `clearSession()`, which does too.
 *
 * The two exits are not identical, and deliberately so - see each call site. Quit
 * needs only this: holding the lock with nothing unpushed is safe to walk away
 * from, because the backend's exit-time release vetoes itself when there ARE
 * unpushed edits (aab5121d). Close additionally has to resolve a held lock, since
 * it hands the project back while the app keeps running.
 */
export function hasUnpushedSpeleoWork(link: SpeleoLinkState | null): boolean {
  return link?.hasUnpushedEdits === true;
}

/**
 * Do we hold the SpeleoDB write lock?
 *
 * `editState === 'editing'` is the app's hold-lock signal (the backend enforces
 * hold-lock ⟹ edit-enabled), EXCEPT while force-editing (#213), which is editing
 * with no lock at all - so a force-editor must count as NOT holding it.
 *
 * Shared because that second half is the easy half to forget, and forgetting it
 * is not cosmetic: it offers a force-editor lock-owner actions (release, restore,
 * push-and-release) that the backend can only refuse. It lived spelled out at six
 * call sites and one had already drifted - `SpeleoProjectAdmin`'s Lock section
 * told a force-editor "held by you" and offered them Release.
 */
export function holdsWriteLock(link: SpeleoLinkState | null): boolean {
  return link?.editState === 'editing' && !link.forceEditing;
}

/**
 * The exit guards, in the order the close flow uses them (see
 * `useProject.handleCloseProject`). Returns `true` when a dialog was opened and
 * the caller must NOT quit; `false` when there is nothing to protect.
 *
 * Ordering - SpeleoDB first, unsaved-to-disk second - is the same as the
 * close-project flow's, and matters because the two conditions overlap: a project
 * can be both unsaved to disk AND unpushed to the server. The SpeleoDB prompt is
 * the one that subsumes the other (it carries its own "Save changes locally"
 * checkbox, defaulted to on, exactly like `SpeleoCloseDialog`), so running it
 * first composes the two into ONE decision. The reverse order could not: the
 * unsaved-changes dialog knows nothing about the lock, so its "Discard & Quit"
 * would quit straight past the unpushed edits.
 *
 * Both branches terminate: each dialog quits via {@link performQuit}, which
 * arms the one-shot confirmation so the resulting close request skips this
 * guard entirely.
 */
export function guardQuit(): boolean {
  const { project, isDirty } = useProjectStore.getState();
  if (!project) return false;

  const link = useSpeleoStore.getState().link;
  // Keyed on the WORK AT RISK only - see {@link hasUnpushedSpeleoWork}. Whether we
  // still hold the write lock changes which choices the dialog can offer (it
  // adapts), not whether the user should be told. Holding the lock with nothing
  // unpushed needs no prompt at QUIT time specifically: the backend's exit-time
  // release is safe then, and vetoes itself otherwise (aab5121d). The close flow
  // does not get that for free, so it guards on the lock as well.
  if (hasUnpushedSpeleoWork(link)) {
    useUIStore.getState().openDialog('speleodb-quit');
    return true;
  }

  if (isDirty) {
    useUIStore.getState().openDialog('unsaved-changes', { pendingQuit: true });
    return true;
  }

  return false;
}

/**
 * Quit the application, routing through the exit guards first: unpushed
 * SpeleoDB edits held under our write lock, then unsaved-to-disk changes. The
 * OS window close button goes through the SAME guard (App wires `guardQuit`
 * into `useBeforeUnload`), so X and Quit behave identically.
 */
export function quitApp(): void {
  if (guardQuit()) return;
  performQuit();
}
