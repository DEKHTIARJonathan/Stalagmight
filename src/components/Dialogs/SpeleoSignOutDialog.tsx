import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useProjectStore } from '../../store/projectStore';
import { selectPushFailure, useSpeleoStore } from '../../store/speleoStore';
import { useScreenOccupant } from '../../hooks/useScreenOccupant';
import { useOpenRemoteProject } from '../../hooks/useOpenRemoteProject';
import { getErrorMessage, invokeIpc } from '../../utils/ipc';
import { closeDiscardingLocal } from '../../utils/speleoExit';
import { commitMessageTooLong } from '../../utils/commitMessage';
import { saveOpenProjectLocally } from '../../utils/saveOpenProjectLocally';
import {
  releaseSignOutLocks,
  signOutHasWork,
  surveySignOut,
  useSpeleoSignOut,
  type SignOutKind,
  type SignOutProject,
  type SignOutSurvey,
} from '../../utils/speleoSignOut';
import type { CommandResult } from '../../types/ipc.generated';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';
import { SpeleoExitUploadFields, SpeleoExitUploadProgress, useSpeleoExitUpload } from './SpeleoExitUpload';

type Phase = 'checking' | 'checkFailed' | 'review' | 'releasing' | 'releaseFailed';
/** Per project: still to answer, being confirmed, being carried out, or answered. */
type RowState = 'pending' | 'upload' | 'confirm' | 'working' | 'uploaded' | 'discarded' | 'kept';

/**
 * What signing out would leave behind, and the user's answer for each (see
 * `utils/speleoSignOut`). Signing out is only offered once nothing un-uploaded is
 * left; the locks are then handed back, and a failed hand-back is reported with
 * "Try again" / "Sign out anyway" instead of a silent sign-out.
 */
export default function SpeleoSignOutDialog() {
  const request = useSpeleoSignOut((s) => s.request);
  if (!request) return null;
  return <SignOutPrompt key={request.id} kind={request.kind} initial={request.survey} settle={request.settle} />;
}

