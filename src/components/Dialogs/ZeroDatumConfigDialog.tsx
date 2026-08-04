import { useState, useCallback, useMemo, useReducer } from 'react';
import { useTranslation } from 'react-i18next';
import { blockedByIncompleteShots, countIncompleteShots } from '../common/incompleteShots';
import { blankEditableShot } from '../common/editableShot';
import { isEmittedShot, emittedBefore } from '../common/emittedShots';
import { reanchorAfterRunDelete, reanchorStation } from '../../utils/stationReanchor';
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
import type { DmpFile, DmpSection } from '../../types/commands';
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

/** A blank row for the shot table - one 'insert' action serves appending and
 *  inserting alike. The shared blank-row contract; `id` stays negative here as
 *  this dialog keys its rows by it. */
function makeNewShot(tempId: number): EditableShot {
  return { ...blankEditableShot(-tempId), tempId };
}

/**
 * The rows that will actually be imported - `buildZeroDatumSectionConfig`
 * serializes exactly these, and `editableShotsToDmpSection` draws exactly these.
 * The dialog must count stations over the SAME set: a blank row left among the
 * shots is dropped from the payload, so counting it here made the picker, the
 * preview and the re-anchor all disagree with the backend, and the GPS anchor
 * landed on a different station than the one shown.
 */
const isCounted = isEmittedShot;

/**
 * How many counted rows precede `arrayIndex`.
 *
 * `ShotTableEditor` hands its callbacks an index into the FULL `shots` array
 * (deleted rows included), while a station index counts only emitted rows, so
 * the two spaces have to be bridged before a pick can be re-anchored.
 */
const survivorsBefore = emittedBefore;

/**
 * The shot rows and the station pick, as ONE state.
 *
 * They belong together because no action touches only one of them: a row
 * joining or leaving the payload renumbers the stations the pick addresses, so
 * the new rows and the re-anchored pick have to be derived from the same
 * snapshot. Holding them apart is what broke this dialog three times - the last
 * shape read the rows from the render closure while committing the pick through
 * a ref, and `ShotTableEditor` fans `onShotChange` out ONE CALL PER CELL (a
 * pasted row is about five, an averaged azimuth two). Every call in the event
 * saw the same pre-edit row, so one row joining the payload shifted the pick
 * once per cell, and a row cleared back to blank never shifted it back.
 *
 * As a reducer each action reads the reducer's own `prev`, which already holds
 * the earlier cells of the same event: the first write makes the row counted and
 * owes the shift, the rest see it counted and owe nothing. The fan-out is
 * idempotent without anyone having to coalesce it.
 *
 * Every case is PURE - StrictMode (dev and the Playwright build) invokes
 * reducers twice on purpose, which is precisely what the ref-based version
 * could not survive.
 */
interface ShotEditState {
  shots: EditableShot[];
  /** Committed pick, in the CURRENT emitted-station numbering: a section of `s`
   *  counted rows has stations `0..s`. */
  stationIndex: number;
  /** What the preview highlights - follows dropdown hover, reverts to the pick. */
  previewStationIndex: number;
  /** Identity for the next blank row; never reused, so rows stay distinct
   *  however many one gesture adds. */
  nextTempId: number;
}

type ShotEditAction =
  /** One cell of one row, at a FULL-array index (deleted rows included). */
  | { type: 'edit'; index: number; field: keyof EditableShot; value: number | string | boolean | null }
  /** `count` blank rows at a full-array index, or appended at `'end'`. One
   *  action however many rows: asked row by row, a host that rebuilds from a
   *  snapshot overwrites its own earlier inserts. */
  | { type: 'insert'; at: number | 'end'; count: number }
  /** Soft-delete a whole selection at once, so the pick can be judged against
   *  the run rather than one row at a time. */
  | { type: 'delete'; indices: number[] }
  | { type: 'pick'; index: number }
  /** Dropdown hover; `null` when it closes without a selection. */
  | { type: 'hover'; index: number | null };

/** Commit a pick: it is the value sent, the map highlight, and what a cancelled
 *  hover reverts to. */
function withPick(state: ShotEditState, shots: EditableShot[], pick: number): ShotEditState {
  return { ...state, shots, stationIndex: pick, previewStationIndex: pick };
}

