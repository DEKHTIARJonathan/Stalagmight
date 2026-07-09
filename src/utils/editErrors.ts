/**
 * Marker the backend prefixes onto `CommandResult.error` when a mutation is
 * rejected because the open project is a remote SpeleoDB project opened
 * read-only (no write lock). Mirrors `EDIT_DISABLED_CODE` in
 * `src-tauri/src/core/command.rs`.
 *
 * The full edit-state UX — an indicator that suppresses this toast and offers
 * "Start editing" (acquire the lock) — is owned by #204. Until then,
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

/** User-facing message shown when a read-only project rejects an edit. */
export const READ_ONLY_EDIT_NOTICE =
  'This project is open read-only - click Start editing to acquire the lock.';

/**
 * Map a raw `CommandResult.error` to a user-facing string: the read-only edit
 * gate (`EDIT_DISABLED: ...`) becomes the friendly notice; anything else passes
 * through (or the caller's fallback when absent). Use this at any dialog/inline
 * error sink that renders `result.error` verbatim, so a blocked edit never shows
 * the raw internal code (agent-harness campaign ws07: EditStationDialog leaked
 * "EDIT_DISABLED: Set comment on station 0:2 is disabled: ...").
 */
export function humanizeEditError(error: string | null | undefined, fallback: string): string {
  if (isEditDisabledError(error)) return READ_ONLY_EDIT_NOTICE;
  return error ?? fallback;
}
