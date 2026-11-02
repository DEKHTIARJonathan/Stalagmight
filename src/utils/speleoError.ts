import type {
  SpeleoDbAction,
  SpeleoDumpCandidate,
  SpeleoErrorDto,
  TransportCause,
  UnpushedLocalEdits,
} from '../types/ipc.generated';
import i18n from '../i18n';
import type { DumpPickerKind } from '../store/speleoStore';
import { useSpeleoStore } from '../store/speleoStore';
import { isEditDisabledError, READ_ONLY_EDIT_NOTICE } from './editErrors';
import { classifySaveError } from './saveErrors';
import { autosaveFailureMessage } from './saveFeedback';
import { getErrorMessage } from './ipc';

/**
 * The typed transport cause of a rejected SpeleoDB IPC call, or `null` when the
 * rejection is not a transport failure.
 *
 * Read STRUCTURALLY off the DTO's `transport` discriminant, which the backend
 * sets only for `SpeleoDbError::Transport` (see `src-tauri/src/speleodb/
 * contract.rs`). Never sniffed from the message text: that text is the backend's
 * raw cause (an OS errno such as "Invalid argument"), which is locale- and
 * platform-dependent.
 */
function transportCause(e: unknown): TransportCause | null {
  if (e && typeof e === 'object' && 'transport' in e) {
    const cause = (e as Partial<SpeleoErrorDto>).transport;
    return typeof cause === 'string' ? (cause as TransportCause) : null;
  }
  return null;
}

const TRANSPORT_KEYS: Record<TransportCause, string> = {
  Refused: 'speleodb.transport.refused',
  Timeout: 'speleodb.transport.timeout',
  Dns: 'speleodb.transport.dns',
  Tls: 'speleodb.transport.tls',
  Unknown: 'speleodb.transport.unreachable',
};

/**
 * [#270] The user-facing line for a transport failure.
 *
 * The backend's own text was passed straight through, so a blackholed host read
 * "Network error talking to SpeleoDB: Invalid argument" - a bare errno that says
 * neither what failed nor what to do, and does not even hint the server was
 * unreachable. The message is built here instead: translatable, cause-specific,
 * and naming the server we are actually signed in to (self-hosted users need to
 * know WHICH box). The raw cause is not dropped - it stays on the error and in
 * the backend log (`client::with_retry` warns with the cause + endpoint), which
 * is what makes a bug report actionable.
 */
function transportMessage(cause: TransportCause): string {
  // The session endpoint is where we are actually authenticated (the config value
  // only affects future logins), so it is the honest answer to "which server?".
  const endpoint =
    useSpeleoStore.getState().session?.endpoint?.trim() || i18n.t('speleodb.transport.thisServer');
  return i18n.t(TRANSPORT_KEYS[cause], { endpoint });
}

/**
 * Turn a rejected SpeleoDB IPC error into a single user-facing line.
 *
 * The backend already provides a clean detail (auth failures parse
 * `non_field_errors`). This adds the operation frame the backend can't know -
 * e.g. `Login to SpeleoDB failed: …`, `Unable to open the project: …` - except on
 * transport errors, which are replaced wholesale by the humanized #270 line (it
 * is already self-framed and would otherwise read as "Login failed: Network
 * error…").
 */
export function humanizeSpeleoError(e: unknown, contextPrefix?: string): string {
  const cause = transportCause(e);
  if (cause) return transportMessage(cause);
  const raw = getErrorMessage(e);
  // [#576 RV2-R-15] An edit-gate refusal (e.g. Restore revision / Unwind in the
  // read-only Plan or Export workspace) carries the backend's coded markers; a marker
  // must never reach a surface, so it gets the same notice a refused edit gets.
  if (isEditDisabledError(raw)) return READ_ONLY_EDIT_NOTICE(raw);
  // [#576 NF-W2SAVE-1] A Done/Push whose pre-push save refused carries the save's
  // own reason, routing marker included: worded like any refused save's line.
  const saved = classifySaveError(raw) === 'other' ? raw : autosaveFailureMessage(raw);
  // Strip a trailing period so "…credentials." reads cleanly after our prefix.
  const msg = saved.replace(/\.\s*$/, '');
  if (!contextPrefix) return msg;
  return `${contextPrefix}: ${msg}`;
}

