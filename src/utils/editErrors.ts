import i18n from '../i18n';
import { NEWER_FILE_READ_ONLY } from './saveErrors';

/**
 * Marker the backend prefixes onto `CommandResult.error` when a mutation is
 * rejected because the open project is a remote SpeleoDB project opened
 * read-only (no write lock). Mirrors `EDIT_DISABLED_CODE` in
 * `src-tauri/src/core/command.rs`.
 *
 * The full edit-state UX - an indicator that suppresses this toast and offers
 * "Start editing" (acquire the lock) - is owned by #204. Until then,
 * `executeCommand` surfaces a friendly read-only notice instead of the raw
 * coded error so a blocked edit isn't a silent no-op.
 */
export const EDIT_DISABLED = 'EDIT_DISABLED';

/** True if a `CommandResult.error` carries the read-only edit-gate marker. */
export function isEditDisabledError(error?: string | null): boolean {
  return !!error && error.startsWith(EDIT_DISABLED);
}

/**
 * Marker the backend prefixes when the lazy 20-min lock re-verify (#202) blocks an
 * edit because the write lock was lost or the server tip moved. Mirrors
 * `EDIT_REVERIFY_DIVERGED_CODE` in `src-tauri/src/core/command.rs`. Distinct from
 * `EDIT_DISABLED` so the frontend routes it to the divergence prompt (reconcile)
 * rather than the plain read-only notice.
 */
export const EDIT_REVERIFY_DIVERGED = 'EDIT_REVERIFY_DIVERGED';

/** True if a `CommandResult.error` carries the #202 re-verify divergence marker. */
export function isReverifyDivergedError(error?: string | null): boolean {
  return !!error && error.startsWith(EDIT_REVERIFY_DIVERGED);
}

/**
 * Second code the backend puts behind `EDIT_DISABLED` when it refuses an edit
 * because the workspace is Plan or Export, which are read-only (#576 C5; the
 * frontend reports the mode through `set_workspace_mode`). Mirrors
 * `WORKSPACE_READ_ONLY_CODE` in `src-tauri/crates/core/src/core/command.rs`.
 */
export const WORKSPACE_READ_ONLY = 'WORKSPACE_READ_ONLY';

/**
 * Second code the backend puts behind `EDIT_DISABLED` while an Ariane adoption is
 * handing the open project over to SpeleoDB (#576 NF-W4C-3-EDIT, RV5-F4-5): no
 * edit until the adoption's push has landed. Mirrors `ADOPTION_IN_PROGRESS_CODE`
 * in `src-tauri/crates/core/src/core/command.rs`.
 */
export const ADOPTION_IN_PROGRESS = 'ADOPTION_IN_PROGRESS';

/** User-facing toast shown when a read-only project rejects an edit. Says "write
    lock" like the rest of the SpeleoDB copy: the point is that someone else has
    exclusive write access, not that the file itself is locked.

    [#576 B6-D1] Unless the refusal is the OTHER read-only: a project saved by a
    newer Stalagmight, which the backend marks with `NEWER_FILE_READ_ONLY` behind
    `EDIT_DISABLED`. That one has nothing to do with the lock - Start editing is
    refused too - so it gets its own line. Decided from the error itself, not the
    store's flag, so it stays right even where the flag has not caught up.

    [#576 C5] Or the read-only WORKSPACE (`WORKSPACE_READ_ONLY`): Plan and Export
    never edit the survey, whatever the project, so its line points at Survey.

    [#576 RV5-F4-5] Or the adoption hand-over (`ADOPTION_IN_PROGRESS`): the
    project is being uploaded to SpeleoDB, so the generic line's "click Start
    editing" would invite a lock request in the middle of the adoption's own. */
export function READ_ONLY_EDIT_NOTICE(error?: string | null): string {
  if (error?.includes(NEWER_FILE_READ_ONLY)) return i18n.t('editGate.newerFileNotice');
  if (error?.includes(WORKSPACE_READ_ONLY)) return i18n.t('editGate.workspaceReadOnlyNotice');
  if (error?.includes(ADOPTION_IN_PROGRESS)) return i18n.t('editGate.adoptionInProgressNotice');
  return i18n.t('editGate.readOnlyNotice');
}