function shotEditReducer(state: ShotEditState, action: ShotEditAction): ShotEditState {
  switch (action.type) {
    case 'edit': {
      const current = state.shots[action.index];
      if (!current) return state;
      const updated = { ...current, [action.field]: action.value } as EditableShot;
      const shots = [...state.shots];
      shots[action.index] = updated;
      // Only a row crossing INTO or OUT OF the payload renumbers anything.
      // Inserting it did not move the pick (an uncounted row changes no
      // numbering), so the shift is owed here - and owed back when the row is
      // cleared to blank.
      const was = isCounted(current);
      const now = isCounted(updated);
      if (was === now) return { ...state, shots };
      const delta = now ? 1 : -1;
      return withPick(
        state,
        shots,
        reanchorStation(
          state.stationIndex,
          survivorsBefore(state.shots, action.index),
          delta,
          state.shots.filter(isCounted).length + delta,
        ),
      );
    }
    case 'insert': {
      const n = Math.max(1, action.count);
      const at = action.at === 'end' ? state.shots.length : action.at;
      const shots = [...state.shots];
      shots.splice(at, 0, ...Array.from({ length: n }, (_, i) => makeNewShot(state.nextTempId + i)));
      // The inserted rows are BLANK, so `isCounted` excludes them and the
      // station numbering does not move at all. Shifting by `n` here while the
      // dropdown counted the old total pushed the pick out of step with the
      // payload - and Confirm could anchor the datum to a different station, or
      // one past the end. Rows shift the pick only once they hold data, which
      // is the 'edit' case above. The call is still made, for the clamp.
      const counted = state.shots.filter(isCounted).length;
      return {
        ...withPick(
          state,
          shots,
          reanchorStation(state.stationIndex, survivorsBefore(state.shots, at), 0, counted),
        ),
        nextTempId: state.nextTempId + n,
      };
    }
    case 'delete': {
      const targets = action.indices.filter((i) => state.shots[i] && !state.shots[i]!.isDeleted);
      if (targets.length === 0) return state;
      const shots = [...state.shots];
      for (const i of targets) shots[i] = { ...shots[i]!, isDeleted: true };
      // Anchor against the EARLIEST removal, shifted by the whole run. Only the
      // rows that were COUNTED renumber anything: a blank row in the range is
      // absent from the payload, so removing it shifts no station. Subtracting
      // every target moved the anchor a station upstream.
      const counted = state.shots.filter(isCounted).length;
      const countedGone = targets.filter((i) => isCounted(state.shots[i])).length;
      return withPick(
        state,
        shots,
        reanchorAfterRunDelete(
          state.stationIndex,
          survivorsBefore(state.shots, Math.min(...targets)),
          countedGone,
          counted - countedGone,
        ),
      );
    }
    case 'pick':
      return withPick(state, state.shots, action.index);
    case 'hover':
      return { ...state, previewStationIndex: action.index ?? state.stationIndex };
  }
}

/** Rows straight from the file, the pick at the head, temp ids past the last row. */
function initialShotEditState(section: DmpSection | undefined): ShotEditState {
  const shots = section ? convertToEditableShots(section.shots) : [];
  return { shots, stationIndex: 0, previewStationIndex: 0, nextTempId: shots.length + 1 };
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

  // Expand grows the DIALOG, same as the other two shot-entry surfaces; the
  // editor only asks, the host owns its size.
  const [expanded, setExpanded] = useState(false);

  // The shots and the station pick, in one reducer - see `shotEditReducer` for
  // why they cannot be separate pieces of state.
  const [{ shots, stationIndex, previewStationIndex }, dispatch] = useReducer(
    shotEditReducer,
    section,
    initialShotEditState,
  );

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

  // Station count = counted shots + 1. The dropdown, the preview, the payload
  // and the pick all count by `isCounted` - one predicate, one station space.
  const stationCount = useMemo(() => {
    return shots.filter(isCounted).length + 1;
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
  const commitStation = useCallback((index: number) => dispatch({ type: 'pick', index }), []);

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
  // without selecting, the reducer reverts to the committed station.
  const handleStationHover = useCallback((value: string | null) => {
    dispatch({ type: 'hover', index: value === null ? null : parseInt(value, 10) });
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

  // Shot editing handlers. Each is one dispatch: the reducer derives the new
  // rows and the re-anchored pick from the same `prev`, so `stationIndex`
  // always addresses the current, post-edit station order - and the editor's
  // per-cell fan-out cannot shift it more than once for one row.
  const handleShotChange = useCallback(
    (index: number, field: keyof EditableShot, value: number | string | boolean | null) => {
      dispatch({ type: 'edit', index, field, value });
    },
    []
  );

  // Appending goes through the same action as an insert, so the invariant has
  // one owner. `'end'` rather than a captured length: the trailing blank row is
  // materialized and then written in ONE event, and the reducer's array is the
  // only one that has both.
  const handleAddShot = useCallback(() => dispatch({ type: 'insert', at: 'end', count: 1 }), []);

  /** Append `count` blank shots in ONE action, each with its own temp id. Asked
   *  N times in one React event instead, a host that rebuilds from a captured
   *  array overwrites its own earlier appends and one that stamps rows from a
   *  captured temp id gives them all the same identity. */
  const handleAddShots = useCallback(
    (count: number) => dispatch({ type: 'insert', at: 'end', count }),
    []
  );

  /** Insert `count` blank shots at `index`, in ONE action, re-anchoring the
   *  station pick once for the whole run rather than per row. */
  const handleInsertShots = useCallback(
    (index: number, count: number, position: 'before' | 'after') => {
      dispatch({ type: 'insert', at: position === 'after' ? index + 1 : index, count });
    },
    []
  );

  /** Soft-delete every selected index in ONE action, so the pick is judged
   *  against the whole run. The answer the grid needs is synchronous (a `false`
   *  leaves its selection alone), so whether anything is left to delete is read
   *  from the rendered rows; the reducer decides again from its own state. */
  const handleDeleteShots = useCallback(
    (indices: number[]): boolean => {
      if (!indices.some((i) => shots[i] && !shots[i]!.isDeleted)) return false;
      dispatch({ type: 'delete', indices });
      return true;
    },
    [shots]
  );

  const handleDeleteShot = useCallback(
    (index: number) => dispatch({ type: 'delete', indices: [index] }),
    []
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
                onInsertShots={handleInsertShots}
                onDeleteShot={handleDeleteShot}
                onDeleteShots={handleDeleteShots}
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
