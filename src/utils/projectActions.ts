/**
 * Shared, React-free project actions (New / Save As) invoked from BOTH the
 * hamburger menu (the `useProject` hook handlers) and the keyboard dispatchers
 * (`fileShortcutActions` / `useKeyboardShortcuts`).
 *
 * Centralizing them keeps the New-project unsaved-changes guard and the Save-As
 * + overwrite-confirm flow in exactly one place so the menu and keyboard paths
 * can't drift — they previously each had their own copy (the New-project guard
 * existed only on the menu path, and Save-As's `closeAfterSave` handling was
 * added to the menu copy but not the keyboard one).
 *
 * Stores are read via `getState()` so these are callable from raw keydown
 * handlers (outside React). Callers tag the telemetry entry-point source before
 * calling.
 */
import { exists } from '@tauri-apps/plugin-fs';
import { useProjectStore } from '../store/projectStore';
import { useUIStore } from '../store/uiStore';
import { useSpeleoStore } from '../store/speleoStore';
import { surfaceSaveFailure } from './saveFeedback';
import { getErrorMessage, invokeIpc } from './ipc';
import {
  ensureExtension,
  projectSaveFilters,
  saveDialog,
  PROJECT_EXTENSION,
} from './fileDialogs';
import { extractFilename } from './path';
import type { CommandResult } from '../types/commands';

/**
 * Open the New Project dialog, guarding a dirty open project: defer to the
 * unsaved-changes dialog (which opens new-project on discard) instead of letting
 * `createProject` silently clobber unsaved edits. Mirrors the `.stalx`-open guard
 * in `routeOpenedFile`. In GlobalView no project is open, so this falls straight
 * through to the new-project dialog.
 */
export function newProjectGuarded(): void {
  const { openDialog } = useUIStore.getState();
  const ps = useProjectStore.getState();
  if (ps.project && ps.isDirty) {
    openDialog('unsaved-changes', { pendingNewProject: true });
  } else {
    openDialog('new-project');
  }
}

/**
 * Save As: pick a path, then either defer to the overwrite-confirm dialog (the
 * file already exists) or save directly. Carries the caller's "close after a
 * successful save" intent (Save and Close) through the deferred overwrite flow.
 *
 * A failed save is routed through `surfaceSaveFailure` (integrity blocks → Review
 * & Repair; permission denials already surfaced their own guidance dialog). The
 * guard is `!success`, NOT "has an error string": a blocked save can legitimately
 * carry a null error (the block is signaled via `integritySaveBlocked`), and must
 * still surface rather than be mistaken for a clean save.
 */
export async function saveProjectAs(opts?: {
  closeAfterSave?: boolean;
}): Promise<CommandResult | null> {
  const { openDialog } = useUIStore.getState();
  try {
    const selected = await saveDialog({ filters: projectSaveFilters() });
    if (!selected) return null;

    const finalPath = ensureExtension(selected, PROJECT_EXTENSION);
    try {
      if (await exists(finalPath)) {
        // The overwrite-confirm dialog performs the actual save. Carry the
        // close-after-save intent so the deferred flow still closes the project.
        openDialog('confirm-overwrite', {
          path: finalPath,
          fileName: extractFilename(finalPath),
          closeAfterSave: opts?.closeAfterSave ?? false,
        });
        return null;
      }
    } catch {
      // exists() failed — proceed with the save (the backend reports real errors).
    }

    const result = await useProjectStore.getState().saveProject(finalPath);
    if (result && !result.success) {
      surfaceSaveFailure(result.error, openDialog);
    }
    return result;
  } catch (e) {
    // store.saveProject rejects only on an IPC-transport failure (real save
    // failures resolve as CommandResult{success:false}, handled above). Surface
    // it here rather than letting it escape as an unhandled rejection — the
    // keyboard (`void saveProjectAs()`) and menu (`void handleSaveProjectAs()`)
    // call sites don't catch. Return null (not a failure result) so the
    // delegating handleSaveProject doesn't surface a second dialog and
    // saveAndClose treats it as "not saved" and keeps the project open.
    openDialog('error', {
      title: 'Save Failed',
      message: getErrorMessage(e, 'Failed to save project'),
    });
    return null;
  }
}

/**
 * Detach the open SpeleoDB project from SpeleoDB, keeping the local copy as a
 * plain unmanaged `.stalx` (#204 - the shared action behind the no-permission
 * prompt (10) and the divergence "keep my copy" path (11)).
 *
 * Pick a permanent home via the native Save dialog, write the CURRENT (possibly
 * locally-edited) content there, then `speleodb_unlink` so the open project is no
 * longer tied to SpeleoDB and edits freely. Nothing is pushed or released - the
 * SpeleoDB copy is simply abandoned; a later Open-from-SpeleoDB re-pulls the
 * server tip, so the managed side stays clean. Returns true once converted.
 *
 * The save must land first: if it is cancelled or fails, we do NOT unlink (that
 * would silently strand the user's work in the cache with no SpeleoDB link).
 */
export async function convertToUnmanagedStalx(): Promise<boolean> {
  const { openDialog } = useUIStore.getState();
  let finalPath: string;
  try {
    const selected = await saveDialog({ filters: projectSaveFilters() });
    if (!selected) return false;
    finalPath = ensureExtension(selected, PROJECT_EXTENSION);
    const result = await useProjectStore.getState().saveProject(finalPath);
    if (!result || !result.success) {
      surfaceSaveFailure(result?.error ?? null, openDialog);
      return false;
    }
  } catch (e) {
    openDialog('error', {
      title: 'Save Failed',
      message: getErrorMessage(e, 'Failed to save a local copy'),
    });
    return false;
  }

  // The copy is safe on disk - now drop the SpeleoDB link and re-seed the shell as
  // a plain local project (link_status returns is_remote:false → link cleared). The
  // unlink can still reject (e.g. a poisoned database lock); guard it so it can't
  // escape as an unhandled rejection that leaves the dialog open while the project is
  // silently still SpeleoDB-linked though the user was told it converted (fix 6).
  try {
    await invokeIpc('speleodb_unlink');
  } catch (e) {
    openDialog('error', {
      title: 'Detach Failed',
      message: getErrorMessage(e, 'The local copy was saved, but detaching from SpeleoDB failed'),
    });
    return false;
  }
  await useSpeleoStore.getState().refreshLinkStatus();
  return true;
}
