import { useSpeleoStore } from '../../store/speleoStore';
import { useUIStore } from '../../store/uiStore';

/** Critical access state remains visible when the workspace is hidden. */
export function SpeleoAccessNotice() {
  const link = useSpeleoStore((s) => s.link);
  const loggedIn = useSpeleoStore((s) => s.session?.loggedIn);
  const open = useUIStore((s) => s.openSpeleoWorkspace);
  if (!link || link.editState === 'editing') return null;
  return <div role="status" className="flex items-center justify-between gap-3 px-4 py-2 bg-warning-20 text-sm border-b border-border" data-testid="speleodb-access-notice">
    <span>{link.noAccess ? 'Read-only - project access is unavailable.' : link.lockHolder ? `Read-only - editing lock held by ${link.lockHolder}.` : 'Read-only - an editing lock is required.'}</span>
    <button type="button" onClick={() => !loggedIn ? useUIStore.getState().openDialog('settings', { initialCategory: 'speleodb' }) : open()} className="underline shrink-0" data-testid="speleodb-access-open-workspace">Open SpeleoDB</button>
  </div>;
}
