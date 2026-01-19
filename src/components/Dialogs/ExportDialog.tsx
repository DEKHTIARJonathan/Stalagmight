import { useState } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { Button } from '../common/Button';
import { Select } from '../common/Select';
import { DialogWrapper } from './DialogWrapper';
import ExportPreview, { type ExportTheme } from './ExportPreview';
import type { ExportImageOptions, ImageFormat } from '../../types/commands';

export default function ExportDialog() {
  const { closeDialog } = useUIStore();
  const { exportCsv, exportJson, exportImage } = useProjectStore();

  const [exportType, setExportType] = useState<'data' | 'image'>('data');
  const [dataFormat, setDataFormat] = useState<'csv' | 'json'>('csv');
  const [imageFormat, setImageFormat] = useState<ImageFormat>('png');
  const [previewTheme, setPreviewTheme] = useState<ExportTheme>('dark');
  const [imageOptions, setImageOptions] = useState<ExportImageOptions>({
    format: 'png',
    dpi: 300,
    include_satellite: false,
    include_grid: false,
    include_labels: true,
    include_section_names: true,
    include_shot_data: false,
  });

  const handleExport = async () => {
    try {
      if (exportType === 'data') {
        const extension = dataFormat;
        const selected = await save({
          filters: [{ name: dataFormat.toUpperCase(), extensions: [extension] }],
        });

        if (selected) {
          if (dataFormat === 'csv') {
            await exportCsv(selected);
          } else {
            await exportJson(selected);
          }
        }
      } else {
        const extension = imageFormat;
        const selected = await save({
          filters: [{ name: imageFormat.toUpperCase(), extensions: [extension] }],
        });

        if (selected) {
          await exportImage(selected, { ...imageOptions, format: imageFormat });
        }
      }

      closeDialog();
    } catch (e) {
      console.error('Export failed:', e);
    }
  };

  return (
    <DialogWrapper title="Export" onClose={closeDialog} size="lg" data-testid="export-dialog">
      <div className="flex gap-6">
        {/* Left column: Options */}
        <div className="flex-1 space-y-4">
          {/* Export type */}
          <div>
            <label className="block text-sm text-text-secondary mb-2">Export Type</label>
            <div className="flex gap-4">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={exportType === 'data'}
                  onChange={() => setExportType('data')}
                  data-testid="export-type-data"
                />
                <span>Survey Data</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={exportType === 'image'}
                  onChange={() => setExportType('image')}
                  data-testid="export-type-image"
                />
                <span>Map Image</span>
              </label>
            </div>
          </div>

          {/* Data format options */}
          {exportType === 'data' && (
            <div>
              <label className="block text-sm text-text-secondary mb-2">Format</label>
              <Select
                value={dataFormat}
                onChange={(v) => setDataFormat(v as 'csv' | 'json')}
                options={[
                  { value: 'csv', label: 'CSV' },
                  { value: 'json', label: 'JSON' },
                ]}
                data-testid="data-format-select"
              />
            </div>
          )}

          {/* Image format options */}
          {exportType === 'image' && (
            <>
              <div>
                <label className="block text-sm text-text-secondary mb-2">Format</label>
                <Select
                  value={imageFormat}
                  onChange={(v) => setImageFormat(v as ImageFormat)}
                  options={[
                    { value: 'png', label: 'PNG' },
                    { value: 'svg', label: 'SVG' },
                    { value: 'pdf', label: 'PDF' },
                  ]}
                  data-testid="image-format-select"
                />
              </div>

              <div>
                <label className="block text-sm text-text-secondary mb-2">Options</label>
                <div className="space-y-2">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={imageOptions.include_labels}
                      onChange={(e) => setImageOptions({ ...imageOptions, include_labels: e.target.checked })}
                      data-testid="option-include-labels"
                    />
                    <span>Include station labels</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={imageOptions.include_section_names}
                      onChange={(e) => setImageOptions({ ...imageOptions, include_section_names: e.target.checked })}
                      data-testid="option-include-section-names"
                    />
                    <span>Include section names</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={imageOptions.include_grid}
                      onChange={(e) => setImageOptions({ ...imageOptions, include_grid: e.target.checked })}
                      data-testid="option-include-grid"
                    />
                    <span>Include grid</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={imageOptions.include_shot_data}
                      onChange={(e) => setImageOptions({ ...imageOptions, include_shot_data: e.target.checked })}
                      data-testid="option-include-shot-data"
                    />
                    <span>Include shot data</span>
                  </label>
                </div>
              </div>

              {imageFormat === 'png' && (
                <div>
                  <label className="block text-sm text-text-secondary mb-2">Resolution</label>
                  <Select
                    value={String(imageOptions.dpi)}
                    onChange={(v) => setImageOptions({ ...imageOptions, dpi: parseInt(v) })}
                    options={[
                      { value: '72', label: 'Low (72 DPI)' },
                      { value: '150', label: 'Medium (150 DPI)' },
                      { value: '300', label: 'High (300 DPI)' },
                    ]}
                    data-testid="resolution-select"
                  />
                </div>
              )}
            </>
          )}
        </div>

        {/* Right column: Preview (only for image export) */}
        {exportType === 'image' && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-sm text-text-secondary">Preview</span>
              {/* Theme toggle */}
              <button
                type="button"
                onClick={() => setPreviewTheme(previewTheme === 'dark' ? 'light' : 'dark')}
                className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-border hover:bg-panel-hover transition-colors"
                data-testid="export-theme-toggle"
              >
                {previewTheme === 'dark' ? (
                  <>
                    <span>Dark</span>
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3">
                      <path fillRule="evenodd" d="M7.455 2.004a.75.75 0 0 1 .26.77 7 7 0 0 0 9.958 7.967.75.75 0 0 1 1.067.853A8.5 8.5 0 1 1 6.647 1.921a.75.75 0 0 1 .808.083Z" clipRule="evenodd" />
                    </svg>
                  </>
                ) : (
                  <>
                    <span>Light</span>
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3">
                      <path d="M10 2a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 10 2ZM10 15a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 10 15ZM10 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM15.657 5.404a.75.75 0 1 0-1.06-1.06l-1.061 1.06a.75.75 0 0 0 1.06 1.061l1.06-1.06ZM6.464 14.596a.75.75 0 1 0-1.06-1.06l-1.06 1.06a.75.75 0 0 0 1.06 1.06l1.06-1.06ZM18 10a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 18 10ZM5 10a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 5 10ZM14.596 15.657a.75.75 0 0 0 1.06-1.06l-1.06-1.061a.75.75 0 1 0-1.061 1.06l1.06 1.061ZM5.404 6.464a.75.75 0 0 0 1.06-1.06l-1.06-1.06a.75.75 0 1 0-1.061 1.06l1.06 1.06Z" />
                    </svg>
                  </>
                )}
              </button>
            </div>
            <ExportPreview options={imageOptions} theme={previewTheme} />
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex justify-end gap-2 pt-4 mt-4 border-t border-border">
        <Button onClick={closeDialog}>Cancel</Button>
        <Button variant="primary" onClick={handleExport} data-testid="export-button">
          Export
        </Button>
      </div>
    </DialogWrapper>
  );
}
