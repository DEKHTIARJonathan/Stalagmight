import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { DialogWrapper } from './DialogWrapper';
import { Button } from '../common/Button';
import { useProjectStore } from '../../store/projectStore';
import { defaultConfig } from '../../types/config';
import { formatLength } from '../../utils/formatStats';
import { circularMeanDegrees } from '../../utils/angles';
import type { DmpFile, DmpShot } from '../../types/commands';
import type { DmpSelectionConfig } from './DmpSelectionDialog';

/**
 * Lightweight SVG preview of a section shape.
 * Avoids the cost of a full MapLibre instance per card.
 */
function SectionMiniPreview({ shots, size = 140 }: { shots: DmpShot[]; size?: number }) {
  const points = useMemo(() => {
    const stations: Array<{ x: number; y: number }> = [{ x: 0, y: 0 }];
    for (const shot of shots) {
      if (shot.shot_type !== 'Standard') continue;
      const prev = stations[stations.length - 1];
      if (!prev) continue;
      const azimuth = circularMeanDegrees(shot.heading_in, shot.heading_out);
      const rad = (azimuth * Math.PI) / 180;
      stations.push({
        x: prev.x + shot.length * Math.sin(rad),
        y: prev.y + shot.length * Math.cos(rad),
      });
    }
    return stations;
  }, [shots]);

  const svgPath = useMemo(() => {
    if (points.length < 2) return null;

    // Compute bounding box
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }

    const rangeX = maxX - minX || 1;
    const rangeY = maxY - minY || 1;
    const pad = 12;
    const drawSize = size - pad * 2;
    const scale = Math.min(drawSize / rangeX, drawSize / rangeY);

    // Map to SVG coords (flip Y since SVG Y goes down)
    const mapped = points.map((p) => ({
      x: pad + (p.x - minX) * scale + (drawSize - rangeX * scale) / 2,
      y: pad + (maxY - p.y) * scale + (drawSize - rangeY * scale) / 2,
    }));

    const d = mapped.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    return { d, first: mapped[0], last: mapped[mapped.length - 1] };
  }, [points, size]);

  return (
    <svg width={size} height={size} className="bg-background rounded border border-border">
      {svgPath ? (
        <>
          <path d={svgPath.d} fill="none" stroke="var(--cc-accent)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
          {svgPath.first && (
            <circle cx={svgPath.first.x} cy={svgPath.first.y} r={3} fill="var(--cc-accent)" />
          )}
          {svgPath.last && (
            <circle cx={svgPath.last.x} cy={svgPath.last.y} r={3} fill="var(--cc-accent)" />
          )}
        </>
      ) : (
        <text x={size / 2} y={size / 2} textAnchor="middle" dominantBaseline="middle" fill="var(--cc-text-secondary)" fontSize={12}>
          No shots
        </text>
      )}
    </svg>
  );
}

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
      bodyClassName="flex-1 flex flex-col p-4 min-h-0"
      data-testid="zero-datum-selection-dialog"
    >
      <p className="text-sm text-text-secondary mb-4 px-1 shrink-0">
        {t('dialogs.zeroDatumSelection.subtitle')}
      </p>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4 p-1">
          {selectedSections.map(({ index, section, shotCount, totalLength }) => (
            <button
              key={index}
              type="button"
              onClick={() => onSelectSection(index)}
              className="flex flex-col items-center gap-2 p-3 bg-panel border border-border rounded-lg cursor-pointer transition-colors hover:border-accent focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              data-testid={`zero-datum-section-card-${index}`}
            >
              <SectionMiniPreview shots={section.shots} size={140} />
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

      <div className="flex justify-start gap-2 pt-4 border-t border-border mt-2 shrink-0">
        <Button variant="secondary" onClick={onCancel} data-testid="zero-datum-selection-cancel">
          {t('common.actions.cancel')}
        </Button>
        <Button variant="secondary" onClick={onBack} data-testid="zero-datum-selection-back">
          {t('common.actions.back')}
        </Button>
      </div>
    </DialogWrapper>
  );
}
