import { useTranslation } from 'react-i18next';
import { useSpeleoActions } from '../../hooks/useSpeleoActions';
import { useSpeleoStore } from '../../store/speleoStore';
import { useUIStore } from '../../store/uiStore';
import { canResumeSpeleoEditing } from '../../utils/speleoPermission';
import { PencilIcon } from '../common/icons';

const RESUME_CLS =
  'ml-1 inline-flex items-center gap-1 rounded bg-accent px-2 py-0.5 font-medium text-accent-on hover:bg-accent-90 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent';

/**
 * "Resume editing" on the SpeleoDB read-only pill: takes the write lock again
 * through the same start-editing flow as the SpeleoDB tab, with its error
 * handling (someone else editing, no permission, divergence). Rendered only when
 * it can apply - signed in, with project access and write permission - which is
 * the same rule the tab's Resume editing uses.
 */
export function SpeleoResumeEditingButton() {
  const { t } = useTranslation();
  const link = useSpeleoStore((s) => s.link);
  const session = useSpeleoStore((s) => s.session);
  const { busy, startEditing } = useSpeleoActions();
  if (!canResumeSpeleoEditing(link, session)) return null;
  return (
    <button type="button" className={RESUME_CLS} disabled={busy}
      onClick={() => void startEditing()}
      title={t('map.readOnlyPill.resumeSpeleoTitle')}
      data-testid="speleodb-readonly-resume">
      <PencilIcon size={12} />
      {t('map.readOnlyPill.resume')}
    </button>
  );
}

/**
 * "Resume editing" on the Closures Computed View pill: back to the Raw Data View,
 * the same geometry-mode write the Display menu's toggle makes. The pill itself
 * is shown only where that applies (Survey, no other read-only cause).
 */
export function RawDataResumeButton() {
  const { t } = useTranslation();
  return (
    <button type="button" className={RESUME_CLS}
      onClick={() => useUIStore.getState().setGeometryMode('measured', 'map')}
      title={t('map.readOnlyPill.resumeRawTitle')}
      data-testid="geometry-readonly-resume">
      <PencilIcon size={12} />
      {t('map.readOnlyPill.resume')}
    </button>
  );
}
