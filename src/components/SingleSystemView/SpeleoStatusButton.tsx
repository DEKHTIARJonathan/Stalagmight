import { useTranslation } from 'react-i18next';
import { useSpeleoStore, isUnwoundNotEdited } from '../../store/speleoStore';
import { useUIStore } from '../../store/uiStore';
import { SpeleoDbLogo } from '../common/SpeleoDbLogo';
import { UNPUSHED_ACCENT } from '../../utils/speleoLocalState';

/** Navigation remains available when signed out, offline, read-only or busy. */
export function SpeleoStatusButton() {
  const { t } = useTranslation();
  const link = useSpeleoStore((s) => s.link);
  const openWorkspace = useUIStore((s) => s.openSpeleoWorkspace);
  if (!link) return null;
  const unpushed = link.hasUnpushedEdits && !isUnwoundNotEdited(link);
  return (
    <button
      type="button"
      onClick={() => openWorkspace()}
      title={unpushed ? t('speleodb.localEdits.titleSuffix') : 'SpeleoDB'}
      aria-label="SpeleoDB"
      data-testid="speleodb-status-button"
      data-unpushed={unpushed ? 'true' : 'false'}
      className="flex shrink-0 items-center gap-1.5 h-8 px-2 rounded ml-1 hover:bg-accent-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent whitespace-nowrap"
    >
      <SpeleoDbLogo size={22} testId="speleodb-status-icon" />
      <span>SpeleoDB</span>
      {unpushed && <span style={{ color: UNPUSHED_ACCENT }} data-testid="speleodb-status-unpushed-badge" aria-hidden="true">!</span>}
    </button>
  );
}
