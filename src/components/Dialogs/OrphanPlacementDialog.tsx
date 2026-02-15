import { useState, useCallback, useMemo, useEffect } from 'react';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';
import SectionPreview from './SectionPreview';
import type { MergePreviewConfig } from './SectionPreview';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import type { OrphanPlacementSuggestion } from '../../types/commands';
import type { Section } from '../../types/project';
import type { DmpSection } from '../../types/ipc/DmpSection';
import type { OverlapMode } from '../../types/ipc/OverlapMode';
import {
  computeMergeOptions,
  computeActionableIds,
  computeTargetShotIndex,
  needsDirectionReversal,
  reverseTargetShot,
  interpolateShots,
  type TargetShotLike,
} from '../../utils/overlapHelpers';

interface OrphanPlacementDialogProps {
  suggestions: OrphanPlacementSuggestion[];
}

/** Group key for an orphan end: sectionId + stationIndex. */
interface OrphanEnd {
  key: string;
  orphanSectionId: number;
  orphanStationIndex: number;
  suggestions: OrphanPlacementSuggestion[];
}

const confidenceColors: Record<string, string> = {
  high: 'bg-success-10 text-success border-success-30',
  medium: 'bg-warning-10 text-warning border-warning-30',
  low: 'bg-background-50 text-text-secondary border-border',
};

const confidenceLabel = (c: string): string => {
  switch (c) {
    case 'high': return 'High';
    case 'medium': return 'Medium';
    case 'low': return 'Low';
    default: return c;
  }
};

const directionLabel = (direction: string) =>
  direction === 'forward' ? '\u2192' : '\u2190';

const overlapModeLabels: Record<OverlapMode, string> = {
  interpolate: 'Interpolate (average)',
  import_data: 'Use orphan data',
  existing_data: 'Use target data',
  keep_both: 'Keep both (mark as reference)',
};

/** Convert a project Section to DmpSection format for SectionPreview. */
function sectionToDmpSection(section: Section): DmpSection {
  return {
    version: 1,
    name: section.name ?? '',
    direction: section.direction,
    date: section.date ?? '',
    content_hash: '',
    shots: section.shots.map((s) => ({
      shot_type: 'Standard' as const,
      heading_in: s.azimuth_in,
      heading_out: s.azimuth_out,
      length: s.length,
      depth_in: s.depth_in,
      depth_out: s.depth_out,
      pitch_in: s.pitch_in ?? 0,
      pitch_out: s.pitch_out ?? 0,
      left: s.left ?? 0,
      right: s.right ?? 0,
      up: s.up ?? 0,
      down: s.down ?? 0,
      temperature: s.temperature ?? 0,
      hour: 0, minute: 0, second: 0,
      marker_index: s.marker_index ?? 0,
      ...(s.comment != null ? { comment: s.comment } : {}),
    })),
  };
}

