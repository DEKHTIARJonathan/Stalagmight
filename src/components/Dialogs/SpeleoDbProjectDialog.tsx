import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DialogWrapper } from './DialogWrapper';
import { SpeleoDbGeneralTab } from './settings/SpeleoDbGeneralTab';
import { SpeleoCollaboratorsTab } from './settings/SpeleoCollaboratorsTab';
import { SpeleoAdminTab } from './settings/SpeleoAdminTab';
import { SpeleoRevisionHistory } from './settings/SpeleoRevisionHistory';
import { Button } from '../common/Button';
import { useUIStore } from '../../store/uiStore';
import { useSpeleoStore } from '../../store/speleoStore';
import { useSpeleoProjectMetadata } from '../../hooks/useSpeleoProjectMetadata';

type SpeleoProjectTab = 'general' | 'collaborators' | 'history' | 'admin';
const TABS: readonly SpeleoProjectTab[] = ['general', 'collaborators', 'history', 'admin'];

function isTab(value: unknown): value is SpeleoProjectTab {
  return typeof value === 'string' && (TABS as readonly string[]).includes(value);
}

/**
 * Server-side administration of the open remote project: its SpeleoDB details,
 * collaborators, revision history and the admin/danger actions.
 *
 * Split out of the local Project Settings dialog, where all of this used to sit
 * behind one "SpeleoDB" tab: none of it is stored in the .stalx, none of it honors
 * that dialog's Save/Cancel, and most of it takes effect on the server the moment
 * it is clicked.
 */
export function SpeleoDbProjectDialog() {
  const { t } = useTranslation();
  const closeDialog = useUIStore((s) => s.closeDialog);
  const initialTab = useUIStore((s) => s.dialogData.tab);
  // A project can unlink from another surface while this sits open (the delete flow
  // closes the dialog itself), which leaves every tab with nothing to administer.
  const isRemote = useSpeleoStore((s) => s.link) !== null;
  const metadata = useSpeleoProjectMetadata();

  const [tab, setTab] = useState<SpeleoProjectTab>(isTab(initialTab) ? initialTab : 'general');

  const panelIdBase = useId();
  const tabId = (tk: SpeleoProjectTab) => `${panelIdBase}-tab-${tk}`;
  const panelId = (tk: SpeleoProjectTab) => `${panelIdBase}-panel-${tk}`;

  return (
    <DialogWrapper
      title={t('speleodb.projectDialog.title')}
      onClose={closeDialog}
      // Same fixed footprint as Project Settings, so the content pane scrolls
      // within the dialog instead of overflowing the screen.
      fixedSize={{ width: 'min(720px, 95vw)', height: 'clamp(420px, 75vh, 760px)' }}
      closeOnBackdropClick={false}
      overflow="hidden"
      bodyClassName="flex flex-col flex-1 min-h-0"
      data-testid="speleodb-project-dialog"
    >
      {!isRemote ? (
        <p className="text-text-secondary p-4" data-testid="speleodb-project-not-remote">
          {t('speleodb.projectDialog.notRemote')}
        </p>
      ) : (
        <div className="flex flex-1 min-h-0">
          <div className="w-44 shrink-0 border-r border-border p-2 space-y-1" role="tablist">
            {TABS.map((tk) => (
              <button
                key={tk}
                id={tabId(tk)}
                role="tab"
                aria-selected={tab === tk}
                aria-controls={panelId(tk)}
                onClick={() => setTab(tk)}
                className={`w-full text-left px-3 py-1.5 rounded text-sm ${tab === tk ? 'bg-accent-10 text-text-primary' : 'text-text-secondary hover:bg-background-50'}`}
                data-testid={`speleodb-project-tab-${tk}`}
              >
                {t(`speleodb.projectDialog.tabs.${tk}`)}
              </button>
            ))}
          </div>

          <div className="flex-1 min-w-0 overflow-auto p-4">
            {tab === 'general' && (
              <div role="tabpanel" id={panelId('general')} aria-labelledby={tabId('general')}>
                <SpeleoDbGeneralTab metadata={metadata} />
              </div>
            )}
            {tab === 'collaborators' && (
              <div
                role="tabpanel"
                id={panelId('collaborators')}
                aria-labelledby={tabId('collaborators')}
              >
                <SpeleoCollaboratorsTab />
              </div>
            )}
            {tab === 'history' && (
              <div role="tabpanel" id={panelId('history')} aria-labelledby={tabId('history')}>
                <SpeleoRevisionHistory />
              </div>
            )}
            {tab === 'admin' && (
              <div role="tabpanel" id={panelId('admin')} aria-labelledby={tabId('admin')}>
                <SpeleoAdminTab />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Always rendered (even with no link, and on the tabs that carry no Save) so
          the dialog chrome does not jump as the panel changes. */}
      <div className="border-t border-border p-3 flex justify-end gap-2 shrink-0">
        <Button variant="secondary" onClick={closeDialog} data-testid="speleodb-project-close">
          {t('common.actions.close')}
        </Button>
        {/* Only the General tab stages its edits; every other tab writes to the
            server on click. Omitted outright for a read-only user, as the in-body
            button was - there is nothing they could save. */}
        {isRemote && tab === 'general' && metadata.canEdit && (
          <Button
            variant="primary"
            disabled={!metadata.canSave}
            onClick={() => void metadata.handleSave()}
            data-testid="speleodb-settings-save"
          >
            {metadata.saving
              ? t('speleodb.projectSettings.saving')
              : t('speleodb.projectSettings.saveButton')}
          </Button>
        )}
      </div>
    </DialogWrapper>
  );
}
