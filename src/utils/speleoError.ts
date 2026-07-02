import type { SpeleoDbAction, SpeleoErrorDto } from '../types/ipc.generated';
import { getErrorMessage } from './ipc';

/**
 * A SpeleoDB IPC rejection that is a network/timeout transport error, whose
 * message is already self-framed ("Network error talking to SpeleoDB: …") so the
 * humanizer must NOT prepend an operation prefix on top of it.
 *
 * Detected STRUCTURALLY from the typed DTO, not by string-matching the backend's
 * Display text (which silently breaks whenever that wording changes - fix S5):
 * `dto_for_error` maps `SpeleoDbError::Transport` to `action: 'Retry'` with
 * `status: null`, whereas a retryable 5xx (also `Retry`) carries its HTTP `status`.
 * See `src-tauri/src/speleodb/contract.rs`.
 */
function isTransportError(e: unknown): boolean {
  if (e && typeof e === 'object' && 'action' in e && 'status' in e) {
    const dto = e as Partial<SpeleoErrorDto>;
    return dto.action === 'Retry' && (dto.status === null || dto.status === undefined);
  }
  return false;
}

/**
 * Turn a rejected SpeleoDB IPC error into a single user-facing line.
 *
 * The backend already provides a clean detail (auth failures parse
 * `non_field_errors`; transport strips `io:`/`(os error N)`). This adds the
 * operation frame the backend can't know - e.g. `Login to SpeleoDB failed: …`,
 * `Unable to open the project: …` - except on transport errors, which are
 * returned verbatim so they don't read as "Login failed: Network error…".
 */
export function humanizeSpeleoError(e: unknown, contextPrefix?: string): string {
  // Strip a trailing period so "…credentials." reads cleanly after our prefix.
  const msg = getErrorMessage(e).replace(/\.\s*$/, '');
  if (!contextPrefix || isTransportError(e)) return msg;
  return `${contextPrefix}: ${msg}`;
}

/**
 * Extract the typed {@link SpeleoDbAction} from a rejected SpeleoDB IPC call.
 *
 * The `speleodb_*` commands reject with a {@link SpeleoErrorDto} (`{ message,
 * action, status? }`), so the UI can branch on `action` (ReLogin / ReadOnly /
 * Fence / …) instead of scraping the display message. Returns `null` for a
 * non-DTO rejection (a plain string / Error), so callers fall back to a generic
 * message via `getErrorMessage`.
 */
export function speleoErrorAction(e: unknown): SpeleoDbAction | null {
  if (e && typeof e === 'object' && 'action' in e) {
    const action = (e as Partial<SpeleoErrorDto>).action;
    return typeof action === 'string' ? (action as SpeleoDbAction) : null;
  }
  return null;
}