export default function OrphanPlacementDialog({ suggestions }: OrphanPlacementDialogProps) {
  const { mergeStations, updateShot, setShotReference, refreshProjectState, project } = useProjectStore();
  const { closeDialog, setView, triggerFitToBounds } = useUIStore();

  const [processing, setProcessing] = useState(false);
  const [currentEndIndex, setCurrentEndIndex] = useState(0);
  const [acceptedOrphans, setAcceptedOrphans] = useState<Set<number>>(new Set());
  const [skippedCount, setSkippedCount] = useState(0);
  const [showAlternatives, setShowAlternatives] = useState(false);
  // Track which suggestion index within the current group is selected
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);
  // Merge station pair and overlap mode
  const [selectedMergeOffset, setSelectedMergeOffset] = useState(0);
  const [overlapMode, setOverlapMode] = useState<OverlapMode>('existing_data');

  // Group suggestions by orphan end, sorted by score descending within each group
  const allOrphanEnds = useMemo((): OrphanEnd[] => {
    const map = new Map<string, OrphanPlacementSuggestion[]>();
    for (const s of suggestions) {
      const key = `${s.orphanSectionId}-${s.orphanStationIndex}`;
      const list = map.get(key) ?? [];
      list.push(s);
      map.set(key, list);
    }
    const ends: OrphanEnd[] = [];
    for (const [key, group] of map) {
      group.sort((a, b) => b.score - a.score);
      ends.push({
        key,
        orphanSectionId: group[0]!.orphanSectionId,
        orphanStationIndex: group[0]!.orphanStationIndex,
        suggestions: group,
      });
    }
    return ends;
  }, [suggestions]);

  // Filter out ends whose orphan section has already been accepted
  const remainingEnds = useMemo(
    () => allOrphanEnds.filter((e) => !acceptedOrphans.has(e.orphanSectionId)),
    [allOrphanEnds, acceptedOrphans],
  );

  const currentEnd = remainingEnds[currentEndIndex] ?? null;
  const currentSuggestion = currentEnd?.suggestions[selectedSuggestionIndex] ?? currentEnd?.suggestions[0] ?? null;
  const alternatives = useMemo(() => {
    if (!currentEnd) return [];
    return currentEnd.suggestions.filter((_, i) => i !== selectedSuggestionIndex);
  }, [currentEnd, selectedSuggestionIndex]);

  const isFinished = currentEnd == null;

  // Look up sections from project
  const orphanSection = useMemo(
    () => project?.sections.find((s) => s.id === currentSuggestion?.orphanSectionId) ?? null,
    [project, currentSuggestion],
  );
  const targetSection = useMemo(
    () => project?.sections.find((s) => s.id === currentSuggestion?.targetSectionId) ?? null,
    [project, currentSuggestion],
  );

  // Compute merge options for the current suggestion
  const importShotCount = useMemo(() => {
    if (!orphanSection) return 0;
    return orphanSection.shots.length;
  }, [orphanSection]);

  const mergeOptions = useMemo(() => {
    if (!currentSuggestion) return [];
    return computeMergeOptions(
      {
        importStationIndex: currentSuggestion.orphanStationIndex,
        existingStationIndex: currentSuggestion.targetStationIndex,
        matchedShots: currentSuggestion.matchedShots,
        direction: currentSuggestion.direction,
        isPartial: currentSuggestion.isPartial,
      },
      importShotCount,
    );
  }, [currentSuggestion, importShotCount]);

  const selectedMergePair = useMemo(() => {
    if (mergeOptions.length === 0) return null;
    return mergeOptions.find((o) => o.offset === selectedMergeOffset) ?? mergeOptions[mergeOptions.length - 1]!;
  }, [mergeOptions, selectedMergeOffset]);

  // Reset merge offset to last option (deepest overlap) when suggestion changes
  useEffect(() => {
    if (mergeOptions.length > 0) {
      setSelectedMergeOffset(mergeOptions[mergeOptions.length - 1]!.offset);
    }
  }, [currentSuggestion, mergeOptions]);

  // Check if the target section's overlap region is doubly-anchored
  const isTargetDoublyAnchored = useMemo(() => {
    if (!currentSuggestion) return false;
    if (currentSuggestion.matchedShots === 0) return false;
    if (!project) return false;

    const sid = currentSuggestion.targetSectionId;

    // BFS: can `start` reach a zero datum via merges + aligned closures
    // without traversing through `excluded`?
    const hasDatumPathExcluding = (start: number, excluded: number): boolean => {
      const visited = new Set<number>();
      const queue = [start];
      while (queue.length > 0) {
        const current = queue.pop()!;
        if (current === excluded) continue;
        if (visited.has(current)) continue;
        visited.add(current);
        if (project.zero_datums.some((zd) => zd.station_ref.section_id === current)) {
          return true;
        }
        for (const m of project.station_merges) {
          if (m.station_a.section_id === current && !visited.has(m.station_b.section_id)) {
            queue.push(m.station_b.section_id);
          }
          if (m.station_b.section_id === current && !visited.has(m.station_a.section_id)) {
            queue.push(m.station_a.section_id);
          }
        }
        for (const c of project.loop_closures) {
          if (!c.is_aligned) continue;
          if (c.station_a.section_id === current && !visited.has(c.station_b.section_id)) {
            queue.push(c.station_b.section_id);
          }
          if (c.station_b.section_id === current && !visited.has(c.station_a.section_id)) {
            queue.push(c.station_a.section_id);
          }
        }
      }
      return false;
    };

    // Compute the range of target shot indices that would be modified
    let minShot: number;
    let maxShot: number;
    if (currentSuggestion.direction === 'forward') {
      minShot = currentSuggestion.targetStationIndex;
      maxShot = currentSuggestion.targetStationIndex + currentSuggestion.matchedShots - 1;
    } else {
      minShot = currentSuggestion.targetStationIndex - currentSuggestion.matchedShots;
      maxShot = currentSuggestion.targetStationIndex - 1;
    }

    // Collect anchor station indices on the target section
    const anchors: number[] = [];
    for (const zd of project.zero_datums) {
      if (zd.station_ref.section_id === sid) anchors.push(zd.station_ref.station_index);
    }
    for (const m of project.station_merges) {
      if (m.station_a.section_id === sid && hasDatumPathExcluding(m.station_b.section_id, sid)) {
        anchors.push(m.station_a.station_index);
      }
      if (m.station_b.section_id === sid && hasDatumPathExcluding(m.station_a.section_id, sid)) {
        anchors.push(m.station_b.station_index);
      }
    }
    for (const c of project.loop_closures) {
      if (!c.is_aligned) continue;
      if (c.station_a.section_id === sid && hasDatumPathExcluding(c.station_b.section_id, sid)) {
        anchors.push(c.station_a.station_index);
      }
      if (c.station_b.section_id === sid && hasDatumPathExcluding(c.station_a.section_id, sid)) {
        anchors.push(c.station_b.station_index);
      }
    }

    const hasFront = anchors.some((idx) => idx <= minShot);
    const hasBack = anchors.some((idx) => idx > maxShot);
    return hasFront && hasBack;
  }, [currentSuggestion, project]);

  // Auto-switch to 'existing_data' when doubly-anchored disables the current mode
  useEffect(() => {
    if (isTargetDoublyAnchored && (overlapMode === 'interpolate' || overlapMode === 'import_data')) {
      setOverlapMode('existing_data');
    }
  }, [isTargetDoublyAnchored, overlapMode]);

  // Convert orphan section to DmpSection for SectionPreview
  const orphanDmpSection = useMemo(
    () => (orphanSection ? sectionToDmpSection(orphanSection) : null),
    [orphanSection],
  );

  // Build merge preview config using selected merge pair
  const mergePreviewConfig = useMemo((): MergePreviewConfig | null => {
    if (!targetSection || !currentSuggestion) return null;
    return {
      targetSection,
      importStationIndex: selectedMergePair?.importStation ?? currentSuggestion.orphanStationIndex,
      targetStationIndex: selectedMergePair?.existingStation ?? currentSuggestion.targetStationIndex,
    };
  }, [targetSection, currentSuggestion, selectedMergePair]);

  const finish = useCallback(async () => {
    await refreshProjectState();
    closeDialog();
    setView('single');
    triggerFitToBounds();
  }, [refreshProjectState, closeDialog, setView, triggerFitToBounds]);

  // Auto-close when all suggestions have been processed
  useEffect(() => {
    if (isFinished) {
      finish();
    }
  }, [isFinished, finish]);

  const advance = useCallback(() => {
    setShowAlternatives(false);
    setSelectedSuggestionIndex(0);
    // If we're at the last remaining end, finish
    if (currentEndIndex >= remainingEnds.length - 1) {
      finish();
    } else {
      setCurrentEndIndex((i) => i + 1);
    }
  }, [currentEndIndex, remainingEnds.length, finish]);

  /** Apply overlap treatment after merging stations. */
  const applyOverlapTreatment = useCallback(async (
    suggestion: OrphanPlacementSuggestion,
    mergePair: { importStation: number; existingStation: number },
    mode: OverlapMode,
  ) => {
    if (suggestion.matchedShots === 0) return;

    const actionableIds = computeActionableIds(
      suggestion.orphanStationIndex,
      suggestion.matchedShots,
      mergePair.importStation,
    );
    if (actionableIds.size === 0) return;

    // Get fresh sections from project store
    const proj = useProjectStore.getState().project;
    if (!proj) return;
    const oSection = proj.sections.find((s) => s.id === suggestion.orphanSectionId);
    const tSection = proj.sections.find((s) => s.id === suggestion.targetSectionId);
    if (!oSection || !tSection) return;

    const shouldReverse = needsDirectionReversal(suggestion.orphanStationIndex, suggestion.direction);
    const overlapParams = {
      importStationIndex: suggestion.orphanStationIndex,
      matchedShots: suggestion.matchedShots,
      existingStationIndex: suggestion.targetStationIndex,
      direction: suggestion.direction,
    };

    for (const overlapId of actionableIds) {
      const orphanShot = oSection.shots[overlapId];
      if (!orphanShot) continue;

      // Mark orphan overlap shot as reference (all modes)
      await setShotReference(suggestion.orphanSectionId, orphanShot.id, true);

      // For interpolate and import_data, also update the target shot
      if (mode === 'interpolate' || mode === 'import_data') {
        const targetShotIdx = computeTargetShotIndex(overlapId, overlapParams);
        const targetShot = tSection.shots[targetShotIdx];
        if (!targetShot) continue;

        const orphanAsTarget: TargetShotLike = shouldReverse
          ? reverseTargetShot(orphanShot)
          : orphanShot;

        if (mode === 'interpolate') {
          const interp = interpolateShots(
            { ...targetShot, comment: targetShot.comment ?? null, is_reference: targetShot.is_reference },
            orphanAsTarget,
          );
          await updateShot(suggestion.targetSectionId, targetShot.id, {
            azimuth_in: interp.azimuth_in,
            azimuth_out: interp.azimuth_out,
            length: interp.length,
            depth_in: interp.depth_in,
            depth_out: interp.depth_out,
            pitch_in: interp.pitch_in,
            pitch_out: interp.pitch_out,
            left: interp.left,
            right: interp.right,
            up: interp.up,
            down: interp.down,
          });
        } else {
          // import_data: use orphan's values on the target
          await updateShot(suggestion.targetSectionId, targetShot.id, {
            azimuth_in: orphanAsTarget.azimuth_in,
            azimuth_out: orphanAsTarget.azimuth_out,
            length: orphanAsTarget.length,
            depth_in: orphanAsTarget.depth_in,
            depth_out: orphanAsTarget.depth_out,
            pitch_in: orphanAsTarget.pitch_in,
            pitch_out: orphanAsTarget.pitch_out,
            left: orphanAsTarget.left,
            right: orphanAsTarget.right,
            up: orphanAsTarget.up,
            down: orphanAsTarget.down,
          });
        }
      }
    }
  }, [setShotReference, updateShot]);

  const handleAccept = useCallback(async () => {
    if (!currentSuggestion) return;
    setProcessing(true);
    try {
      const mergeImport = selectedMergePair?.importStation ?? currentSuggestion.orphanStationIndex;
      const mergeExisting = selectedMergePair?.existingStation ?? currentSuggestion.targetStationIndex;

      await mergeStations(
        { section_id: currentSuggestion.orphanSectionId, station_index: mergeImport },
        { section_id: currentSuggestion.targetSectionId, station_index: mergeExisting },
      );

      // Apply overlap treatment
      await applyOverlapTreatment(
        currentSuggestion,
        { importStation: mergeImport, existingStation: mergeExisting },
        overlapMode,
      );

      setAcceptedOrphans((prev) => new Set(prev).add(currentSuggestion.orphanSectionId));
      setShowAlternatives(false);
      setSelectedSuggestionIndex(0);
      if (remainingEnds.length <= 1) {
        await finish();
      }
    } finally {
      setProcessing(false);
    }
  }, [currentSuggestion, selectedMergePair, mergeStations, applyOverlapTreatment, overlapMode, remainingEnds.length, finish]);

  const handleSkip = useCallback(() => {
    setSkippedCount((c) => c + 1);
    advance();
  }, [advance]);

  const handleAcceptAll = useCallback(async () => {
    setProcessing(true);
    try {
      const processed = new Set<number>();
      for (let i = currentEndIndex; i < remainingEnds.length; i++) {
        const end = remainingEnds[i]!;
        if (processed.has(end.orphanSectionId)) continue;
        const best = end.suggestions[0];
        if (!best) continue;

        // Use default merge pair (deepest overlap) for accept-all
        const opts = computeMergeOptions(
          {
            importStationIndex: best.orphanStationIndex,
            existingStationIndex: best.targetStationIndex,
            matchedShots: best.matchedShots,
            direction: best.direction,
            isPartial: best.isPartial,
          },
          project?.sections.find((s) => s.id === best.orphanSectionId)?.shots.length ?? 0,
        );
        const pair = opts.length > 0 ? opts[opts.length - 1]! : null;
        const mergeImport = pair?.importStation ?? best.orphanStationIndex;
        const mergeExisting = pair?.existingStation ?? best.targetStationIndex;

        await mergeStations(
          { section_id: best.orphanSectionId, station_index: mergeImport },
          { section_id: best.targetSectionId, station_index: mergeExisting },
        );

        await applyOverlapTreatment(
          best,
          { importStation: mergeImport, existingStation: mergeExisting },
          overlapMode,
        );

        processed.add(end.orphanSectionId);
      }
      await finish();
    } finally {
      setProcessing(false);
    }
  }, [currentEndIndex, remainingEnds, mergeStations, applyOverlapTreatment, overlapMode, project, finish]);

  const handleAlternativeClick = useCallback((altIndex: number) => {
    if (!currentEnd) return;
    let realIndex = 0;
    let altCount = 0;
    for (let i = 0; i < currentEnd.suggestions.length; i++) {
      if (i === selectedSuggestionIndex) continue;
      if (altCount === altIndex) {
        realIndex = i;
        break;
      }
      altCount++;
    }
    setSelectedSuggestionIndex(realIndex);
  }, [currentEnd, selectedSuggestionIndex]);

  // Progress: how many we've processed (accepted + skipped) out of total original ends
  const processedCount = currentEndIndex + (allOrphanEnds.length - remainingEnds.length);
  const totalOriginal = allOrphanEnds.length;

  // Display stations from selected merge pair
  const displayOrphanStation = selectedMergePair?.importStation ?? currentSuggestion?.orphanStationIndex ?? 0;
  const displayTargetStation = selectedMergePair?.existingStation ?? currentSuggestion?.targetStationIndex ?? 0;

  return (
    <DialogWrapper
      title="Connect Orphaned Sections"
      onClose={finish}
      fixedSize={{ width: 'min(900px, 95vw)', height: 'min(650px, 90vh)' }}
      overflow="hidden"
      bodyClassName="flex-1 flex flex-col p-0 min-h-0"
      data-testid="orphan-placement-dialog"
    >
      {/* Progress header */}
      <div className="px-4 py-2 border-b border-border text-sm text-text-secondary">
        <span data-testid="wizard-progress">
          Section {Math.min(processedCount + 1, totalOriginal)} of {totalOriginal}
        </span>
        {skippedCount > 0 && (
          <span className="ml-2" data-testid="wizard-skipped">
            &middot; {skippedCount} skipped
          </span>
        )}
      </div>

      {isFinished ? null : (
        /* Side-by-side layout */
        <div className="flex-1 flex min-h-0 overflow-hidden relative">
          {/* Left column: SectionPreview */}
          <div
            className="shrink-0 flex flex-col items-center justify-center p-4 border-r border-border"
            style={{ width: 380 }}
          >
            {orphanDmpSection && (
              <SectionPreview
                section={orphanDmpSection}
                color={orphanSection?.color ?? '#4a9eff'}
                size={340}
                mergePreview={mergePreviewConfig}
                focusStationIndex={currentSuggestion?.orphanStationIndex ?? null}
              />
            )}
            {!orphanDmpSection && (
              <div className="w-[340px] h-[340px] border border-border rounded flex items-center justify-center text-text-secondary text-sm">
                Section not found
              </div>
            )}
          </div>

          {/* Right column: connection details */}
          <div className="flex-1 min-w-0 overflow-y-auto p-5 space-y-4" data-testid="wizard-suggestion">
            {/* Connection heading */}
            <div>
              <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
                Suggested Connection
              </h3>
            </div>

            {/* Connection description */}
            <div className="p-3 rounded border border-border bg-surface-alt space-y-2">
              <div className="text-sm">
                <span className="font-medium">{currentSuggestion!.orphanSectionName}</span>
                <span className="text-text-tertiary"> stn {displayOrphanStation}</span>
              </div>
              <div className="text-xs text-text-secondary">
                &rarr; <span className="font-medium text-text-primary">{currentSuggestion!.targetSectionName}</span>
                <span className="text-text-tertiary"> stn {displayTargetStation}</span>
              </div>
            </div>

            {/* Confidence badge + matched shots */}
            <div className="flex items-center gap-3 flex-wrap">
              <span
                className={`px-2 py-1 rounded border text-xs font-medium ${confidenceColors[currentSuggestion!.confidence] ?? ''}`}
                data-testid="confidence-badge"
              >
                {confidenceLabel(currentSuggestion!.confidence)}
              </span>
              <span className="text-xs text-text-secondary">
                {currentSuggestion!.matchedShots} shot{currentSuggestion!.matchedShots !== 1 ? 's' : ''} matched {directionLabel(currentSuggestion!.direction)}
              </span>
              <span className="text-xs text-text-tertiary">
                {Math.round(currentSuggestion!.score * 100)}% score
              </span>
            </div>

            {/* Merge station picker */}
            {mergeOptions.length > 1 && (
              <div className="flex items-center gap-2" data-testid="merge-station-picker">
                <label className="text-xs text-text-secondary whitespace-nowrap">
                  Merge at
                </label>
                <select
                  value={selectedMergeOffset}
                  onChange={(e) => setSelectedMergeOffset(Number(e.target.value))}
                  className="px-2 py-1 bg-background border border-border rounded text-xs"
                  data-testid="merge-station-select"
                >
                  {mergeOptions.map((opt) => (
                    <option key={opt.offset} value={opt.offset}>
                      stn {opt.importStation} &rarr; {currentSuggestion!.targetSectionName} stn {opt.existingStation}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Overlap mode picker */}
            {currentSuggestion && currentSuggestion.matchedShots > 0 && (
              <div className="flex items-center gap-2" data-testid="overlap-mode-picker">
                <label className="text-xs text-text-secondary whitespace-nowrap">
                  Overlap
                </label>
                <select
                  value={overlapMode}
                  onChange={(e) => setOverlapMode(e.target.value as OverlapMode)}
                  className="px-2 py-1 bg-background border border-border rounded text-xs"
                  data-testid="overlap-mode-select"
                >
                  <option value="interpolate" disabled={isTargetDoublyAnchored}>{overlapModeLabels.interpolate}</option>
                  <option value="import_data" disabled={isTargetDoublyAnchored}>{overlapModeLabels.import_data}</option>
                  <option value="existing_data">{overlapModeLabels.existing_data}</option>
                  <option value="keep_both">{overlapModeLabels.keep_both}</option>
                </select>
              </div>
            )}

            {/* Prompt */}
            <p className="text-sm text-text-secondary">
              Does this connection look right?
            </p>

            {/* Accept / Skip buttons */}
            <div className="flex gap-2">
              <Button
                data-testid="orphan-accept"
                onClick={handleAccept}
                disabled={processing}
                data-primary-action=""
              >
                Accept
              </Button>
              <Button
                data-testid="orphan-skip"
                onClick={handleSkip}
                disabled={processing}
              >
                Skip
              </Button>
            </div>

            {/* Alternatives */}
            {alternatives.length > 0 && (
              <div>
                <button
                  type="button"
                  onClick={() => setShowAlternatives(!showAlternatives)}
                  className="text-xs text-accent hover:text-accent-hover flex items-center gap-1"
                  data-testid="toggle-alternatives"
                >
                  <span className={`transition-transform ${showAlternatives ? 'rotate-90' : ''}`}>&#9654;</span>
                  {showAlternatives
                    ? 'Hide alternatives'
                    : `Show ${alternatives.length} alternative${alternatives.length !== 1 ? 's' : ''}`}
                </button>

                {showAlternatives && (
                  <div className="mt-2 space-y-1" data-testid="alternatives-list">
                    {alternatives.map((alt, idx) => (
                      <button
                        key={`${alt.targetSectionId}-${alt.targetStationIndex}-${alt.direction}`}
                        type="button"
                        className={`w-full p-2 rounded border text-left text-xs flex items-center gap-2 hover:bg-accent-5 transition-colors ${confidenceColors[alt.confidence] ?? ''}`}
                        onClick={() => handleAlternativeClick(idx)}
                        data-testid={`alternative-${idx}`}
                      >
                        <span className={`px-1 py-0.5 rounded text-[10px] font-medium ${confidenceColors[alt.confidence] ?? ''}`}>
                          {confidenceLabel(alt.confidence)}
                        </span>
                        <span className="truncate">
                          {alt.targetSectionName} stn {alt.targetStationIndex}
                        </span>
                        <span className="text-text-tertiary ml-auto shrink-0">
                          {alt.matchedShots} shot{alt.matchedShots !== 1 ? 's' : ''} {directionLabel(alt.direction)} &middot; {Math.round(alt.score * 100)}%
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Footer */}
      {!isFinished && (
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-border shrink-0">
          <Button
            data-testid="orphan-accept-all"
            onClick={handleAcceptAll}
            disabled={processing}
          >
            Accept All
          </Button>
          <Button
            data-testid="orphan-close"
            onClick={finish}
            disabled={processing}
          >
            Skip All
          </Button>
        </div>
      )}
    </DialogWrapper>
  );
}
