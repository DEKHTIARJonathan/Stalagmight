import { useState, useEffect, useCallback, useMemo } from 'react';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';
import type { TmlFile } from '../../types/commands';

interface TmlImportDialogProps {
  tmlFile: TmlFile;
  filePath: string;
}

export default function TmlImportDialog({ tmlFile, filePath }: TmlImportDialogProps) {
  const { executeTmlImport, calculateFileHash, checkDuplicateImport } = useProjectStore();
  const { closeDialog, openDialog, setView, triggerFitToBounds } = useUIStore();

  const [isImporting, setIsImporting] = useState(false);
  const [fileHash, setFileHash] = useState<string | null>(null);
  const [isDuplicate, setIsDuplicate] = useState(false);
  const [hashChecked, setHashChecked] = useState(false);

  // Check for duplicate import on mount
  useEffect(() => {
    (async () => {
      try {
        const hash = await calculateFileHash(filePath);
        setFileHash(hash);
        const dup = await checkDuplicateImport(hash);
        setIsDuplicate(dup);
      } catch {
        // Non-fatal: proceed without duplicate detection
      }
      setHashChecked(true);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fileName = useMemo(() => {
    return filePath.split(/[/\\]/).pop() ?? filePath;
  }, [filePath]);

  const stats = useMemo(() => {
    let totalShots = 0;
    let totalLength = 0;
    let minDepth = Infinity;
    let maxDepth = -Infinity;

    for (const section of tmlFile.sections) {
      totalShots += section.shots.length;
      for (const shot of section.shots) {
        totalLength += shot.length;
        if (shot.depth < minDepth) minDepth = shot.depth;
        if (shot.depth > maxDepth) maxDepth = shot.depth;
      }
    }

    return {
      totalShots,
      totalLength: Math.round(totalLength * 10) / 10,
      depthRange:
        minDepth === Infinity
          ? null
          : `${Math.round(minDepth * 10) / 10} - ${Math.round(maxDepth * 10) / 10}`,
    };
  }, [tmlFile]);

  const handleImport = useCallback(async () => {
    setIsImporting(true);
    try {
      const result = await executeTmlImport(filePath, fileHash);

      closeDialog();
      setView('single');
      triggerFitToBounds();

      if (!result.success) {
        openDialog('error', {
          title: 'Import Errors',
          message: result.error ?? 'Unknown error during import',
        });
      }
    } catch (e) {
      setIsImporting(false);
      openDialog('error', {
        title: 'Import Failed',
        message: e instanceof Error ? e.message : 'Failed to import TML file',
      });
    }
  }, [executeTmlImport, filePath, fileHash, closeDialog, openDialog, setView, triggerFitToBounds]);

  return (
    <DialogWrapper title="Import Ariane Survey" onClose={closeDialog} size="lg" data-testid="tml-import-dialog">
      <div className="space-y-4">
        {/* Header info */}
        <div className="space-y-1">
          <div className="text-sm text-text-secondary">{fileName}</div>
          {tmlFile.cave_name && (
            <div className="text-lg font-medium">{tmlFile.cave_name}</div>
          )}
          {tmlFile.unit === 'Imperial' && (
            <div className="text-xs text-text-tertiary">
              Converted from imperial to metric
            </div>
          )}
        </div>

        {/* Summary stats */}
        <div className="grid grid-cols-4 gap-3 p-3 bg-surface-alt rounded">
          <div>
            <div className="text-xs text-text-tertiary">Sections</div>
            <div className="text-sm font-medium">{tmlFile.sections.length}</div>
          </div>
          <div>
            <div className="text-xs text-text-tertiary">Shots</div>
            <div className="text-sm font-medium">{stats.totalShots}</div>
          </div>
          <div>
            <div className="text-xs text-text-tertiary">Total length</div>
            <div className="text-sm font-medium">{stats.totalLength} m</div>
          </div>
          <div>
            <div className="text-xs text-text-tertiary">Depth range</div>
            <div className="text-sm font-medium">{stats.depthRange ?? '-'}</div>
          </div>
        </div>

        {/* Section list */}
        <div className="max-h-64 overflow-y-auto border border-border rounded">
          <table className="w-full text-sm">
            <thead className="bg-surface-alt sticky top-0">
              <tr className="text-left text-text-tertiary text-xs">
                <th className="px-3 py-1.5">Section</th>
                <th className="px-3 py-1.5">Shots</th>
                <th className="px-3 py-1.5">Surveyor</th>
                <th className="px-3 py-1.5">Date</th>
                <th className="px-3 py-1.5 w-6">Color</th>
              </tr>
            </thead>
            <tbody>
              {tmlFile.sections.map((section, i) => (
                <tr
                  key={i}
                  className="border-t border-border"
                >
                  <td className="px-3 py-1.5">
                    {section.name}
                    {section.is_branch_split && (
                      <span className="ml-1 text-xs text-text-tertiary">(branch)</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5">{section.shots.length}</td>
                  <td className="px-3 py-1.5 text-text-secondary">{section.surveyor ?? '-'}</td>
                  <td className="px-3 py-1.5 text-text-secondary">{section.date ?? '-'}</td>
                  <td className="px-3 py-1.5">
                    <div
                      className="w-4 h-4 rounded"
                      style={{ backgroundColor: section.color }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Closures info */}
        {tmlFile.closures.length > 0 && (
          <div className="text-xs text-text-secondary">
            {tmlFile.closures.length} loop closure{tmlFile.closures.length !== 1 ? 's' : ''} detected
          </div>
        )}

        {/* Warnings */}
        {isDuplicate && hashChecked && (
          <div className="p-3 bg-warning-10 border border-warning-20 rounded text-sm">
            This file has already been imported to this project. Importing again will create duplicate sections.
          </div>
        )}

        {/* Footer */}
        <div className="flex justify-end gap-2 pt-4 border-t border-border">
          <Button onClick={closeDialog}>Cancel</Button>
          <Button
            data-primary-action=""
            data-testid="tml-import-confirm"
            onClick={handleImport}
            disabled={isImporting || !hashChecked}
          >
            {isImporting ? 'Importing...' : 'Import'}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
