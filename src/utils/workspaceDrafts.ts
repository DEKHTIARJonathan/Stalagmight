/**
 * Unsent SpeleoDB input ("workspace drafts"): what the user typed into a SpeleoDB
 * form that has not been sent yet - the description of an upload, the conversion
 * (publish) form - including a draft parked while Settings is open for sign-in.
 *
 * Each draft registers itself where it lives (`uploadContinuation`,
 * `publishContinuation`, the publish dialog). Every way out that would drop one -
 * close, switch, quit, and a sign-in or account switch that the draft cannot
 * follow - asks {@link confirmWorkspaceDrafts} FIRST, before the SpeleoDB exit
 * prompt, the sign-out guard or the unsaved-changes question, so nothing
 * irreversible (an upload, a lock hand-back, a close) has happened when the user
 * cancels. The question is the shared in-app exit confirm (`utils/exitConfirm`),
 * never a native dialog. Once confirmed the drafts are discarded, so the later
 * store-level checks (`loadProject`, `createProject`, `closeProject`) find none
 * and do not ask again.
 */
import i18n from '../i18n';
import { askExitConfirm } from './exitConfirm';

/**
 * The account a sign-in or sign-out moves to. `email: null` is a sign-in whose
 * account is not known yet (a pasted token resolves it on the server).
 */
export type AccountTarget =
  | { signedOut: true }
  | { signedOut?: false; email: string | null; endpoint: string | null };

export interface WorkspaceDraft {
  /** What the draft is, as it reads in the question's list. */
  label: () => string;
  /**
   * Holds unsent input. With an `account` it answers the narrower question
   * "does moving to this account drop it": a draft stays bound to the account it
   * was written for, so a sign-out keeps it and a different account drops it.
   */
  dirty: (account?: AccountTarget) => boolean;
  /** Drop the input (and close the form it lives in, if open). */
  discard: () => void;
}

const drafts = new Map<symbol, WorkspaceDraft>();

/** Register a draft; the returned function unregisters it. */
export function registerWorkspaceDraft(draft: WorkspaceDraft): () => void {
  const id = Symbol('workspace-draft');
  drafts.set(id, draft);
  return () => { drafts.delete(id); };
}

function pendingDrafts(account?: AccountTarget): WorkspaceDraft[] {
  return [...drafts.values()].filter((draft) => draft.dirty(account));
}

export function hasWorkspaceDrafts(account?: AccountTarget): boolean {
  return pendingDrafts(account).length > 0;
}

export function discardWorkspaceDrafts(): void {
  for (const draft of pendingDrafts()) draft.discard();
}

/**
 * Ask, in-app, whether to discard the unsent SpeleoDB input this way out would
 * drop. `true` = nothing to lose, or the user discarded it; `false` = cancelled
 * (or the flow stopped being current while asking), nothing discarded.
 */
export async function confirmWorkspaceDrafts(
  isCurrent: () => boolean = () => true,
  account?: AccountTarget,
): Promise<boolean> {
  if (!isCurrent()) return false;
  const pending = pendingDrafts(account);
  if (!pending.length) return true;
  const items = [...new Set(pending.map((draft) => draft.label()))].join(', ');
  const discard = await askExitConfirm({
    title: i18n.t('speleoExitPrompt.drafts.title'),
    message: i18n.t('speleoExitPrompt.drafts.message', { items }),
    confirmLabel: i18n.t('speleoExitPrompt.drafts.confirm'),
    cancelLabel: i18n.t('common.actions.cancel'),
  });
  if (!discard || !isCurrent()) return false;
  for (const draft of pending) draft.discard();
  return true;
}
