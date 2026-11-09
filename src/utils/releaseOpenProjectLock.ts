import { confirm } from '@tauri-apps/plugin-dialog';
import i18n from '../i18n';
import { useProjectStore } from '../store/projectStore';
import { useSpeleoStore, speleoProjectSessionIssuedFor } from '../store/speleoStore';
import { applySpeleoTreeReplacement } from './speleoTreeReplacement';
import { useUIStore } from '../store/uiStore';
import type { SpeleoFileAccess } from '../types/ipc.generated';
import { getErrorMessage, invokeIpc } from './ipc';
import { isProjectRequestCurrent, reserveProjectRequest } from './projectTransition';

/** Release the open project's lock without uploading or leaving its view. */
export async function releaseOpenProjectLock(): Promise<void> {
  const speleo = useSpeleoStore.getState();
  if (speleo.busy) return;
  const project = useProjectStore.getState();
  const path = project.project?.file_path;
  if (!path) return;
  const session = speleo.sessionGeneration;
  const request = reserveProjectRequest();
  const token = speleo.beginBusy();
  const issuedFor = speleoProjectSessionIssuedFor(speleo.remoteProjectId);
  const loadId = project.loading.clientOpId;
  const current = () => isProjectRequestCurrent(request) &&
    useSpeleoStore.getState().sessionGeneration === session;
  const sameProject = () => current() && useProjectStore.getState().project?.file_path === path &&
    useProjectStore.getState().loading.clientOpId === loadId;
  try {
    if (project.isDirty) {
      const discard = await confirm(i18n.t('speleodb.release.unsavedMessage'), {
        title: i18n.t('speleodb.release.title'),
        kind: 'warning',
        okLabel: i18n.t('speleodb.release.discard'),
        cancelLabel: i18n.t('common.actions.cancel'),
      });
      if (!discard || !sameProject()) return;
    }
    if (!sameProject()) return;
    const access = await invokeIpc<SpeleoFileAccess | null>('speleodb_project_access_at', { path, localOnly: true });
    if (!sameProject()) return;
    if (!access?.release_context) throw new Error('The project or account changed. Try again.');
    await invokeIpc('speleodb_release_current_lock', {
      ownOnly: true, allowUnpushed: true, expected: access.release_context, discardUnsaved: project.isDirty,
    });
    if (!sameProject()) return;
    // The release result is authoritative even if the following status refresh is offline.
    // Unlike applyDone, this must retain the saved unpushed-work flag.
    useSpeleoStore.setState((state) => ({
      link: state.link ? {
        ...state.link, editState: 'read-only', forceEditing: false,
        lockHolder: null, lockedByOther: false,
      } : null,
    }));
    if (project.isDirty) {
      if (!await applySpeleoTreeReplacement(issuedFor, true)) return;
    } else {
      await useSpeleoStore.getState().refreshLinkStatus();
    }
    if (!sameProject()) return;
    useUIStore.getState().showToast(i18n.t('speleodb.release.released'), 'speleodb-release-lock', 'success');
  } catch (error) {
    if (sameProject()) await useSpeleoStore.getState().refreshLinkStatus();
    if (sameProject()) useUIStore.getState().openDialog('error', {
      title: i18n.t('speleodb.release.failed'), message: getErrorMessage(error),
    });
  } finally {
    useSpeleoStore.getState().endBusy(token);
  }
}
