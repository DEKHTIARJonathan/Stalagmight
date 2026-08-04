import { useState, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { blockedByIncompleteShots, countIncompleteShots } from '../common/incompleteShots';
import { blankEditableShot } from '../common/editableShot';
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
import { editableShotsToDmpSection } from '../../utils/shotConversion';
import type { DmpFile } from '../../types/commands';
import type { DmpSelectionConfig } from './DmpSelectionDialog';
import type { GpsCoordinates } from '../../types/project';
import { sectionColorPalette } from '../../utils/colors';
import { useUIStore } from '../../store/uiStore';

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
    /** Reverse this section end-to-end on import (#24). */
    reverse: boolean;
  };
  shots: EditableShot[];
}

/** A blank row for the shot table, shared by the add and the two insert paths. */
/** The shared blank-row contract; `id` stays negative here as this dialog keys
 *  its rows by it. */
function makeNewShot(tempId: number): EditableShot {
  return { ...blankEditableShot(-tempId), tempId };
}

/**
 * How many surviving rows precede `arrayIndex`.
 *
 * `ShotTableEditor` hands its callbacks an index into the FULL `shots` array
 * (deleted rows included), while a station index counts only survivors, so the
 * two spaces have to be bridged before a pick can be re-anchored.
 */
function survivorsBefore(shots: EditableShot[], arrayIndex: number): number {
  let count = 0;
  for (let i = 0; i < arrayIndex && i < shots.length; i++) {
    if (!shots[i]?.isDeleted) count++;
  }
  return count;
}

/**
 * Keep a committed station pick on the same physical station across a shot edit.
 *
 * The pick addresses the POST-EDIT order (a section of `s` surviving shots has
 * stations `0..s`), so adding or removing a survivor renumbers every station
 * beyond it. `editPosition` is the survivor position the edit lands at:
 * deleting the shot there merges stations `editPosition` and `editPosition + 1`,
 * inserting there splits them. Stations at or before it keep their number.
 *
 * Re-anchoring on EDIT is what makes the pick correct in both orderings.
 * Translating on pick instead (the shape this dialog used to have) only moves
 * the breakage from delete-then-pick to pick-then-delete. This map is also
 * total, unlike an `EditableShot.id` lookup, so it can address a station that a
 * leading insert has only just created.
 */
