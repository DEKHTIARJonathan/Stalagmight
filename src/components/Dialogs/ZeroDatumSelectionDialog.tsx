import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { DialogWrapper } from './DialogWrapper';
import SectionPreview from './SectionPreview';
import { Button } from '../common/Button';
import { useProjectStore } from '../../store/projectStore';
import { defaultConfig } from '../../types/config';
import { formatLength } from '../../utils/formatStats';
import type { DmpFile } from '../../types/commands';
import type { DmpSelectionConfig } from './DmpSelectionDialog';

interface ZeroDatumSelectionDialogProps {
  dmpFile: DmpFile;
  selectionConfig: DmpSelectionConfig;
  filePath: string;
  onCancel: () => void;
  onBack: () => void;
  onSelectSection: (sectionIndex: number) => void;
}

export default function ZeroDatumSelectionDialog({
  dmpFile,
  selectionConfig,
  filePath: _filePath,
  onCancel,
  onBack,
  onSelectSection,
}: ZeroDatumSelectionDialogProps) {
  const { t } = useTranslation();
  const config = useProjectStore((s) => s.config);
  const lengthUnit = config?.units?.length ?? defaultConfig.units.length;

  const selectedSections = useMemo(() => {
    return Array.from(selectionConfig.selectedIndices)
      .sort((a, b) => a - b)
      .map((idx) => {
        const section = dmpFile.sections[idx];
        if (!section) return null;

        const standardShots = section.shots.filter((s) => s.shot_type === 'Standard');
        const totalLength = standardShots.reduce((sum, s) => sum + (s.length >= 0 ? s.length : 0), 0);

        return {
          index: idx,
          section,
          shotCount: standardShots.length,
          totalLength,
        };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);
  }, [dmpFile.sections, selectionConfig.selectedIndices]);

  return (
    <DialogWrapper
      title={t('dialogs.zeroDatumSelection.title')}
      onClose={onCancel}
      size="4xl"
      overflow="hidden"
      data-testid="zero-datum-selection-dialog"
    >
      <div className="flex flex-col h-full min-h-0">
        <p className="text-sm text-text-secondary mb-4 px-1 shrink-0">
          {t('dialogs.zeroDatumSelection.subtitle')}
        </p>

        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4 p-1">
            {selectedSections.map(({ index, section, shotCount, totalLength }) => (
              <button
                key={index}
                type="button"
                onClick={() => onSelectSection(index)}
                className="flex flex-col items-center gap-2 p-3 bg-panel border border-border rounded-lg cursor-pointer transition-colors hover:border-accent focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                data-testid={`zero-datum-section-card-${index}`}
              >
                <SectionPreview section={section} size={180} />
                <span className="text-sm font-medium text-text-primary">{section.name}</span>
                <span className="text-xs text-text-secondary">
                  {t('dialogs.zeroDatumSelection.shotCount', { count: shotCount })}
                  {' \u00b7 '}
                  {t('dialogs.zeroDatumSelection.totalLength', {
                    length: formatLength(totalLength, lengthUnit),
                  })}
                </span>
                {section.date && (
                  <span className="text-xs text-text-secondary">
                    {section.date.split(/[T ]/)[0]}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        <div className="flex justify-start gap-2 pt-4 border-t border-border mt-4 shrink-0">
          <Button variant="secondary" onClick={onCancel} data-testid="zero-datum-selection-cancel">
            {t('common.actions.cancel')}
          </Button>
          <Button variant="secondary" onClick={onBack} data-testid="zero-datum-selection-back">
            {t('common.actions.back')}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
