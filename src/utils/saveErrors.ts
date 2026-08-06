/**
 * Marker the backend uses to flag a filesystem permission denial (e.g. macOS
 * forgot folder access after an OS/app update). Mirrors `PERMISSION_DENIED_CODE`
 * in `src-tauri/src/core/loading.rs`:
 * - save path: prefixed onto `CommandResult.error`
 * - open path: surfaced as `LoadError.code === 'PERMISSION'`
 */
export const FS_PERMISSION_DENIED = 'FS_PERMISSION_DENIED';

/**
 * Marker for a destination that is not reachable at all - the folder was
 * deleted or renamed, or its drive is not connected. Mirrors
 * `PATH_NOT_FOUND_CODE` (same file). Split out from the permission marker
 * because the two have no remediation in common: granting folder access cannot
 * bring back a drive that is unplugged (#429).
 */
export const FS_PATH_NOT_FOUND = 'FS_PATH_NOT_FOUND';

/**
 * Marker for a destination path longer than the OS will open - on Windows,
 * anything at or past the 260-character `MAX_PATH` budget SQLite's file layer
 * is bound by. Mirrors `PATH_TOO_LONG_CODE` (same file).
 */
export const FS_PATH_TOO_LONG = 'FS_PATH_TOO_LONG';

/** What a failed save's `CommandResult.error` says went wrong. */
export type SaveErrorKind = 'permission' | 'path-not-found' | 'path-too-long' | 'other';

/**
 * Classify a save `CommandResult.error` by its backend marker. `other` covers
 * both unmarked errors (disk full, corruption) and no error at all - in both
 * cases there is no better wording than what the backend sent.
 */
export function classifySaveError(error?: string | null): SaveErrorKind {
  if (!error) return 'other';
  if (error.startsWith(FS_PERMISSION_DENIED)) return 'permission';
  if (error.startsWith(FS_PATH_NOT_FOUND)) return 'path-not-found';
  if (error.startsWith(FS_PATH_TOO_LONG)) return 'path-too-long';
  return 'other';
}

/** True if a save `CommandResult.error` carries the permission marker. */
export function isPermissionError(error?: string | null): boolean {
  return classifySaveError(error) === 'permission';
}

/** True if the destination itself is what failed, rather than the write. */
export function isPathError(error?: string | null): boolean {
  const kind = classifySaveError(error);
  return kind === 'path-not-found' || kind === 'path-too-long';
}
