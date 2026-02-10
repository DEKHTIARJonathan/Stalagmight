import { useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { DialogWrapper } from './DialogWrapper';
import SectionPreview from './SectionPreview';
import { Button } from '../common/Button';
import { Select } from '../common/Select';
import { SectionMetadataForm } from '../common/SectionMetadataForm';
import { ShotTableEditor, type EditableShot } from '../common/ShotTableEditor';
import { parseGps, detectFormat, type GpsFormat } from '../../utils/gps';
import { formatFixed } from '../../i18n/format';
import { convertToEditableShots } from '../../hooks/useImportState';
import { useDecimalPrecision } from '../../hooks/useDecimalPrecision';
import type { DmpFile } from '../../types/commands';
import type { DmpSelectionConfig } from './DmpSelectionDialog';
import type { GpsCoordinates } from '../../types/project';

export interface ZeroDatumConfigResult {
  sectionIndex: number;
  stationIndex: number;
  gps: GpsCoordinates;
  metadata: {
    name: string;
    surveyor: string | null;
    date: string | null;
    color: string;
    direction: 'in' | 'out';
    quality: number;
  };
  shots: EditableShot[];
}

const SECTION_COLORS = [
  '#4ecdc4', '#ff6b6b', '#95a5a6', '#3498db',
  '#9b59b6', '#1abc9c', '#e67e22', '#f39c12',
];

interface ZeroDatumConfigDialogProps {
  dmpFile: DmpFile;
  selectionConfig: DmpSelectionConfig;
  sectionIndex: number;
  filePath: string;
  onCancel: () => void;
  onBack: () => void;
  onConfirm: (result: ZeroDatumConfigResult) => void;
}

export default function ZeroDatumConfigDialog({
  dmpFile,
  selectionConfig,
  sectionIndex,
  filePath: _filePath,
  onCancel,
  onBack,
  onConfirm,
}: ZeroDatumConfigDialogProps) {
  const { t } = useTranslation();
  const precision = useDecimalPrecision();

  const section = dmpFile.sections[sectionIndex];

  // Figure out the color index based on position in selected indices
  const colorIndex = useMemo(() => {
    const sorted = Array.from(selectionConfig.selectedIndices).sort((a, b) => a - b);
    return sorted.indexOf(sectionIndex);
  }, [selectionConfig.selectedIndices, sectionIndex]);

  // Station selection
  const [stationIndex, setStationIndex] = useState(0);

  // GPS input state
  const [gpsInput, setGpsInput] = useState('');
  const [gpsCoords, setGpsCoords] = useState<GpsCoordinates | null>(null);
  const [gpsFormat, setGpsFormat] = useState<GpsFormat | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);

  // Metadata state
  const [name, setName] = useState(section?.name ?? '');
  const [surveyor, setSurveyor] = useState(selectionConfig.defaultSurveyor || '');
  const [date, setDate] = useState(
    selectionConfig.defaultDate ?? section?.date?.split(/[T ]/)[0] ?? ''
  );
  const [color, setColor] = useState(SECTION_COLORS[colorIndex % SECTION_COLORS.length] ?? '#4ecdc4');
  const [direction, setDirection] = useState<'in' | 'out'>(section?.direction === 'out' ? 'out' : 'in');
  const [quality, setQuality] = useState(1.0);

  // Shots state
  const [shots, setShots] = useState<EditableShot[]>(() =>
    section ? convertToEditableShots(section.shots) : []
  );
  const [nextTempId, setNextTempId] = useState(() => shots.length + 1);

  // Station count = standard shots + 1
  const stationCount = useMemo(() => {
    return shots.filter((s) => !s.isDeleted).length + 1;
  }, [shots]);

  // Station options for the Select component
  const stationOptions = useMemo(() => {
    return Array.from({ length: stationCount }, (_, i) => ({
      value: String(i),
      label: `Station ${i}`,
    }));
  }, [stationCount]);

  // GPS input handler
  const handleGpsInputChange = useCallback((value: string) => {
    setGpsInput(value);
    if (!value.trim()) {
      setGpsCoords(null);
      setGpsFormat(null);
      setGpsError(null);
      return;
    }
    const detected = detectFormat(value);
    setGpsFormat(detected || null);
    const result = parseGps(value);
    if ('coordinates' in result) {
      setGpsCoords(result.coordinates);
      setGpsError(null);
    } else {
      setGpsCoords(null);
      setGpsError(result.message);
    }
  }, []);

  // Shot editing handlers
  const handleShotChange = useCallback(
    (index: number, field: keyof EditableShot, value: number | string | boolean | null) => {
      setShots((prev) => {
        const newShots = [...prev];
        const shot = newShots[index];
        if (shot) {
          newShots[index] = { ...shot, [field]: value };
        }
        return newShots;
      });
    },
    []
  );

  const handleAddShot = useCallback(() => {
    setShots((prev) => [
      ...prev,
      {
        id: -nextTempId,
        azimuth_in: 0,
        azimuth_out: 0,
        length: 0,
        depth_in: 0,
        depth_out: 0,
        pitch_in: null,
        pitch_out: null,
        left: null,
        right: null,
        up: null,
        down: null,
        comment: null,
        is_reference: false,
        isNew: true,
        tempId: nextTempId,
      },
    ]);
    setNextTempId((prev) => prev + 1);
  }, [nextTempId]);

  const handleDeleteShot = useCallback((index: number) => {
    setShots((prev) => {
      const newShots = [...prev];
      const shot = newShots[index];
      if (shot) {
        newShots[index] = { ...shot, isDeleted: true };
      }
      return newShots;
    });
  }, []);

  const handleInsertBefore = useCallback(
    (index: number) => {
      setShots((prev) => {
        const newShots = [...prev];
        newShots.splice(index, 0, {
          id: -nextTempId,
          azimuth_in: 0,
          azimuth_out: 0,
          length: 0,
          depth_in: 0,
          depth_out: 0,
          pitch_in: null,
          pitch_out: null,
          left: null,
          right: null,
          up: null,
          down: null,
          comment: null,
          is_reference: false,
          isNew: true,
          tempId: nextTempId,
        });
        return newShots;
      });
      setNextTempId((prev) => prev + 1);
    },
    [nextTempId]
  );

  const handleInsertAfter = useCallback(
    (index: number) => {
      setShots((prev) => {
        const newShots = [...prev];
        newShots.splice(index + 1, 0, {
          id: -nextTempId,
          azimuth_in: 0,
          azimuth_out: 0,
          length: 0,
          depth_in: 0,
          depth_out: 0,
          pitch_in: null,
          pitch_out: null,
          left: null,
          right: null,
          up: null,
          down: null,
          comment: null,
          is_reference: false,
          isNew: true,
          tempId: nextTempId,
        });
        return newShots;
      });
      setNextTempId((prev) => prev + 1);
    },
    [nextTempId]
  );

  const handleConfirm = useCallback(() => {
    if (!gpsCoords) return;
    onConfirm({
      sectionIndex,
      stationIndex,
      gps: gpsCoords,
      metadata: {
        name,
        surveyor: surveyor || null,
        date: date || null,
        color,
        direction,
        quality,
      },
      shots,
    });
  }, [gpsCoords, onConfirm, sectionIndex, stationIndex, name, surveyor, date, color, direction, quality, shots]);

  if (!section) return null;

  return (
    <DialogWrapper
      title={t('dialogs.zeroDatumConfig.title')}
      onClose={onCancel}
      size="5xl"
      overflow="hidden"
      fixedSize={{ width: 'min(1100px, 95vw)', height: 'min(800px, 90vh)' }}
      data-testid="zero-datum-config-dialog"
    >
      <div className="flex h-full min-h-0 gap-4">
        {/* Left column: Preview */}
        <div className="shrink-0 flex flex-col items-center" style={{ width: 380 }}>
          <SectionPreview
            section={section}
            color={color}
            size={350}
            onStationClick={setStationIndex}
            selectedStationIndex={stationIndex}
          />
        </div>

        {/* Right column: Configuration */}
        <div className="flex-1 min-w-0 overflow-y-auto space-y-5 pr-1">
          {/* Station selection */}
          <div className="flex items-center gap-2">
            <label className="text-sm text-text-secondary w-16 shrink-0">
              {t('dialogs.zeroDatumConfig.stationLabel')}:
            </label>
            <Select
              value={String(stationIndex)}
              onChange={(v) => setStationIndex(parseInt(v, 10))}
              options={stationOptions}
              className="flex-1"
              data-testid="zero-datum-station-select"
            />
          </div>

          {/* GPS input */}
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <label className="text-sm text-text-secondary w-16 shrink-0">
                {t('dialogs.zeroDatumConfig.gpsLabel')}:
              </label>
              <input
                type="text"
                value={gpsInput}
                onChange={(e) => handleGpsInputChange(e.target.value)}
                placeholder={t('dialogs.zeroDatumConfig.gpsPlaceholder')}
                className="flex-1 px-2 py-1 bg-background border border-border rounded text-sm"
                data-testid="zero-datum-gps-input"
              />
              {gpsFormat && (
                <span
                  className="text-xs px-2 py-1 bg-accent-10 text-accent rounded"
                  data-testid="zero-datum-gps-format"
                >
                  {gpsFormat}
                </span>
              )}
            </div>
            {gpsError && (
              <div className="text-xs text-error ml-[72px]" data-testid="zero-datum-gps-error">
                {gpsError}
              </div>
            )}
            {gpsCoords && (
              <div className="text-xs text-success ml-[72px]" data-testid="zero-datum-gps-parsed">
                Lat: {formatFixed(gpsCoords.latitude, undefined, precision.gps)}, Lon:{' '}
                {formatFixed(gpsCoords.longitude, undefined, precision.gps)}
              </div>
            )}
          </div>

          {/* Metadata form */}
          <div>
            <h3 className="text-sm font-medium text-text-primary mb-2">
              {t('dialogs.zeroDatumConfig.metadataHeading')}
            </h3>
            <SectionMetadataForm
              name={name}
              surveyor={surveyor}
              date={date}
              color={color}
              direction={direction}
              quality={quality}
              onNameChange={setName}
              onSurveyorChange={setSurveyor}
              onDateChange={setDate}
              onColorChange={setColor}
              onDirectionChange={setDirection}
              onQualityChange={setQuality}
              showDirection
              showQuality
            />
          </div>

          {/* Shot table */}
          <div>
            <h3 className="text-sm font-medium text-text-primary mb-2">
              {t('dialogs.zeroDatumConfig.shotsHeading')}
            </h3>
            <ShotTableEditor
              shots={shots}
              onShotChange={handleShotChange}
              onAddShot={handleAddShot}
              onDeleteShot={handleDeleteShot}
              onInsertBefore={handleInsertBefore}
              onInsertAfter={handleInsertAfter}
            />
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="flex justify-between items-center pt-4 border-t border-border mt-4 shrink-0">
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onCancel} data-testid="zero-datum-config-cancel">
            {t('common.actions.cancel')}
          </Button>
          <Button variant="secondary" onClick={onBack} data-testid="zero-datum-config-back">
            {t('common.actions.back')}
          </Button>
        </div>
        <Button
          variant="primary"
          onClick={handleConfirm}
          disabled={!gpsCoords}
          data-testid="zero-datum-config-confirm"
        >
          {t('dialogs.zeroDatumConfig.confirm')}
        </Button>
      </div>
    </DialogWrapper>
  );
}
