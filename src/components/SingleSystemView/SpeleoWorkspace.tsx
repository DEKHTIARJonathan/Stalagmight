import { useEffect, useState } from 'react';
import { SpeleoHistorySteps } from './SpeleoHistorySteps';
import { useProjectStore } from '../../store/projectStore';
import { useSpeleoStore } from '../../store/speleoStore';
import { useUIStore } from '../../store/uiStore';
import { useSpeleoActions } from '../../hooks/useSpeleoActions';
import { useSpeleoWebLink } from '../../hooks/useSpeleoWebLink';
import { releaseOpenProjectLock } from '../../utils/releaseOpenProjectLock';
import { permissionAtLeast } from '../../utils/speleoPermission';
import { dispatchProjectSave } from '../../utils/dispatchProjectSave';
import { SpeleoRevisionHistory } from '../Dialogs/settings/SpeleoRevisionHistory';
import { useProject } from '../../hooks/useProject';
import { Button } from '../common/Button';

const areas = [['history', 'History']] as const;

/** Single persistent body: accordion navigation hides content without unmounting drafts. */
export function SpeleoWorkspace() {
  const projectName = useProjectStore((s) => s.project?.name);
  const link = useSpeleoStore((s) => s.link);
  const session = useSpeleoStore((s) => s.session);
  const expanded = useUIStore((s) => s.speleoWorkspaceSection);
  const [visited, setVisited] = useState(() => new Set<string>());
  useEffect(() => { if (expanded) setVisited((old) => new Set([...old, expanded])); }, [expanded]);
  const { busy, startEditing, update } = useSpeleoActions();
  const { handleCloseProject } = useProject();
  const web = useSpeleoWebLink();
  if (!link) return null;
  const editing = link.editState === 'editing';
  const canResume = session?.loggedIn && !link.noAccess && permissionAtLeast(link.permission, 'READ_AND_WRITE');
  return (
    <div className="h-full min-h-0 flex flex-col gap-3 p-3 text-sm" data-testid="speleodb-workspace">
      <div className="shrink-0 border-b border-border pb-3 space-y-1" data-testid="speleodb-workspace-project-header">
        <h2 className="font-semibold break-words">{projectName}</h2>
        <p>{editing ? 'Editing' : 'Read-only'}{link.lockHolder ? ` - ${link.lockHolder}` : ''}</p>
        <p className="text-text-secondary">{!session?.loggedIn ? 'Signed out' : link.serverError ? link.serverError.message : link.remoteState === 'unknown' ? 'Connection unavailable' : 'Connected'}</p>
        {link.noAccess && <Button onClick={() => useUIStore.getState().openDialog('speleodb-no-permission')} data-testid="speleodb-workspace-no-access">Keep a local project</Button>}
        {link.remoteState === 'conflict' && <Button onClick={() => useUIStore.getState().openDialog('speleodb-divergence')} data-testid="speleodb-workspace-resolve">Resolve synchronization conflict</Button>}
        {link.hasUnpushedEdits && <p className="text-warning">Changes on this computer have not been uploaded.</p>}
      </div>
      <div className="shrink-0 grid gap-2" data-testid="speleodb-workspace-everyday">
        <Button variant="primary" onClick={() => void dispatchProjectSave()} disabled={busy} data-testid="speleodb-workspace-upload">Save Changes</Button>
        <Button onClick={() => editing ? void releaseOpenProjectLock() : canResume ? void startEditing() : useUIStore.getState().openDialog('settings', { initialCategory: 'speleodb' })}
          disabled={busy || (session?.loggedIn === true && !canResume && !editing)} data-testid="speleodb-workspace-editing">
          {editing ? 'Switch to Read Only Mode' : session?.loggedIn ? 'Resume editing' : 'Sign in to resume editing'}
        </Button>
        <Button onClick={() => void update()} disabled={busy || !session?.loggedIn || link.noAccess || (link.permission !== null && !permissionAtLeast(link.permission, 'READ_ONLY'))} data-testid="speleodb-workspace-latest">Reload Project</Button>
        <Button onClick={() => void handleCloseProject()} disabled={busy} data-testid="speleodb-workspace-close">Close Project</Button>
        <Button onClick={web.open} disabled={!web.url} data-testid="speleodb-workspace-open-web">Open on SpeleoDB</Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="speleodb-workspace-sections">
      {areas.map(([id, label]) => (
        <section key={id} className="border-t border-border pt-2">
          <button type="button" aria-expanded={expanded === id} aria-controls={`speleodb-area-${id}`}
            className="w-full text-left font-medium py-2 focus-visible:outline focus-visible:outline-accent"
            data-testid={`speleodb-workspace-section-${id}`}
            onClick={() => useUIStore.setState({ speleoWorkspaceSection: expanded === id ? null : id })}>
            {expanded === id ? 'v' : '>'} {label}
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
