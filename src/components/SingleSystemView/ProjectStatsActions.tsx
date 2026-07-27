import { useTranslation } from 'react-i18next';
import { useUIStore } from '../../store/uiStore';
import { useSpeleoStore } from '../../store/speleoStore';
import { useSpeleoWebLink } from '../../hooks/useSpeleoWebLink';

const actionClass =
  'w-full text-center text-sm px-2 py-1 rounded bg-background-50 hover:bg-background text-text-primary disabled:opacity-50 disabled:cursor-not-allowed';

/**
 * The action buttons at the foot of the project stats panel: the local per-project
 * settings, plus - for a project linked to SpeleoDB - its server-side administration
 * and a jump to the same project on the web.
 */
export function ProjectStatsActions() {
  const { t } = useTranslation();
  const openDialog = useUIStore((s) => s.openDialog);
  // Select the BOOLEAN, not the link object: `seedFromStatus` allocates a fresh
  // link on every status-poll tick, so a selector returning the object re-renders
  // this component (and re-runs `useSpeleoWebLink`) on every tick even though the
  // only thing read is whether a link exists. Same fix, same reason, as
  // `useSpeleoMenuItems`.
  const isRemote = useSpeleoStore((s) => s.link !== null);
  const web = useSpeleoWebLink();

  return (
    <div className="pt-2 border-t border-border">
      <button
        onClick={() => openDialog('project-settings')}
        className={actionClass}
        data-testid="open-project-settings"
      >
        {t('detailPanel.projectSettings.open')}
      </button>
      {isRemote && (
        <div className="mt-1 space-y-1">
          <button
            onClick={() => openDialog('speleodb-project')}
            className={actionClass}
            data-testid="open-speleodb-settings"
          >
            {t('speleodb.projectDialog.open')}
          </button>
          <button
            onClick={web.open}
            disabled={web.url === null}
            title={web.url === null ? t('speleodb.web.unavailable') : undefined}
            className={actionClass}
            data-testid="open-speleodb-web"
          >
            {t('speleodb.web.openProject')}
          </button>
        </div>
      )}
    </div>
  );
}
