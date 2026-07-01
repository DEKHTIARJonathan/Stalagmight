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

/** User-facing message shown when a read-only project rejects an edit. */
export const READ_ONLY_EDIT_NOTICE =
  'This project is open read-only - click Start editing to acquire the lock.';
