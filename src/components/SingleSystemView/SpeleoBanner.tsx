import { SpeleoAccessNotice } from './SpeleoAccessNotice';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useSpeleoStore,
  PUSH_FAILURE_DIALOGS,
  type SpeleoBanner as SpeleoBannerState,
} from '../../store/speleoStore';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { dispatchProjectSave } from '../../utils/dispatchProjectSave';
import { getUploadContinuation, setUploadContinuation } from '../../utils/uploadContinuation';
import { humanizeSpeleoError } from '../../utils/speleoError';
import { TOAST_KEYS } from '../../utils/toastKeys';

export function SpeleoBanner() {
  const { t } = useTranslation();
  const banner = useSpeleoStore((s) => s.banner);
  const dismissBanner = useSpeleoStore((s) => s.dismissBanner);
  const enableRendering = useSpeleoStore((s) => s.enableRendering);
  // #270: Retry re-issues push/done, and BOTH need an open edit gate. Without one
  // the backend uploads nothing and answers `not_editing` - so offering "Retry
  // upload" there is an invitation to a no-op that reads like a fix. A 401 is
  // exactly how a project lands here: `clearSession()` drops to read-only while
  // KEEPING the unpushed edits, which is also what raised the failure banner.
  const editing = useSpeleoStore((s) => s.link?.editState === 'editing');
  const showToast = useUIStore((s) => s.showToast);
  // #260: while the dialog that issued the push/unlock is open it OWNS the failure
  // and renders it inline; this banner would only render behind that dialog's modal
  // scrim - dimmed, unreadable, its Retry/Dismiss unclickable. Dismissing the dialog
  // with the failure unresolved brings the banner straight back.
  const dialogOwnsFailure = useUIStore((s) =>
    s.activeDialog !== null && PUSH_FAILURE_DIALOGS.includes(s.activeDialog),
  );
  const busy = useSpeleoStore((s) => s.busy);
  // Inline second step for the Enable-rendering action (no single-click side effect
  // on server metadata; the confirm states rendering refreshes on the next push).
  const [confirmingEnable, setConfirmingEnable] = useState(false);
  const [enabling, setEnabling] = useState(false);

  // If the banner kind changes out from under the confirm sub-step (e.g. a push
  // lands and swaps in `push_unconfirmed` while the user is confirming), reset it -
  // otherwise the confirm prompt text would linger with no actionable buttons (the
  // confirm/back buttons are gated on `rendering_disabled`).
  useEffect(() => {
    if (banner?.kind !== 'rendering_disabled') setConfirmingEnable(false);
  }, [banner?.kind]);

  if (!banner) return <SpeleoAccessNotice />;
  // #260: the failure is on screen inside the dialog that caused it - never both.
  if (banner.kind === 'push_failed' && dialogOwnsFailure) return null;

  // #260: keep the failed attempt's own context so Retry replays the same verb with
  // the same commit message (narrowed once here - the JSX callbacks close over it).
  const pushFailed = banner.kind === 'push_failed' ? banner : null;

  // A total lookup rather than a ternary chain: the chain's final `else` was
  // `concurrent_session`, so a new banner kind would have silently rendered THAT
  // kind's message. Keyed on the union, so a new kind is a compile error here.
  const TEXT: Record<SpeleoBannerState['kind'], () => string> = {
    push_unconfirmed: () => t('speleodb.banner.pushUnconfirmed'),
    rendering_disabled: () => t('speleodb.banner.renderingDisabled'),
    no_anchor: () => t('speleodb.banner.noAnchor'),
    concurrent_session: () => t('speleodb.banner.concurrentSession'),
    push_failed: () =>
      t('speleodb.banner.pushFailed', { message: pushFailed?.message ?? '' }),
  };
  const text = TEXT[banner.kind]();

  // Retry returns to the shared Save confirmation, retaining the description
  // and any still-current Save-and-Close request through authentication recovery.
  const retry = () => {
    if (!pushFailed || useSpeleoStore.getState().busy || !editing) return;
    const path = useProjectStore.getState().project?.file_path;
    if (!path) return;
    const pending = getUploadContinuation(path);
    setUploadContinuation({
      path, message: pending?.message ?? pushFailed.pushMessage ?? '',
      closeAfterSave: pending?.closeAfterSave ?? false,
    });
    useUIStore.getState().openSpeleoWorkspace();
    if (pushFailed.origin === 'done' && !pending?.closeAfterSave) {
      // A failed explicit lock release retries that operation after confirmation.
      useUIStore.getState().openDialog('speleodb-done', { mode: 'release' });
    } else void dispatchProjectSave();
  };

  const confirmEnable = async () => {
    setEnabling(true);
    try {
      await enableRendering();
      // enableRendering clears the banner on success.
    } catch (e) {
      showToast(
        humanizeSpeleoError(e, t('speleodb.banner.enableRenderingFailed')),
        TOAST_KEYS.SPELEODB_ENABLE_RENDERING_ERROR,
        'error',
      );
    } finally {
      setEnabling(false);
      setConfirmingEnable(false);
    }
  };

  return (
    <div
      className="flex items-center justify-between gap-3 px-4 py-2 bg-warning-20 text-warning text-sm border-b border-border"
      role="status"
      data-testid="speleo-banner"
      data-kind={banner.kind}
    >
      <span>{confirmingEnable ? t('speleodb.banner.enableRenderingConfirm') : text}</span>
      <div className="flex items-center gap-3 flex-shrink-0">
        {/* #270: the retry verb needs the edit gate open. Read-only (a token loss,
            a re-verify divergence) makes an upload impossible, so offer the step
            that makes one possible instead of a button that cannot upload. */}
        {pushFailed &&
          (editing ? (
            <button
              type="button"
              onClick={retry}
              disabled={busy}
              className="text-xs underline disabled:opacity-50"
              data-testid="speleo-banner-retry-push"
            >
              {t('speleodb.banner.retryPush')}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => useUIStore.getState().openSpeleoWorkspace(useSpeleoStore.getState().session?.loggedIn ? undefined : 'account')}
              disabled={busy}
              className="text-xs underline disabled:opacity-50"
              data-testid="speleo-banner-start-editing-to-retry"
            >
              {t('speleodb.banner.startEditingToRetry')}
            </button>
          ))}
        {banner.kind === 'rendering_disabled' &&
          (confirmingEnable ? (
            <>
              <button
                type="button"
                onClick={() => void confirmEnable()}
                disabled={enabling}
                className="text-xs underline disabled:opacity-50"
                data-testid="speleo-banner-enable-rendering-confirm"
              >
                {enabling
                  ? t('speleodb.banner.enableRenderingBusy')
                  : t('speleodb.banner.enableRenderingConfirmAction')}
              </button>
              <button
                type="button"
                onClick={() => setConfirmingEnable(false)}
                disabled={enabling}
                className="text-xs underline disabled:opacity-50"
                data-testid="speleo-banner-enable-rendering-back"
              >
                {t('common.actions.cancel')}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingEnable(true)}
              className="text-xs underline"
              data-testid="speleo-banner-enable-rendering"
            >
              {t('speleodb.banner.enableRendering')}
            </button>
          ))}
        {/* `rendering_disabled` is server-derived, so it has no Dismiss (a refresh would
            just re-raise it): its resolution is Enable-rendering / the flag clearing.
            Every other kind is dismissable transient/action feedback. */}
        {banner.kind !== 'rendering_disabled' && (
          <button
            type="button"
            onClick={dismissBanner}
            className="text-xs underline"
            data-testid="speleo-banner-dismiss"
          >
            {t('common.actions.dismiss')}
          </button>
        )}
      </div>
    </div>
  );
}
