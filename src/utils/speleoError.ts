import type { SpeleoDbAction, SpeleoErrorDto } from '../types/ipc.generated';

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
