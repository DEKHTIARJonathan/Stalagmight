import { captureUploadOwner, uploadOwnerStillCurrent, type UploadOwner } from './uploadContinuation';

export interface PublishDraft { description: string; country: string; latitude: string; longitude: string }
let pending: { draft: PublishDraft; owner: UploadOwner } | null = null;

/** Keep a creation form through Settings, bound to its original project/account. */
export function setPublishContinuation(draft: PublishDraft | null, owner = captureUploadOwner()): void {
  pending = draft && uploadOwnerStillCurrent(owner) ? { draft, owner } : null;
}
export function getPublishContinuation(): PublishDraft | null {
  if (pending && !uploadOwnerStillCurrent(pending.owner)) pending = null;
  return pending?.draft ?? null;
}
