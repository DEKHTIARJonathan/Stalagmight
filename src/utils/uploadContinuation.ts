import { useProjectStore } from '../store/projectStore';
import { useSpeleoStore } from '../store/speleoStore';
import { endpointsMatch } from './speleoEndpoint';

interface UploadAccount { endpoint: string; email: string }
export interface UploadOwner { path: string | null; epoch: number; account: UploadAccount | null }
interface UploadDraft { path: string; message: string; closeAfterSave: boolean }
let continuation: (UploadDraft & { owner: UploadOwner }) | null = null;
let projectEpoch = 0;
let subscribed = false;

function currentAccount(): UploadAccount | null {
  const session = useSpeleoStore.getState().session;
  return session?.loggedIn && session.endpoint && session.userEmail
    ? { endpoint: session.endpoint, email: session.userEmail.trim().toLowerCase() }
    : null;
}

/** Subscribe lazily: stores import this module while their own initialization runs. */
function observeProjectLifetime(): void {
  if (subscribed) return;
  subscribed = true;
  useProjectStore.subscribe((next, previous) => {
    if (!!next.project !== !!previous.project ||
        next.project?.file_path !== previous.project?.file_path ||
        next.project?.created_at !== previous.project?.created_at) {
      projectEpoch += 1;
      continuation = null;
    }
  });
  useSpeleoStore.subscribe(() => {
    if (continuation && !uploadOwnerStillCurrent(continuation.owner)) continuation = null;
  });
}

export function captureUploadOwner(): UploadOwner {
  observeProjectLifetime();
  return { path: useProjectStore.getState().project?.file_path ?? null, epoch: projectEpoch, account: currentAccount() };
}

/** Reauthentication may recover the same account, but never retarget a draft. */
export function uploadOwnerStillCurrent(owner: UploadOwner): boolean {
  observeProjectLifetime();
  if (!useProjectStore.getState().project || owner.epoch !== projectEpoch ||
      owner.path !== (useProjectStore.getState().project?.file_path ?? null)) return false;
  const account = currentAccount();
  if (!account) return true;
  if (!owner.account) { owner.account = account; return true; }
  return owner.account.email === account.email && endpointsMatch(owner.account.endpoint, account.endpoint);
}

/** Recovery may replace the upload dialog. Reopening still requires confirmation. */
export function getUploadContinuation(path: string | null | undefined) {
  observeProjectLifetime();
  if (continuation && (continuation.path !== path || !uploadOwnerStillCurrent(continuation.owner))) continuation = null;
  return continuation;
}
export function setUploadContinuation(value: UploadDraft | null, owner = captureUploadOwner()): void {
  continuation = value && value.path === owner.path && uploadOwnerStillCurrent(owner) ? { ...value, owner } : null;
}
