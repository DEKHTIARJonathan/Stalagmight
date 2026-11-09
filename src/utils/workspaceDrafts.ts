import { confirm } from '@tauri-apps/plugin-dialog';

interface Draft { dirty: () => boolean; discard: () => void }
const drafts = new Map<symbol, Draft>();

/** Draft dirtiness is independent of validation and survives hidden panels. */
export function registerWorkspaceDraft(draft: Draft): () => void {
  const id = Symbol('workspace-draft');
  drafts.set(id, draft);
  return () => { drafts.delete(id); };
}

export function hasWorkspaceDrafts(): boolean { return [...drafts.values()].some((draft) => draft.dirty()); }

export function discardWorkspaceDrafts(): void {
  for (const draft of drafts.values()) if (draft.dirty()) draft.discard();
}

export async function confirmWorkspaceDrafts(isCurrent: () => boolean = () => true): Promise<boolean> {
  if (!isCurrent()) return false;
  const pending = [...drafts.values()].filter((draft) => draft.dirty());
  if (!pending.length) return true;
  const discard = await confirm('Discard unsaved SpeleoDB form changes?', {
    kind: 'warning', okLabel: 'Discard changes', cancelLabel: 'Cancel',
  });
  if (!discard || !isCurrent()) return false;
  for (const draft of pending) draft.discard();
  return true;
}
