import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Toggle } from '../../common/Toggle';
import { useProjectStore } from '../../../store/projectStore';
import { useUIStore } from '../../../store/uiStore';
import type { Project } from '../../../types/project';

/** Derive `<stem>.tml` from a project's `.stalx` path for display. */
export function deriveSiblingName(filePath: string | null | undefined): string | null {
  if (!filePath) return null;
  const base = filePath.replace(/^.*[\\/]/, '');
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return `${stem}.tml`;
}

/**
 * Per-project Ariane collaboration toggle (#57): keeps a sibling Ariane `.tml`
 * next to the `.stalx` and reconciles external Ariane edits on open. Lives in
 * the Project Settings dialog (Experimental tab) since it is project-scoped.
 */
export function CollaborationSection({ project }: { project: Project }) {
  const { t } = useTranslation();
  const setCollabEnabled = useProjectStore((s) => s.setCollabEnabled);
  const showToast = useUIStore((s) => s.showToast);
  const [busy, setBusy] = useState(false);

  const enabled = project.collab?.enabled ?? false;
  const siblingName = project.collab?.sibling_tml_relative ?? deriveSiblingName(project.file_path);

  const handleToggle = async (next: boolean) => {
    setBusy(true);
    try {
      const result = await setCollabEnabled(next);
      if (!result.success) {
        showToast(
          result.error ?? t('detailPanel.collaboration.toggleFailed', 'Failed to change collaboration mode'),
          'collab-toggle',
        );
      }
    } catch (e) {
      showToast(String(e), 'collab-toggle');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2" data-testid="collaboration-section">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-sm text-text-primary">
            {t('detailPanel.collaboration.enable', 'Ariane collaboration')}
          </div>
          <div className="text-xs text-text-secondary mt-0.5">
            {t(
              'detailPanel.collaboration.help',
              'Saves a companion Ariane file (.tml) on every save and merges external Ariane edits when you reopen the project.',
            )}
          </div>
        </div>
        <Toggle
          checked={enabled}
          onChange={handleToggle}
          disabled={busy}
          aria-label={t('detailPanel.collaboration.aria', 'Toggle Ariane collaboration mode')}
          data-testid="toggle-collaboration"
        />
      </div>
      {enabled && siblingName && (
        <div className="text-xs text-text-tertiary" data-testid="collaboration-sibling-path">
          {t('detailPanel.collaboration.companion', 'Companion file')}: <code className="break-all">{siblingName}</code>
        </div>
      )}
    </div>
  );
}
