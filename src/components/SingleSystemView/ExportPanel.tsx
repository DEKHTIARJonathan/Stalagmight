import { useTranslation } from 'react-i18next';
import ExportControls from '../Dialogs/ExportControls';
import { useExportStore } from '../../store/exportStore';

/**
 * Export mode side panel (#38 / #239). Hosts the shared {@link ExportControls}
 * inline (no modal) backed by the {@link useExportStore} so the large WYSIWYG
 * preview in the map area mirrors these options live.
 */
export function ExportPanel() {
  const { t } = useTranslation();
  const exportType = useExportStore((s) => s.exportType);
  const setExportType = useExportStore((s) => s.setExportType);
  const dataFormat = useExportStore((s) => s.dataFormat);
  const setDataFormat = useExportStore((s) => s.setDataFormat);
  const imageOptions = useExportStore((s) => s.imageOptions);
  const setImageOptions = useExportStore((s) => s.setImageOptions);

  return (
    <div
      className="h-full bg-panel flex flex-col overflow-auto text-sm text-text-primary"
      data-testid="export-panel"
    >
      <div className="px-3 py-2 border-b border-border shrink-0">
        <h2 className="font-semibold">{t('exportPanel.title')}</h2>
        <p className="text-xs opacity-70">{t('exportPanel.subtitle')}</p>
      </div>
      <div className="p-3">
        <ExportControls
          variant="panel"
          exportType={exportType}
          onExportTypeChange={setExportType}
          dataFormat={dataFormat}
          onDataFormatChange={setDataFormat}
          imageOptions={imageOptions}
          onImageOptionsChange={setImageOptions}
        />
      </div>
    </div>
  );
}