function SignOutPrompt({ kind, initial, settle }: {
  kind: SignOutKind;
  initial: SignOutSurvey | null;
  settle: (proceed: boolean) => void;
}) {
  const { t } = useTranslation();
  useScreenOccupant(true);
  const { openRemote } = useOpenRemoteProject();
  const { upload, uploading, slow, unwound } = useSpeleoExitUpload();
  const pushFailure = useSpeleoStore(selectPushFailure);
  const [survey, setSurvey] = useState<SignOutSurvey | null>(initial);
  const [phase, setPhase] = useState<Phase>(initial ? 'review' : 'checkFailed');
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState<SignOutProject[]>([]);

  const rowState = (id: string): RowState => rows[id] ?? 'pending';
  const setRow = (id: string, state: RowState) => setRows((prev) => ({ ...prev, [id]: state }));
  const anyWorking = phase === 'checking' || phase === 'releasing' || uploading ||
    Object.values(rows).some((state) => state === 'working');

  const recheck = async () => {
    setPhase('checking');
    setError(null);
    try {
      const fresh = await surveySignOut();
      if (!signOutHasWork(fresh)) {
        settle(true);
        return;
      }
      setSurvey(fresh);
      setRows({});
      setPhase('review');
    } catch (e) {
      setError(getErrorMessage(e));
      setPhase('checkFailed');
    }
  };

  const open = survey?.openProject ?? null;
  const openId = open?.summary.id ?? null;
  const [openPath] = useState(() => useProjectStore.getState().project?.file_path ?? null);
  const openCurrent = () => (useProjectStore.getState().project?.file_path ?? null) === openPath;

  const uploadOpen = async () => {
    if (!openId || !message.trim() || commitMessageTooLong(message)) return;
    setRow(openId, 'working');
    setError(null);
    const result = await upload(message.trim(), openCurrent);
    if (result === 'released') {
      setRow(openId, 'uploaded');
      return;
    }
    setRow(openId, 'upload');
    if (result === 'diverged') {
      // SpeleoDB moved on: the divergence dialog is the way through, so the
      // sign-out stops here and the user resolves it first.
      settle(false);
    } else if (result === 'newer') {
      setError(t('speleoExitPrompt.errors.newerChanges'));
    }
  };

  const discard = async (project: SignOutProject) => {
    const id = project.summary.id;
    setRow(id, 'working');
    setError(null);
    const isOpenProject = id === useSpeleoStore.getState().remoteProjectId &&
      useProjectStore.getState().project !== null;
    let outcome: { ok: boolean; error?: string | undefined };
    try {
      if (isOpenProject) {
        const closed = await closeDiscardingLocal();
        outcome = closed.ok ? { ok: true } : { ok: false, error: closed.error };
      } else {
        // Reached only from the confirmed "lost forever" step: that is the user's
        // explicit consent, which the backend requires before it removes
        // un-uploaded work (and it refuses another account's copy regardless).
        const result = await invokeIpc<CommandResult>('speleodb_discard_cached_copy', {
          projectId: id,
          discardUnpushed: true,
        }, {
          purpose: 'discard un-uploaded changes before signing out',
        });
        outcome = result.success ? { ok: true } : { ok: false, error: result.error ?? undefined };
      }
    } catch (e) {
      outcome = { ok: false, error: getErrorMessage(e) };
    }
    if (outcome.ok) {
      setRow(id, 'discarded');
      if (isOpenProject) void useProjectStore.getState().loadRecentProjects();
    } else {
      setRow(id, 'pending');
      setError(outcome.error || t('speleoExitPrompt.signOut.discardFailed', { name: project.summary.name }));
    }
  };

  // "Keep my changes on this computer" (decision 10: never discard-only). The
  // copy keeps its edits, its un-uploaded mark and its recents row; its lock joins
  // the hand-backs below, the user's explicit choice standing in for the consent
  // a silent release never has. Unsaved edits of the OPEN project are saved first.
  const keepOpen = async () => {
    if (!openId) return;
    setRow(openId, 'working');
    setError(null);
    if (useProjectStore.getState().isDirty) {
      const saved = await saveOpenProjectLocally();
      if (!saved?.success || useProjectStore.getState().isDirty) {
        setRow(openId, 'pending');
        setError(t('speleoExitPrompt.signOut.keepFailed'));
        return;
      }
    }
    setRow(openId, 'kept');
  };

  const openToUpload = (project: SignOutProject) => {
    // Cancels the sign-out: the work can only be uploaded from inside the project.
    settle(false);
    const alreadyOpen = project.summary.id === useSpeleoStore.getState().remoteProjectId &&
      useProjectStore.getState().project !== null;
    if (!alreadyOpen) void openRemote(project.summary);
  };

  const release = async (projects: SignOutProject[]) => {
    setPhase('releasing');
    setError(null);
    const left = await releaseSignOutLocks(projects);
    if (left.length === 0) {
      settle(true);
      return;
    }
    setFailed(left);
    setPhase('releaseFailed');
  };

  const signOut = () => {
    if (!survey) return;
    // Discarded or kept rows that held a lock join the plain releases; an
    // uploaded or discarded OPEN project already handed its lock back, and a kept
    // one hands it back here (we hold it: that is why it was asked about).
    const answered = (p: SignOutProject) => ['discarded', 'kept'].includes(rowState(p.summary.id));
    const otherLocks = survey.unuploaded.filter((p) => p.holdsLock && answered(p));
    const keptOpen = open && rowState(open.summary.id) === 'kept' ? [open] : [];
    void release([...survey.releasable, ...otherLocks, ...keptOpen]);
  };

  const openResolved = !open || ['uploaded', 'discarded', 'kept'].includes(rowState(open.summary.id));
  const othersResolved = (survey?.unuploaded ?? []).every((p) => ['discarded', 'kept'].includes(rowState(p.summary.id)));
  const canSignOut = phase === 'review' && openResolved && othersResolved && !anyWorking;
  const goLabel = kind === 'switch' ? t('speleoExitPrompt.signOut.switch') : t('speleoExitPrompt.signOut.signOut');
  const names = (projects: SignOutProject[]) => projects.map((p) => p.summary.name || t('speleoExitPrompt.signOut.unnamed')).join(', ');
  const lastEdited = (p: SignOutProject) => {
    const when = p.lastEditAt ? new Date(p.lastEditAt) : null;
    return when && !Number.isNaN(when.getTime()) ? t('speleoExitPrompt.signOut.lastEdited', { when: when.toLocaleString() }) : null;
  };

  return (
    <>
      <DialogWrapper
        title={kind === 'switch' ? t('speleoExitPrompt.signOut.switchTitle') : t('speleoExitPrompt.signOut.title')}
        onClose={anyWorking ? () => {} : () => settle(false)}
        size="md"
        data-testid="speleodb-signout-dialog"
      >
        <div className="space-y-4" data-phase={phase}>
          {phase === 'checking' && (
            <p role="status" className="text-sm text-text-secondary" data-testid="speleodb-signout-checking">
              {t('speleoExitPrompt.signOut.checking')}
            </p>
          )}

          {phase === 'checkFailed' && (
            <div className="space-y-2" data-testid="speleodb-signout-check-failed">
              <p className="text-sm font-medium text-text-primary">{t('speleoExitPrompt.signOut.checkFailedTitle')}</p>
              <p className="text-sm text-text-secondary">{t('speleoExitPrompt.signOut.checkFailedBody')}</p>
            </div>
          )}

          {(phase === 'review' || phase === 'releasing') && survey && (
            <>
              <p className="text-sm text-text-secondary">{t('speleoExitPrompt.signOut.intro')}</p>

              {open && (
                <section className="space-y-2 rounded border border-border p-3" data-testid="speleodb-signout-open">
                  <p className="text-sm font-medium text-text-primary">
                    {t('speleoExitPrompt.signOut.openProject', { name: open.summary.name })}
                  </p>
                  {rowState(open.summary.id) === 'uploaded' && (
                    <p className="text-sm text-success" data-testid="speleodb-signout-open-uploaded">{t('speleoExitPrompt.signOut.uploaded')}</p>
                  )}
                  {rowState(open.summary.id) === 'discarded' && (
                    <p className="text-sm text-text-secondary" data-testid="speleodb-signout-open-discarded">{t('speleoExitPrompt.signOut.discarded')}</p>
                  )}
                  {rowState(open.summary.id) === 'kept' && (
                    <p className="text-sm text-text-secondary" data-testid="speleodb-signout-open-kept">{t('speleoExitPrompt.signOut.kept')}</p>
                  )}
                  {rowState(open.summary.id) === 'pending' && (
                    <>
                      <p className="text-sm text-text-secondary">{t('speleoExitPrompt.signOut.openProjectBody')}</p>
                      <div className="flex flex-wrap gap-2">
                        <Button variant="primary" onClick={() => setRow(open.summary.id, 'upload')} disabled={anyWorking}
                          data-testid="speleodb-signout-open-upload">
                          {t('speleoExitPrompt.upload')}
                        </Button>
                        <Button onClick={() => void keepOpen()} disabled={anyWorking}
                          data-testid="speleodb-signout-open-keep">
                          {t('speleoExitPrompt.signOut.keep')}
                        </Button>
                        <Button variant="danger" onClick={() => setRow(open.summary.id, 'confirm')} disabled={anyWorking}
                          data-testid="speleodb-signout-open-discard">
                          {t('speleoExitPrompt.discard')}
                        </Button>
                      </div>
                      <p className="text-xs text-text-secondary">{t('speleoExitPrompt.signOut.keepHint')}</p>
                    </>
                  )}
                  {(rowState(open.summary.id) === 'upload' || (rowState(open.summary.id) === 'working' && uploading)) && (
                    <>
                      <SpeleoExitUploadFields message={message} onMessage={setMessage} disabled={anyWorking}
                        uploading={uploading} slow={slow} unwound={unwound} testIdPrefix="speleodb-signout" />
                      <div className="flex flex-wrap gap-2">
                        <Button onClick={() => setRow(open.summary.id, 'pending')} disabled={anyWorking}
                          data-testid="speleodb-signout-open-back">
                          {t('speleoExitPrompt.back')}
                        </Button>
                        <Button variant="primary" onClick={() => void uploadOpen()} disabled={anyWorking || !message.trim() || commitMessageTooLong(message)}
                          data-testid="speleodb-signout-open-upload-confirm">
                          {uploading ? t('speleoExitPrompt.uploading') : t('speleoExitPrompt.upload')}
                        </Button>
                      </div>
                    </>
                  )}
                  {rowState(open.summary.id) === 'confirm' && (
                    <DiscardConfirm name={open.summary.name} disabled={anyWorking}
                      onBack={() => setRow(open.summary.id, 'pending')} onConfirm={() => void discard(open)}
                      testId="speleodb-signout-open" />
                  )}
                </section>
              )}

              {survey.unuploaded.length > 0 && (
                <section className="space-y-2" data-testid="speleodb-signout-unuploaded">
                  <p className="text-sm font-medium text-text-primary">{t('speleoExitPrompt.signOut.otherChanges')}</p>
                  <p className="text-xs text-text-secondary">{t('speleoExitPrompt.signOut.otherChangesBody')}</p>
                  <ul className="space-y-2">
                    {survey.unuploaded.map((project) => {
                      const id = project.summary.id;
                      const state = rowState(id);
                      const edited = lastEdited(project);
                      return (
                        <li key={id} className="rounded border border-border p-2 space-y-1" data-testid={`speleodb-signout-row-${id}`}>
                          <p className="text-sm text-text-primary">
                            {project.summary.name || t('speleoExitPrompt.signOut.unnamed')}
                            {edited && <span className="text-xs text-text-secondary"> - {edited}</span>}
                          </p>
                          {state === 'discarded' ? (
                            <p className="text-xs text-text-secondary" data-testid={`speleodb-signout-row-${id}-discarded`}>
                              {t('speleoExitPrompt.signOut.discarded')}
                            </p>
                          ) : state === 'kept' ? (
                            <p className="text-xs text-text-secondary" data-testid={`speleodb-signout-row-${id}-kept`}>
                              {t('speleoExitPrompt.signOut.kept')}
                            </p>
                          ) : state === 'confirm' ? (
                            <DiscardConfirm name={project.summary.name} disabled={anyWorking}
                              onBack={() => setRow(id, 'pending')} onConfirm={() => void discard(project)}
                              testId={`speleodb-signout-row-${id}`} />
                          ) : (
                            <div className="flex flex-wrap gap-2">
                              <Button variant="primary" onClick={() => openToUpload(project)} disabled={anyWorking}
                                data-testid={`speleodb-signout-row-${id}-open`}>
                                {t('speleoExitPrompt.signOut.openToUpload')}
                              </Button>
                              <Button onClick={() => setRow(id, 'kept')} disabled={anyWorking}
                                data-testid={`speleodb-signout-row-${id}-keep`}>
                                {t('speleoExitPrompt.signOut.keep')}
                              </Button>
                              <Button variant="danger" onClick={() => setRow(id, 'confirm')} disabled={anyWorking}
                                data-testid={`speleodb-signout-row-${id}-discard`}>
                                {t('speleoExitPrompt.discard')}
                              </Button>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}

              {survey.releasable.length > 0 && (
                <section className="space-y-1" data-testid="speleodb-signout-releasable">
                  <p className="text-sm text-text-secondary">{t('speleoExitPrompt.signOut.willRelease')}</p>
                  <ul className="list-disc pl-5 text-sm text-text-primary">
                    {survey.releasable.map((p) => <li key={p.summary.id}>{p.summary.name || t('speleoExitPrompt.signOut.unnamed')}</li>)}
                  </ul>
                </section>
              )}

              {phase === 'releasing' && (
                <p role="status" className="text-sm text-text-secondary" data-testid="speleodb-signout-releasing">
                  {t('speleoExitPrompt.signOut.releasing')}
                </p>
              )}
            </>
          )}

          {phase === 'releaseFailed' && (
            <div className="space-y-2" data-testid="speleodb-signout-release-failed">
              <p className="text-sm font-medium text-text-primary">{t('speleoExitPrompt.signOut.releaseFailedTitle')}</p>
              <p className="text-sm text-text-secondary">{t('speleoExitPrompt.signOut.releaseFailedBody', { names: names(failed) })}</p>
              <p className="text-sm text-warning">{t('speleoExitPrompt.signOut.signOutAnywayHint')}</p>
            </div>
          )}

          {error && !pushFailure && (
            <p role="alert" className="text-sm text-error" data-testid="speleodb-signout-error">{error}</p>
          )}

          <div className="flex flex-wrap justify-end gap-2 pt-2 border-t border-border">
            <Button onClick={() => settle(false)} disabled={anyWorking} data-testid="speleodb-signout-cancel">
              {t('common.actions.cancel')}
            </Button>
            {phase === 'checkFailed' && (
              <>
                <Button onClick={() => settle(true)} data-testid="speleodb-signout-anyway">
                  {t('speleoExitPrompt.signOut.signOutAnyway')}
                </Button>
                <Button variant="primary" onClick={() => void recheck()} data-primary-action="" data-testid="speleodb-signout-retry">
                  {t('speleoExitPrompt.signOut.retry')}
                </Button>
              </>
            )}
            {phase === 'releaseFailed' && (
              <>
                <Button onClick={() => settle(true)} data-testid="speleodb-signout-anyway">
                  {t('speleoExitPrompt.signOut.signOutAnyway')}
                </Button>
                <Button variant="primary" onClick={() => void release(failed)} data-primary-action="" data-testid="speleodb-signout-retry">
                  {t('speleoExitPrompt.signOut.retry')}
                </Button>
              </>
            )}
            {(phase === 'review' || phase === 'releasing') && (
              <Button variant="primary" onClick={signOut} disabled={!canSignOut} data-testid="speleodb-signout-go">
                {phase === 'releasing' ? t('speleoExitPrompt.signOut.releasingShort') : goLabel}
              </Button>
            )}
          </div>
        </div>
      </DialogWrapper>
      <SpeleoExitUploadProgress uploading={uploading} slow={slow} testId="speleodb-signout-upload-progress" />
    </>
  );
}

/** The second, "lost forever" step every discard in the sign-out goes through. */
function DiscardConfirm({ name, disabled, onBack, onConfirm, testId }: {
  name: string; disabled: boolean; onBack: () => void; onConfirm: () => void; testId: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2" role="group" aria-label={t('speleoExitPrompt.discardTitle')}>
      <p className="text-sm font-medium text-text-primary" data-testid={`${testId}-discard-body`}>
        {t('speleoExitPrompt.discardTitle')} {t('speleoExitPrompt.signOut.discardBody', { name })}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={onBack} disabled={disabled} data-testid={`${testId}-discard-back`}>
          {t('speleoExitPrompt.back')}
        </Button>
        <Button variant="danger" onClick={onConfirm} disabled={disabled} data-testid={`${testId}-discard-confirm`}>
          {t('speleoExitPrompt.discardConfirm')}
        </Button>
      </div>
    </div>
  );
}
