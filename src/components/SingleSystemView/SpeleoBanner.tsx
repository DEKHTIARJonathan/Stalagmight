import { useTranslation } from 'react-i18next';
import { useSpeleoStore } from '../../store/speleoStore';

/**
 * Thin banner slot below the toolbar for SpeleoDB status (#200 seam). For now it
 * surfaces only the two states #204 already produces - a `push_unconfirmed`
 * result (retry Done) and a `concurrent_session` notice. #200 owns the richer set
 * (offline, stale lock, sync-needed) by writing to the same `speleoStore.banner`
 * field, so this component and the store shape don't need to change then.
 */
export function SpeleoBanner() {
  const { t } = useTranslation();
  const banner = useSpeleoStore((s) => s.banner);
  const dismissBanner = useSpeleoStore((s) => s.dismissBanner);

  if (!banner) return null;

  const text =
    banner.kind === 'push_unconfirmed'
      ? t('speleodb.banner.pushUnconfirmed')
      : t('speleodb.banner.concurrentSession');

  return (
    <div
      className="flex items-center justify-between gap-3 px-4 py-2 bg-warning-20 text-warning text-sm border-b border-border"
      data-testid="speleo-banner"
      data-kind={banner.kind}
    >
      <span>{text}</span>
      <button
        type="button"
        onClick={dismissBanner}
        className="text-xs underline flex-shrink-0"
        data-testid="speleo-banner-dismiss"
      >
        {t('common.actions.dismiss')}
      </button>
    </div>
  );
}
