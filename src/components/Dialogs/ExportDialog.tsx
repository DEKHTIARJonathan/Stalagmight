import { useState } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { Button } from '../common/Button';
import type { ExportImageOptions, ImageFormat } from '../../types/commands';

export default function ExportDialog() {
  const { closeDialog } = useUIStore();
  const { exportCsv, exportJson, exportImage } = useProjectStore();

  const [exportType, setExportType] = useState<'data' | 'image'>('data');
  const [dataFormat, setDataFormat] = useState<'csv' | 'json'>('csv');
  const [imageFormat, setImageFormat] = useState<ImageFormat>('png');
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
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={closeDialog} />

      <div role="dialog" aria-modal="true" aria-labelledby="dialog-title" className="relative bg-panel border border-border rounded-lg shadow-xl max-w-md w-full mx-4">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 id="dialog-title" className="text-lg font-medium">Export</h2>
          <button onClick={closeDialog} className="text-text-secondary hover:text-text-primary text-xl">
            ×
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* Export type */}
          <div>
            <label className="block text-sm text-text-secondary mb-2">Export Type</label>
            <div className="flex gap-4">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={exportType === 'data'}
                  onChange={() => setExportType('data')}
                />
                <span>Survey Data</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={exportType === 'image'}
                  onChange={() => setExportType('image')}
                />
                <span>Map Image</span>
              </label>
            </div>
          </div>

          {/* Data format options */}
          {exportType === 'data' && (
            <div>
              <label className="block text-sm text-text-secondary mb-2">Format</label>
              <select
                value={dataFormat}
                onChange={(e) => setDataFormat(e.target.value as 'csv' | 'json')}
                className="w-full"
              >
                <option value="csv">CSV</option>
                <option value="json">JSON</option>
              </select>
            </div>
          )}

          {/* Image format options */}
          {exportType === 'image' && (
            <>
              <div>
                <label className="block text-sm text-text-secondary mb-2">Format</label>
                <select
                  value={imageFormat}
                  onChange={(e) => setImageFormat(e.target.value as ImageFormat)}
                  className="w-full"
                >
                  <option value="png">PNG</option>
                  <option value="svg">SVG</option>
                  <option value="pdf">PDF</option>
                </select>
              </div>

              <div>
                <label className="block text-sm text-text-secondary mb-2">Options</label>
                <div className="space-y-2">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={imageOptions.include_labels}
                      onChange={(e) => setImageOptions({ ...imageOptions, include_labels: e.target.checked })}
                    />
                    <span>Include station labels</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={imageOptions.include_section_names}
                      onChange={(e) => setImageOptions({ ...imageOptions, include_section_names: e.target.checked })}
                    />
                    <span>Include section names</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={imageOptions.include_grid}
                      onChange={(e) => setImageOptions({ ...imageOptions, include_grid: e.target.checked })}
                    />
                    <span>Include grid</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={imageOptions.include_shot_data}
                      onChange={(e) => setImageOptions({ ...imageOptions, include_shot_data: e.target.checked })}
                    />
                    <span>Include shot data</span>
                  </label>
                </div>
              </div>

              {imageFormat === 'png' && (
                <div>
                  <label className="block text-sm text-text-secondary mb-2">Resolution</label>
                  <select
                    value={imageOptions.dpi}
                    onChange={(e) => setImageOptions({ ...imageOptions, dpi: parseInt(e.target.value) })}
                    className="w-full"
                  >
                    <option value="72">Low (72 DPI)</option>
                    <option value="150">Medium (150 DPI)</option>
                    <option value="300">High (300 DPI)</option>
                  </select>
                </div>
              )}
            </>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-4 border-t border-border">
            <Button onClick={closeDialog}>Cancel</Button>
            <Button variant="primary" onClick={handleExport}>
              Export
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