/**
 * Extract the typed {@link SpeleoDbAction} from a rejected SpeleoDB IPC call.
 *
 * The `speleodb_*` commands reject with a {@link SpeleoErrorDto} (`{ message,
 * action, status?, transport? }`), so the UI can branch on `action` (ReLogin /
 * ReadOnly / Fence / …) instead of scraping the display message. Returns `null`
 * for a non-DTO rejection (a plain string / Error), so callers fall back to a
 * generic message via `getErrorMessage`.
 */
export function speleoErrorAction(e: unknown): SpeleoDbAction | null {
  if (e && typeof e === 'object' && 'action' in e) {
    const action = (e as Partial<SpeleoErrorDto>).action;
    return typeof action === 'string' ? (action as SpeleoDbAction) : null;
  }
  return null;
}

/**
 * [#270] The un-pushed local edits an open was refused over, or `null`.
 *
 * `speleodb_open_project` refuses rather than overwrite a cached `.stalx` that
 * still holds edits the server has never seen; the refusal carries the project
 * id, the local path and when it was last edited so the UI can name exactly what
 * is at stake. Read structurally off the DTO (never sniffed from the message),
 * and only trusted when the payload is actually shaped like the record - a
 * refusal we cannot describe must fall back to the generic error path rather
 * than raise a prompt with blanks in it.
 */
export function unpushedLocalEdits(e: unknown): UnpushedLocalEdits | null {
  if (speleoErrorAction(e) !== 'UnpushedLocalEdits') return null;
  const payload = (e as Partial<SpeleoErrorDto>).unpushed_local;
  if (!payload || typeof payload !== 'object') return null;
  const { project_id, local_path } = payload;
  if (typeof project_id !== 'string' || typeof local_path !== 'string' || !local_path) return null;
  return payload;
}

/**
 * [#258] The openable files an ambiguous dump offered, or `null`.
 *
 * A dump holding more than one `.stalx` (or, with no `.stalx`, more than one
 * `ariane.tml`) is a question rather than a failure: the backend rejects with
 * `action === 'Ambiguous'` and attaches the candidates so the UI can offer a
 * choice instead of a dead end.
 *
 * Validated structurally, like `unpushedLocalEdits`, and for the same reason: a
 * list we cannot render must fall through to the generic error path, whose
 * message names the remedy, rather than raise an empty picker. Note the
 * fast-forward verbs (Start editing / Update / Take remote) carry no way to send
 * a choice back, so they legitimately produce this action with nothing to act on
 * - the empty check below is what routes those to the message.
 */
export function dumpCandidates(e: unknown): SpeleoDumpCandidate[] | null {
  if (speleoErrorAction(e) !== 'Ambiguous') return null;
  const payload = (e as Partial<SpeleoErrorDto>).dump_candidates;
  if (!Array.isArray(payload) || payload.length === 0) return null;
  const usable = payload.every(
    (c) => c && typeof c === 'object' && typeof c.entry_path === 'string' && c.entry_path !== '',
  );
  return usable ? payload : null;
}

/**
 * [#258] Which ambiguity `dumpCandidates` returned, defaulting to `'stalx'`.
 *
 * Read off the DTO rather than inferred from the candidates' extensions: which
 * kind a set is, is the backend classifier's decision, and re-deriving it here
 * would be a second copy of that rule with nothing keeping the two in step. The
 * kind picks the VERB - extract this `.stalx` versus adopt this `ariane.tml` are
 * different operations - so it is not merely cosmetic.
 *
 * Defaults to `'stalx'` for an older backend that sends no kind, which is the
 * commoner ambiguity and the one whose flow works without adoption.
 */
export function dumpCandidateKind(e: unknown): DumpPickerKind {
  return (e as Partial<SpeleoErrorDto>).dump_candidate_kind === 'ariane' ? 'ariane' : 'stalx';
}
