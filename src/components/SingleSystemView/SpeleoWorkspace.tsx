import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { SpeleoHistorySteps } from './SpeleoHistorySteps';
import { useSpeleoStore } from '../../store/speleoStore';
import { useUIStore } from '../../store/uiStore';
import { useSpeleoActions } from '../../hooks/useSpeleoActions';
import { useSpeleoOperationBusy } from '../../hooks/useSpeleoOperationBusy';
import { useSpeleoWebLink } from '../../hooks/useSpeleoWebLink';
import { releaseOpenProjectLock } from '../../utils/releaseOpenProjectLock';
import { canResumeSpeleoEditing, permissionAtLeast } from '../../utils/speleoPermission';
import { dispatchProjectSave } from '../../utils/dispatchProjectSave';
import { SpeleoRevisionHistory } from '../Dialogs/settings/SpeleoRevisionHistory';
import { useProject } from '../../hooks/useProject';
import { useProjectStore } from '../../store/projectStore';
import type { SpeleoLinkState } from '../../store/speleoStore';
import { Button } from '../common/Button';
import { SpeleoDbLogo } from '../common/SpeleoDbLogo';
import { RefreshGlyph } from '../common/SpeleoBadgedIcon';
import { ChevronDownIcon, ChevronRightIcon, CloseIcon, ExternalLinkIcon, LockIcon, PencilIcon, SaveIcon, SignInIcon } from '../common/icons';
import { SpeleoWorkspaceHeader } from './SpeleoWorkspaceHeader';

const areas = [['history', 'History']] as const;
/** Icon size for the workspace's action buttons. */
const ICON = 16;

/**
 * Which everyday action is the primary one (style guide: one per view), from the
 * state of the open copy:
 * - editing, or holding unsaved edits: Save Changes (it protects the work: it
 *   uploads, or saves on this computer when it cannot);
 * - signed out: Sign in, the only way back to editing (Save has nothing to upload);
 * - signed in, able to resume, nothing waiting: Resume editing;
 * - signed in with saved but un-uploaded edits: Save Changes (it takes the lock);
 * - otherwise (view-only access, no access): none.
 */
export function speleoPrimaryAction(
  link: SpeleoLinkState,
  signedIn: boolean,
  canResume: boolean,
  isDirty: boolean,
): 'save' | 'editing' | null {
  if (link.editState === 'editing' || isDirty) return 'save';
  if (!signedIn) return 'editing';
  if (link.hasUnpushedEdits) return 'save';
  return canResume ? 'editing' : null;
}

/** Why a workspace action is disabled, as its tooltip; `undefined` when it is not. */
function disabledReasons(
  t: TFunction,
  link: SpeleoLinkState,
  signedIn: boolean,
  busy: boolean,
  hasWebUrl: boolean,
): { editing?: string; reload?: string; web?: string; busy?: string } {
  const busyReason = busy ? t('speleodb.workspace.disabled.busy') : undefined;
  const editing = link.noAccess ? t('speleodb.workspace.disabled.noAccess')
    : link.permission === null ? t('speleodb.workspace.disabled.permissionUnknown')
    : !permissionAtLeast(link.permission, 'READ_AND_WRITE') ? t('speleodb.cachedCopies.viewOnly')
    : undefined;
  const reload = !signedIn ? t('speleodb.workspace.disabled.reloadSignedOut')
    : link.noAccess || (link.permission !== null && !permissionAtLeast(link.permission, 'READ_ONLY'))
      ? t('speleodb.workspace.disabled.noAccess')
      : undefined;
  return {
    ...(busyReason ? { busy: busyReason } : {}),
    ...(editing ? { editing } : {}),
    ...(reload ? { reload } : {}),
    ...(hasWebUrl ? {} : { web: t('speleodb.web.unavailable') }),
  };
}

