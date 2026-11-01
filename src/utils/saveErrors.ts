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

/**
 * Marker for a save refused because the project's ignore list could not be read
 * (#517) - saving would have rebuilt the file without it. Mirrors
 * `IGNORES_UNREADABLE_CODE` in `src-tauri/crates/core/src/core/loading.rs`.
 *
 * Unlike the `FS_*` markers this one exists for ROUTING, not wording: an
 * unmarked failure is sent to Review & Repair whenever `integritySaveBlocked` is
 * set, and Review & Repair repairs cross-references, not a broken
 * `resolved_warnings` table - so without the marker this refusal reaches no
 * surface at all on a project that has both problems.
 */
export const IGNORES_UNREADABLE = 'IGNORES_UNREADABLE';

/**
 * Markers for a save refused because another side table the save has to carry
 * could not be read from the open file (#576 A3-D2: these stop the save rather
 * than rebuild the file without them): the SpeleoDB link, and the SpeleoDB
 * undo-history markers. Mirror `SPELEODB_LINK_UNREADABLE_CODE` /
 * `UNDO_MARKERS_UNREADABLE_CODE` in `src-tauri/crates/core/src/core/loading.rs`.
 * Routed exactly like `IGNORES_UNREADABLE`: Review & Repair cannot fix either.
 */
export const SPELEODB_LINK_UNREADABLE = 'SPELEODB_LINK_UNREADABLE';
export const UNDO_MARKERS_UNREADABLE = 'UNDO_MARKERS_UNREADABLE';

const SIDE_TABLE_UNREADABLE_MARKERS = [SPELEODB_LINK_UNREADABLE, UNDO_MARKERS_UNREADABLE];

/**
 * Marker for a refusal because the open project was saved by a NEWER Stalagmight
 * and is open read-only (#576 B6-D1). Mirrors `NEWER_FILE_READ_ONLY_CODE` in
 * `src-tauri/crates/core/src/core/loading.rs`. It LEADS a refused save, and rides
 * behind `EDIT_DISABLED` on a refused edit (see `editErrors.ts`).
 *
 * Routing again: a refused save is a read-only notice, never an error dialog and
 * never Review & Repair - nothing there can make this build write the file.
 */
export const NEWER_FILE_READ_ONLY = 'NEWER_FILE_READ_ONLY';

/**
 * Marker for a refusal because stored per-project settings could not be read when
 * the project was opened (#576 B15): the session holds defaults in their place,
 * and any save would write those over the stored values. Mirrors
 * `PROJECT_SETTINGS_UNREADABLE_CODE` in `src-tauri/crates/core/src/core/loading.rs`.
 * Routed like `NEWER_FILE_READ_ONLY`: a blocked save on a project whose banner
 * already says why.
 */
export const PROJECT_SETTINGS_UNREADABLE = 'PROJECT_SETTINGS_UNREADABLE';

/** What a failed save's `CommandResult.error` says went wrong. */
export type SaveErrorKind =
  | 'permission'
  | 'path-not-found'
  | 'path-too-long'
  | 'ignores-unreadable'
  | 'side-table-unreadable'
  | 'newer-file'
  | 'settings-unreadable'
  | 'other';

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
  if (error.startsWith(IGNORES_UNREADABLE)) return 'ignores-unreadable';
  if (SIDE_TABLE_UNREADABLE_MARKERS.some((m) => error.startsWith(m))) return 'side-table-unreadable';
  if (error.startsWith(NEWER_FILE_READ_ONLY)) return 'newer-file';
  if (error.startsWith(PROJECT_SETTINGS_UNREADABLE)) return 'settings-unreadable';
  return 'other';
}

/**
 * A refusal whose cause is a side table the open file could not give up (#517,
 * #576 A3-D2). Its message is already a full sentence, and Review & Repair -
 * which repairs cross-references - cannot fix it.
 */
export function isUnreadableRefusal(kind: SaveErrorKind | null | undefined): boolean {
  return kind === 'ignores-unreadable' || kind === 'side-table-unreadable';
}

/** The backend's sentence for an unreadable-side-table refusal, its marker removed. */
export function unreadableRefusalMessage(error: string): string {
  return [IGNORES_UNREADABLE, ...SIDE_TABLE_UNREADABLE_MARKERS].reduce(
    (message, marker) => stripSaveErrorMarker(message, marker),
    error,
  );
}

/**
 * The backend's own sentence, with its routing marker taken off the front. Used
 * for the markers whose message is already user-ready (unlike the `FS_*` ones,
 * which are reworded) - the marker itself must never reach a surface.
 */
export function stripSaveErrorMarker(error: string, marker: string): string {
  return error.startsWith(marker) ? error.slice(marker.length).replace(/^:\s*/, '') : error;
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
