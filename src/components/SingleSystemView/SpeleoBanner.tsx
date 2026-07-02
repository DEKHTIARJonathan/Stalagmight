import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSpeleoStore } from '../../store/speleoStore';
import { useUIStore } from '../../store/uiStore';
import { humanizeSpeleoError } from '../../utils/speleoError';

/**
 * Thin banner slot below the toolbar for SpeleoDB status (#200/#204). It surfaces
 * one non-blocking notice at a time:
 * - `push_unconfirmed` / `concurrent_session` - transient action feedback (#204);
 * - `rendering_disabled` - the server's `exclude_geojson` is set, so the web map
 *   won't refresh; offers Enable-rendering (a PATCH that takes effect on the NEXT
 *   push, gated behind an inline confirmation stating exactly that);
 * - `no_anchor` - a push/unlock of a survey with no georeferenced zero datum, so the
 *   server generated no new map geometry (the map may be stale).
 * None of these block editing or pushing.
 */
export function SpeleoBanner() {
  const { t } = useTranslation();
  const banner = useSpeleoStore((s) => s.banner);
  const dismissBanner = useSpeleoStore((s) => s.dismissBanner);
  const enableRendering = useSpeleoStore((s) => s.enableRendering);
  const showToast = useUIStore((s) => s.showToast);
  // Inline second step for the Enable-rendering action (no single-click side effect
  // on server metadata; the confirm states rendering refreshes on the next push).
  const [confirmingEnable, setConfirmingEnable] = useState(false);
  const [enabling, setEnabling] = useState(false);

  if (!banner) return null;

  const text =
    banner.kind === 'push_unconfirmed'
      ? t('speleodb.banner.pushUnconfirmed')
      : banner.kind === 'rendering_disabled'
        ? t('speleodb.banner.renderingDisabled')
        : banner.kind === 'no_anchor'
          ? t('speleodb.banner.noAnchor')
          : t('speleodb.banner.concurrentSession');

  const confirmEnable = async () => {
    setEnabling(true);
    try {
      await enableRendering();
      // enableRendering clears the banner on success.
    } catch (e) {
      showToast(
        humanizeSpeleoError(e, t('speleodb.banner.enableRenderingFailed')),
        'speleodb-enable-rendering-error',
      );
    } finally {
      setEnabling(false);
      setConfirmingEnable(false);
    }
  };

  return (
    <div
      className="flex items-center justify-between gap-3 px-4 py-2 bg-warning-20 text-warning text-sm border-b border-border"
      data-testid="speleo-banner"
      data-kind={banner.kind}
    >
      <span>{confirmingEnable ? t('speleodb.banner.enableRenderingConfirm') : text}</span>
      <div className="flex items-center gap-3 flex-shrink-0">
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
        {!confirmingEnable && (
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
