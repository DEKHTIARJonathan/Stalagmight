import { useEffect, useState } from 'react';
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
import { Button } from '../common/Button';
import { SpeleoDbLogo } from '../common/SpeleoDbLogo';
import { RefreshGlyph } from '../common/SpeleoBadgedIcon';
import { ChevronDownIcon, ChevronRightIcon, CloseIcon, ExternalLinkIcon, LockIcon, PencilIcon, SaveIcon, SignInIcon } from '../common/icons';
import { SpeleoWorkspaceHeader } from './SpeleoWorkspaceHeader';

const areas = [['history', 'History']] as const;
/** Icon size for the workspace's action buttons. */
const ICON = 16;

/** Single persistent body: accordion navigation hides content without unmounting drafts. */
export function SpeleoWorkspace() {
  const link = useSpeleoStore((s) => s.link);
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
  const canResume = canResumeSpeleoEditing(link, session);
  return (
    <div className="h-full min-h-0 flex flex-col gap-3 p-3 text-sm" data-testid="speleodb-workspace">
      <SpeleoWorkspaceHeader link={link} />
      <div className="shrink-0 grid gap-2" data-testid="speleodb-workspace-everyday">
        <Button variant="primary" onClick={() => void dispatchProjectSave()} disabled={busy} icon={<SaveIcon size={ICON} />} data-testid="speleodb-workspace-upload">Save Changes</Button>
        <Button onClick={() => editing ? void releaseOpenProjectLock() : canResume ? void startEditing() : useUIStore.getState().openDialog('settings', { initialCategory: 'speleodb' })}
          disabled={busy || (session?.loggedIn === true && !canResume && !editing)}
          icon={editing ? <LockIcon size={ICON} /> : session?.loggedIn ? <PencilIcon size={ICON} /> : <SignInIcon size={ICON} />}
          data-testid="speleodb-workspace-editing">
          {editing ? 'Switch to Read Only Mode' : session?.loggedIn ? 'Resume editing' : 'Sign in to resume editing'}
        </Button>
        <Button onClick={() => void update()} disabled={busy || !session?.loggedIn || link.noAccess || (link.permission !== null && !permissionAtLeast(link.permission, 'READ_ONLY'))} icon={<RefreshGlyph size={ICON} />} data-testid="speleodb-workspace-latest">Reload Project</Button>
        <Button onClick={() => void handleCloseProject()} disabled={busy} icon={<CloseIcon size={ICON} />} data-testid="speleodb-workspace-close">Close Project</Button>
        <Button onClick={web.open} disabled={!web.url} icon={<ExternalLinkIcon size={ICON} />} data-testid="speleodb-workspace-open-web">Open on SpeleoDB</Button>
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