/** Single persistent body: accordion navigation hides content without unmounting drafts. */
export function SpeleoWorkspace() {
  const { t } = useTranslation();
  const link = useSpeleoStore((s) => s.link);
  const isDirty = useProjectStore((s) => s.isDirty);
  const session = useSpeleoStore((s) => s.session);
  const expanded = useUIStore((s) => s.speleoWorkspaceSection);
  const [visited, setVisited] = useState(() => new Set<string>());
  useEffect(() => { if (expanded) setVisited((old) => new Set([...old, expanded])); }, [expanded]);
  const { startEditing, update } = useSpeleoActions();
  const busy = useSpeleoOperationBusy();
  const { handleCloseProject } = useProject();
  const web = useSpeleoWebLink();
  if (!link) return (
    <div className="flex h-full min-h-0 flex-col items-center overflow-y-auto px-5 py-8" data-testid="speleodb-workspace-local">
      <div className="my-auto flex w-full max-w-[16rem] flex-col items-center text-center" data-testid="speleodb-workspace-conversion-prompt">
        <div className="mb-5 flex h-20 w-20 shrink-0 items-center justify-center rounded-full border border-accent-20 bg-accent-10 text-accent">
          <SpeleoDbLogo size={56} />
        </div>
        <h2 className="text-xl font-semibold leading-snug text-text-primary">Build your survey together</h2>
        <p className="mt-3 text-sm leading-relaxed text-text-secondary">
          Track how your survey evolves, revisit earlier versions, and bring your team&apos;s work together in one shared project.
        </p>
        <Button variant="primary" onClick={() => useUIStore.getState().openDialog('publish-to-speleodb')}
          className="mt-6 w-full px-3 py-3 text-sm leading-snug" disabled={busy}
          icon={<SpeleoDbLogo size={ICON} />}
          data-testid="speleodb-workspace-convert">Convert to a SpeleoDB project</Button>
      </div>
    </div>
  );
  const editing = link.editState === 'editing';
  const signedIn = session?.loggedIn === true;
  const canResume = canResumeSpeleoEditing(link, session);
  const primary = speleoPrimaryAction(link, signedIn, canResume, isDirty);
  const why = disabledReasons(t, link, signedIn, busy, web.url !== null);
  const editingDisabled = busy || (signedIn && !canResume && !editing);
  const reloadDisabled = busy || why.reload !== undefined;
  return (
    <div className="h-full min-h-0 flex flex-col gap-3 p-3 text-sm" data-testid="speleodb-workspace">
      <SpeleoWorkspaceHeader link={link} />
      <div className="shrink-0 grid gap-2" data-testid="speleodb-workspace-everyday">
        <Button variant={primary === 'save' ? 'primary' : 'secondary'} onClick={() => void dispatchProjectSave()} disabled={busy}
          title={busy ? why.busy : undefined}
          icon={<SaveIcon size={ICON} />} data-testid="speleodb-workspace-upload">Save Changes</Button>
        <Button variant={primary === 'editing' ? 'primary' : 'secondary'}
          onClick={() => editing ? void releaseOpenProjectLock() : canResume ? void startEditing() : useUIStore.getState().openDialog('settings', { initialCategory: 'speleodb' })}
          disabled={editingDisabled}
          title={!editingDisabled ? undefined : busy ? why.busy : why.editing}
          icon={editing ? <LockIcon size={ICON} /> : signedIn ? <PencilIcon size={ICON} /> : <SignInIcon size={ICON} />}
          data-testid="speleodb-workspace-editing">
          {editing ? 'Switch to Read Only Mode' : signedIn ? 'Resume editing' : 'Sign in to resume editing'}
        </Button>
        <Button onClick={() => void update()} disabled={reloadDisabled}
          title={!reloadDisabled ? undefined : why.reload ?? why.busy}
          icon={<RefreshGlyph size={ICON} />} data-testid="speleodb-workspace-latest">Reload Project</Button>
        <Button onClick={() => void handleCloseProject()} disabled={busy} title={busy ? why.busy : undefined}
          icon={<CloseIcon size={ICON} />} data-testid="speleodb-workspace-close">Close Project</Button>
        <Button onClick={web.open} disabled={!web.url} title={why.web}
          icon={<ExternalLinkIcon size={ICON} />} data-testid="speleodb-workspace-open-web">Open on SpeleoDB</Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="speleodb-workspace-sections">
      {areas.map(([id, label]) => (
        <section key={id} className="border-t border-border pt-2">
          <button type="button" aria-expanded={expanded === id} aria-controls={`speleodb-area-${id}`}
            className="w-full flex items-center gap-1.5 text-left font-medium py-2 focus-visible:outline focus-visible:outline-accent"
            data-testid={`speleodb-workspace-section-${id}`}
            onClick={() => useUIStore.setState({ speleoWorkspaceSection: expanded === id ? null : id })}>
            {expanded === id ? <ChevronDownIcon size={ICON} /> : <ChevronRightIcon size={ICON} />}
            {label}
          </button>
          <div id={`speleodb-area-${id}`} hidden={expanded !== id} className="space-y-3">
            {(visited.has(id) || expanded === id) && <>
            {id === 'history' && <><SpeleoHistorySteps /><SpeleoRevisionHistory /></>}
            </>}
          </div>
        </section>
      ))}
      </div>
    </div>
  );
}