function reanchorStation(
  pick: number,
  editPosition: number,
  delta: 1 | -1,
  survivorsAfter: number,
): number {
  const shifted = pick > editPosition ? pick + delta : pick;
  return Math.max(0, Math.min(survivorsAfter, shifted));
}

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
  const showToast = useUIStore((st) => st.showToast);
  const precision = useDecimalPrecision();

  const section = dmpFile.sections[sectionIndex];
  const resolvedTheme = useUIStore((s) => s.resolvedTheme);

  // Figure out the color index based on position in selected indices
  const colorIndex = useMemo(() => {
    const sorted = Array.from(selectionConfig.selectedIndices).sort((a, b) => a - b);
    return sorted.indexOf(sectionIndex);
  }, [selectionConfig.selectedIndices, sectionIndex]);

  const sectionPalette = useMemo(() => sectionColorPalette(resolvedTheme), [resolvedTheme]);

  // Station selection: stationIndex is the committed value, previewStationIndex
  // tracks what the map highlights (follows hover, reverts on dropdown close).
  // Expand grows the DIALOG, same as the other two shot-entry surfaces; the
  // editor only asks, the host owns its size.
  const [expanded, setExpanded] = useState(false);
  const [stationIndex, setStationIndex] = useState(0);
  const [previewStationIndex, setPreviewStationIndex] = useState(0);
  const stationIndexRef = useRef(0);

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
  const [color, setColor] = useState(sectionPalette[colorIndex % sectionPalette.length] ?? '#4ecdc4');
  const [direction, setDirection] = useState<'in' | 'out'>(section?.direction === 'out' ? 'out' : 'in');
  const [reverse, setReverse] = useState(false);

  // Shots state
  const [shots, setShots] = useState<EditableShot[]>(() =>
    section ? convertToEditableShots(section.shots) : []
  );
  const [nextTempId, setNextTempId] = useState(() => shots.length + 1);

  // Station count = surviving shots + 1
  const stationCount = useMemo(() => {
    return shots.filter((s) => !s.isDeleted).length + 1;
  }, [shots]);

  // The preview is drawn from the EDITED shots, not the file's original ones,
  // so a click on a station dot and a pick in the dropdown address the same
  // station. See `editableShotsToDmpSection` for why the raw section diverges
  // even before anything is deleted.
  const previewSection = useMemo(
    () => (section ? editableShotsToDmpSection(section, shots) : null),
    [section, shots],
  );

  /** Commit a station pick: the value sent, the map highlight and the hover-revert target. */
  const commitStation = useCallback((index: number) => {
    setStationIndex(index);
    setPreviewStationIndex(index);
    stationIndexRef.current = index;
  }, []);

  // Station options for the Select component
  const stationOptions = useMemo(() => {
    return Array.from({ length: stationCount }, (_, i) => ({
      value: String(i),
      label: `Station ${i}`,
    }));
  }, [stationCount]);

  // GPS origin for map preview - only set when valid GPS coordinates are entered
  const gpsOrigin = useMemo(() => {
    if (!gpsCoords) return null;
    return { latitude: gpsCoords.latitude, longitude: gpsCoords.longitude };
  }, [gpsCoords]);

  // When dropdown hovers an option, show it on the map; when dropdown closes
  // without selecting, revert to the committed station.
  const handleStationHover = useCallback((value: string | null) => {
    if (value !== null) {
      setPreviewStationIndex(parseInt(value, 10));
    } else {
      // Dropdown closed without selection - revert
      setPreviewStationIndex(stationIndexRef.current);
    }
  }, []);

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

  // The three shot-count mutators re-anchor the committed pick as they go, so
  // `stationIndex` always addresses the current, post-edit station order.
  const insertShotAt = useCallback(
    (arrayIndex: number) => {
      const survivors = shots.filter((s) => !s.isDeleted).length;
      const newShots = [...shots];
      newShots.splice(arrayIndex, 0, makeNewShot(nextTempId));
      setShots(newShots);
      setNextTempId((prev) => prev + 1);
      commitStation(
        reanchorStation(stationIndex, survivorsBefore(shots, arrayIndex), 1, survivors + 1),
      );
    },
    [shots, nextTempId, stationIndex, commitStation]
  );

  // Appending cannot renumber an existing station (the new one lands past every
  // pick), but it goes through the same path so the invariant has one owner.
  const handleAddShot = useCallback(() => insertShotAt(shots.length), [insertShotAt, shots.length]);

  /** Append `count` blank shots in ONE functional update, each with its own temp
   *  id. `insertShotAt` rebuilds from the closed-over `shots`, so calling it N
   *  times in one React event has every call overwrite the last. Appending never
   *  renumbers a station pick (the new rows land past every one), so this can go
   *  straight to state without the reanchoring that path does. */
  const handleAddShots = useCallback((count: number) => {
    const n = Math.max(1, count);
    setShots((prev) => [...prev, ...Array.from({ length: n }, (_, i) => makeNewShot(nextTempId + i))]);
    setNextTempId((prev) => prev + n);
  }, [nextTempId]);

  const handleInsertBefore = useCallback(
    (index: number) => insertShotAt(index),
    [insertShotAt]
  );

  const handleInsertAfter = useCallback(
    (index: number) => insertShotAt(index + 1),
    [insertShotAt]
  );

  const handleDeleteShot = useCallback(
    (index: number) => {
      const shot = shots[index];
      if (!shot || shot.isDeleted) return;
      const survivors = shots.filter((s) => !s.isDeleted).length;
      const newShots = [...shots];
      newShots[index] = { ...shot, isDeleted: true };
      setShots(newShots);
      commitStation(
        reanchorStation(stationIndex, survivorsBefore(shots, index), -1, survivors - 1),
      );
    },
    [shots, stationIndex, commitStation]
  );

  /** Rows that hold something but are not a usable shot - see countIncompleteShots. */
  const incompleteShots = useMemo(() => countIncompleteShots(shots), [shots]);

  const handleConfirm = useCallback(() => {
    if (!gpsCoords) return;
    if (blockedByIncompleteShots(incompleteShots, t, 'zero-datum-incomplete')) return;
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
        quality: 1.0,
        reverse,
      },
      shots,
    });
  }, [gpsCoords, onConfirm, sectionIndex, stationIndex, name, surveyor, date, color, direction, reverse, shots, incompleteShots, showToast, t]);

  if (!section) return null;

  return (
    <DialogWrapper
      title={t('dialogs.zeroDatumConfig.title')}
      onClose={onCancel}
      size={expanded ? 'fullscreen' : '5xl'}
      overflow="hidden"
      {...(expanded
        ? {}
        : { fixedSize: { width: 'min(1100px, 95vw)', height: 'min(800px, 90vh)' } })}
      bodyClassName="flex-1 flex flex-col p-0 min-h-0"
      closeOnBackdropClick={false}
      data-testid="zero-datum-config-dialog"
    >
      {/* Scrollable content area */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Left column: Preview (fixed) */}
        <div
          className="shrink-0 flex flex-col items-center p-4 border-r border-border"
          style={{ width: 380 }}
          data-testid="zero-datum-preview-map"
        >
          <SectionPreview
            section={previewSection}
            color={color}
            size={340}
            onStationClick={commitStation}
            selectedStationIndex={previewStationIndex}
            gpsOrigin={gpsOrigin}
            gpsStationIndex={stationIndex}
          />
        </div>

        {/* Right column: Configuration (scrollable) */}
        <div
          className={`flex-1 min-w-0 p-4 space-y-5 ${
            // Expanded, the column stops scrolling as a whole so the shot table
            // can own the leftover height; collapsed it scrolls as before.
            expanded ? 'flex min-h-0 flex-col overflow-hidden' : 'overflow-y-auto'
          }`}
          data-testid="zero-datum-config-right-pane"
        >
          {/* Zero Datum Location - prominent card */}
          <div className="rounded-lg border border-accent/30 bg-accent/5 p-4 space-y-3">
            <div>
              <h3 className="text-sm font-semibold text-text-primary">
                {t('dialogs.zeroDatumConfig.zeroDatumHeading')}
              </h3>
              <p className="text-xs text-text-secondary mt-0.5">
                {t('dialogs.zeroDatumConfig.zeroDatumDescription')}
              </p>
            </div>

            {/* Station selection */}
            <div className="flex items-center gap-2">
              <label className="text-sm text-text-secondary shrink-0">
                {t('dialogs.zeroDatumConfig.stationLabel')}:
              </label>
              <Select
                value={String(stationIndex)}
                onChange={(v) => commitStation(parseInt(v, 10))}
                options={stationOptions}
                className="flex-1"
                data-testid="zero-datum-station-select"
                onOptionHover={handleStationHover}
              />
            </div>

            {/* GPS input */}
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <label className="text-sm text-text-secondary shrink-0">
                  {t('dialogs.zeroDatumConfig.gpsLabel')}:
                </label>
                <input
                  type="text"
                  value={gpsInput}
                  onChange={(e) => handleGpsInputChange(e.target.value)}
                  placeholder={t('dialogs.zeroDatumConfig.gpsPlaceholder')}
                  className="flex-1 px-2 py-1.5 bg-background border border-border rounded text-sm"
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
                <div className="text-xs text-error pl-1" data-testid="zero-datum-gps-error">
                  {gpsError}
                </div>
              )}
              {gpsCoords && (
                <div className="text-xs text-success pl-1" data-testid="zero-datum-gps-parsed">
                  Lat: {formatFixed(gpsCoords.latitude, undefined, precision.gps)}, Lon:{' '}
                  {formatFixed(gpsCoords.longitude, undefined, precision.gps)}
                </div>
              )}
            </div>
          </div>

          {/* Section name */}
          <div>
            <h3 className="text-sm font-medium text-text-primary mb-2">
              {t('dialogs.zeroDatumConfig.metadataHeading')}
            </h3>
            <label className="block text-sm text-text-secondary mb-1">{t('common.labels.name')}</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 bg-background border border-border rounded"
              placeholder={t('sectionMetadata.placeholders.name')}
              data-testid="section-name-input"
            />
          </div>

          <div
            className={`space-y-5 ${expanded ? 'flex min-h-0 flex-1 flex-col' : ''}`}
            data-testid="zero-datum-editable-rest"
          >
            <SectionMetadataForm
              name={name}
              surveyor={surveyor}
              date={date}
              color={color}
              direction={direction}
              onNameChange={setName}
              onSurveyorChange={setSurveyor}
              onDateChange={setDate}
              onColorChange={setColor}
              onDirectionChange={setDirection}
              reverse={reverse}
              onReverseChange={setReverse}
              showName={false}
              showDirection
              showReverse
            />

            {/* Shot table */}
            <div className={expanded ? 'flex min-h-0 flex-1 flex-col' : undefined}>
              <h3 className="text-sm font-medium text-text-primary mb-2">
                {t('dialogs.zeroDatumConfig.shotsHeading')}
              </h3>
              <ShotTableEditor
                shots={shots}
                onShotChange={handleShotChange}
                onAddShot={handleAddShot}
                onAddShots={handleAddShots}
                onDeleteShot={handleDeleteShot}
                onInsertBefore={handleInsertBefore}
                onInsertAfter={handleInsertAfter}
                expanded={expanded}
                onToggleExpand={() => setExpanded((v) => !v)}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Footer - always visible */}
      <div className="px-4 py-3 border-t border-border flex justify-between items-center shrink-0">
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
