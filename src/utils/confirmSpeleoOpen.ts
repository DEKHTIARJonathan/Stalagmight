import { invokeIpc } from './ipc';
import type { SpeleoFileAccess, SpeleoProjectSummary } from '../types/ipc.generated';

/** Access is reported after the actual lock attempt, not from stale listing metadata. */
export async function confirmSpeleoOpen(_summary: SpeleoProjectSummary, _endpoint?: string, _unavailable = false): Promise<boolean> {
  return true;
}

/** Keep the disk preflight and request ownership check; opening read-only needs no advance confirmation. */
export async function confirmSpeleoFileOpen(path: string, current: () => boolean = () => true, localOnly = false): Promise<boolean> {
  await invokeIpc<SpeleoFileAccess | null>('speleodb_project_access_at', localOnly ? { path, localOnly: true } : { path });
  return current();
}
