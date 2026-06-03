/**
 * Marker the backend uses to flag a filesystem permission denial (e.g. macOS
 * forgot folder access after an OS/app update). Mirrors `PERMISSION_DENIED_CODE`
 * in `src-tauri/src/core/loading.rs`:
 * - save path: prefixed onto `CommandResult.error`
 * - open path: surfaced as `LoadError.code === 'PERMISSION'`
 */
export const FS_PERMISSION_DENIED = 'FS_PERMISSION_DENIED';

/** True if a save `CommandResult.error` carries the permission marker. */
export function isPermissionError(error?: string | null): boolean {
  return !!error && error.startsWith(FS_PERMISSION_DENIED);
}
