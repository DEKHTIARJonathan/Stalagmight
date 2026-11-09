import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useProjectStore } from '../../store/projectStore';
import { useSpeleoStore, type SpeleoLinkState } from '../../store/speleoStore';
import { useUIStore } from '../../store/uiStore';
import { permissionAtLeast } from '../../utils/speleoPermission';
import { Button } from '../common/Button';

/**
 * Plain-language lock state for the open project, in the same words as the
 * home-screen badges ("You are editing", "Currently being edited by X",
 * "Ready for editing").
 */
export function speleoLockStateLabel(link: SpeleoLinkState, t: TFunction): string {
  if (link.editState === 'editing') return t('speleodb.lockState.youAreEditing');
  if (link.lockHolder && link.lockedByOther) {
    return t('speleodb.lockState.beingEditedBy', { email: link.lockHolder });
  }
  if (!link.lockHolder && !link.noAccess && permissionAtLeast(link.permission, 'READ_AND_WRITE')) {
    return t('speleodb.lockState.readyForEditing');
  }
  return t('speleodb.lockState.readOnly');
}

/** Project name, lock and connection state, and the recovery actions they call for. */
export function SpeleoWorkspaceHeader({ link }: { link: SpeleoLinkState }) {
  const { t } = useTranslation();
  const projectName = useProjectStore((s) => s.project?.name);
  const session = useSpeleoStore((s) => s.session);
  return (
    <div className="shrink-0 border-b border-border pb-3 space-y-1" data-testid="speleodb-workspace-project-header">
      <h2 className="font-semibold break-words">{projectName}</h2>
      <p data-testid="speleodb-workspace-lock-state">{speleoLockStateLabel(link, t)}</p>
      <p className="text-text-secondary">{!session?.loggedIn ? 'Signed out' : link.serverError ? link.serverError.message : link.remoteState === 'unknown' ? 'Connection unavailable' : 'Connected'}</p>
      {link.noAccess && <Button onClick={() => useUIStore.getState().openDialog('speleodb-no-permission')} data-testid="speleodb-workspace-no-access">Keep a local project</Button>}
      {link.remoteState === 'conflict' && <Button onClick={() => useUIStore.getState().openDialog('speleodb-divergence')} data-testid="speleodb-workspace-resolve">Resolve synchronization conflict</Button>}
      {link.hasUnpushedEdits && <p className="text-warning">Changes on this computer have not been uploaded.</p>}
    </div>
  );
}
