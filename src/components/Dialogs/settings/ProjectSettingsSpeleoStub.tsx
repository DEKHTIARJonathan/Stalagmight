import { useTranslation } from 'react-i18next';
import { SettingsSection } from './SettingsSection';
import { Button } from '../../common/Button';
import { useUIStore } from '../../../store/uiStore';

/**
 * The SpeleoDB tab of the local Project Settings dialog: a pointer, not a panel.
 * The server-side administration it used to host now has its own dialog, because
 * none of it is stored in the .stalx this dialog edits.
 */
export function ProjectSettingsSpeleoStub() {
  const { t } = useTranslation();
  const openDialog = useUIStore((s) => s.openDialog);

  return (
    <SettingsSection
      title={t('speleodb.projectDialog.title')}
      data-testid="project-settings-speleodb-stub"
    >
      <p className="text-sm text-text-primary">{t('speleodb.projectDialog.stub.note')}</p>
      <p className="text-xs text-text-secondary pb-2">{t('speleodb.projectDialog.stub.detail')}</p>
      <Button
        variant="secondary"
        // `activeDialog` is a single slot (uiStore.ts:586), so this REPLACES Project
        // Settings rather than stacking on it: any staged, unsaved edit here is
        // dropped exactly as pressing Cancel would drop it. The Restore button in the
        // revision history already leaves by the same door.
        onClick={() => openDialog('speleodb-project')}
        data-testid="project-settings-open-speleodb"
      >
        {t('speleodb.projectDialog.stub.open')}
      </Button>
    </SettingsSection>
  );
}
