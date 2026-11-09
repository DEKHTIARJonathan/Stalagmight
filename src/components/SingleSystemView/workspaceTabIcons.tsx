import { useProjectStore } from '../../store/projectStore';
import { isUnwoundNotEdited, useSpeleoStore } from '../../store/speleoStore';
import { LockIcon, SectionsIcon } from '../common/icons';
import { ExclamationGlyph, SpeleoBadgedIcon } from '../common/SpeleoBadgedIcon';

/**
 * What the SpeleoDB tab has to tell at a glance about the open project:
 * - `unuploaded`: changes SpeleoDB does not have yet - unsaved edits, or saved
 *   ones not uploaded. Not raised for a copy that is only stepped back to an
 *   older version without edits (#303): uploading that would publish a revert.
 * - `read-only`: no write lock held.
 * - `normal`: neither (or a local project, which has no SpeleoDB state).
 * Un-uploaded work outranks read-only: it is the state that can lose work.
 */
export type SpeleoTabState = 'unuploaded' | 'read-only' | 'normal';

export function useSpeleoTabState(): SpeleoTabState {
  const link = useSpeleoStore((s) => s.link);
  const isDirty = useProjectStore((s) => s.isDirty);
  if (!link) return 'normal';
  if (isDirty || (link.hasUnpushedEdits && !isUnwoundNotEdited(link))) return 'unuploaded';
  return link.editState === 'editing' ? 'normal' : 'read-only';
}

const ICON_SIZE = 16;

export function SectionsTabIcon() {
  return <SectionsIcon size={ICON_SIZE} data-testid="workspace-tab-sections-icon" />;
}

/** The SpeleoDB mark, badged with a yellow "!" (un-uploaded) or a lock (read-only). */
export function SpeleoTabIcon({ state }: { state: SpeleoTabState }) {
  return (
    <span className="inline-flex" data-testid="workspace-tab-speleodb-icon" data-state={state}>
      <SpeleoBadgedIcon
        size={ICON_SIZE}
        testIdPrefix="workspace-tab-speleodb-icon"
        badge={state === 'unuploaded' ? <ExclamationGlyph size={10} />
          : state === 'read-only' ? <LockIcon size={10} /> : undefined}
        badgeColor={state === 'unuploaded' ? 'text-warning-text' : 'text-text-primary'}
      />
    </span>
  );
}
