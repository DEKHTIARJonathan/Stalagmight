import { useTranslation } from 'react-i18next';

/**
 * Export mode side panel (#38) — a stub. Export mode already shows the read-only
 * closure map in the center; this panel is the placeholder for the future SVG / JPG
 * export of that map (tracked as PR3 / later work). The format buttons are disabled
 * on purpose so the affordance is visible but clearly not yet wired.
 */
export function ExportPanel() {
  const { t } = useTranslation();
  return (
    <div
      className="h-full bg-panel flex flex-col overflow-auto text-sm text-text-primary"
      data-testid="export-panel"
    >
      <div className="px-3 py-2 border-b border-border shrink-0">
        <h2 className="font-semibold">{t('exportPanel.title')}</h2>
        <p className="text-xs opacity-70">{t('exportPanel.subtitle')}</p>
      </div>
      <div className="p-3 space-y-3">
        <p className="text-xs text-text-secondary">{t('exportPanel.description')}</p>
        <div className="flex gap-2">
          <button
            type="button"
            disabled
            className="text-xs px-3 py-1.5 rounded border border-border opacity-40 cursor-not-allowed"
            data-testid="export-svg-button"
          >
            {t('exportPanel.svg')}
          </button>
          <button
            type="button"
            disabled
            className="text-xs px-3 py-1.5 rounded border border-border opacity-40 cursor-not-allowed"
            data-testid="export-jpg-button"
          >
            {t('exportPanel.jpg')}
          </button>
        </div>
        <p className="text-xs opacity-60">{t('exportPanel.comingSoon')}</p>
      </div>
    </div>
  );
}
