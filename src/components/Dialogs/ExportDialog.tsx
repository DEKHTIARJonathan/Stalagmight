import { useState, useCallback } from 'react';
import { useUIStore } from '../../store/uiStore';
import { DialogWrapper } from './DialogWrapper';
import ExportControls from './ExportControls';
import { DEFAULT_IMAGE_OPTIONS } from '../../store/exportStore';
import type { ExportType, DataFormat } from '../../store/exportStore';
import type { ExportImageOptions } from '../../types/commands';

/**
 * Modal Export dialog (reached from the project menu / Ctrl+E). A thin
 * `DialogWrapper` around the shared {@link ExportControls}. Keeps its OWN local
 * state — defaulting to the data/CSV selection its e2e suite asserts — rather
 * than the Export-mode `exportStore` (that store is panel + center only).
 */
export default function ExportDialog() {
  const { closeDialog } = useUIStore();
  const [exportType, setExportType] = useState<ExportType>('data');
  const [dataFormat, setDataFormat] = useState<DataFormat>('csv');
  const [imageOptions, setImageOptions] = useState<ExportImageOptions>(DEFAULT_IMAGE_OPTIONS);
  const [isExporting, setIsExporting] = useState(false);

  // No-op while exporting so the dialog can't be dismissed mid-export.
  const handleClose = useCallback(() => {
    if (!isExporting) {
      closeDialog();
    }
  }, [isExporting, closeDialog]);

  return (
    <DialogWrapper title="Export" onClose={handleClose} size="lg" data-testid="export-dialog">
      <ExportControls
        variant="dialog"
        exportType={exportType}
        onExportTypeChange={setExportType}
        dataFormat={dataFormat}
        onDataFormatChange={setDataFormat}
        imageOptions={imageOptions}
        onImageOptionsChange={setImageOptions}
        onComplete={closeDialog}
        onExportingChange={setIsExporting}
      />
    </DialogWrapper>
  );
}
