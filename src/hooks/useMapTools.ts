import { useCallback, useRef, useState } from 'react';
import { useUIStore, type Selection } from '../store/uiStore';
import { useProjectStore } from '../store/projectStore';
import { useShallow } from 'zustand/react/shallow';
import { isNonInteractiveTool } from '../utils/toolUtils';
import { useActiveStations } from './useActiveStations';
import { getErrorMessage } from '../utils/ipc';
import type { SectionId, ShotId, StationRef, Coordinates } from '../types/project';
import { setSource } from '../utils/telemetry';
import type { SurveyLayerCallbacks } from '../components/Map/SurveyLayer';

interface MoveDragStartData {
  type: 'station' | 'segment' | 'shot';
  sectionId?: number;
  stationRef?: StationRef;
  shotIndex?: number;
  /** Screen coordinates of the click that initiated the drag */
  screenX?: number;
  screenY?: number;
}

interface MapToolsOptions {
  onMeasureComplete?: (distance: number, depthDiff: number) => void;
  onMoveDragStart?: (data: MoveDragStartData) => void;
  onFeatureHover?: (isHovering: boolean) => void;
  /** Station keys ("sectionId:stationIndex") that cannot be moved (zero-datum or transitively connected) */
  immovableStationKeys?: Set<string>;
}

export function useMapTools(options: MapToolsOptions = {}): SurveyLayerCallbacks {
  // Performance: exclude hover values from subscription — this hook is called
  // from MapCanvas and would cause full re-renders on every mousemove.
  const {
    activeTool,
    setSelection,
    addToSelection,
    toggleSelection,
    clearSelection,
    mergeStationA,
    setMergeStationA,
    setMergeStationB,
    clearMergeStations,
    measureStart,
    setMeasureStart,
    setMeasureEnd,
    clearMeasure,
    setHoveredStation,
    setHoveredShot,
    openDialog,
    snappedStation,
    showStations,
    showShots,
    showToast,
    showDistanceGradient,
    setDistanceGradientOrigin,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
  } = useUIStore(useShallow(({ hoveredStation, hoveredShot, hoveredSectionId, ...rest }) => rest));

  const { stations, project, checkMergeConnectivity } = useProjectStore();
  // Coordinate lookups for read-only inspection (the measure tool) follow the
  // active geometry so distances match what's drawn; editing/comment paths below
  // keep using the measured `stations`.
  const activeStations = useActiveStations();

  const [isCheckingConnectivity, setIsCheckingConnectivity] = useState(false);
  // Ref-based guard prevents re-entrancy from fast successive clicks
  const connectivityInFlightRef = useRef(false);
  // Monotonic request ID for staleness detection
  const connectivityRequestIdRef = useRef(0);

  // Get station coordinates by ref
  const getStationCoordinates = useCallback(
    (ref: StationRef): Coordinates | null => {
      const station = activeStations.find(
        (s) => s.station_ref.section_id === ref.section_id && s.station_ref.station_index === ref.station_index
      );
      return station?.coordinates ?? null;
    },
    [activeStations]
  );

  // Calculate distance between two points
  const calculateDistance = useCallback(
    (a: StationRef | Coordinates, b: StationRef | Coordinates): { distance: number; depthDiff: number } | null => {
      const coordsA = 'section_id' in a ? getStationCoordinates(a as StationRef) : (a as Coordinates);
      const coordsB = 'section_id' in b ? getStationCoordinates(b as StationRef) : (b as Coordinates);

      if (!coordsA || !coordsB) return null;

      const dx = coordsB.x - coordsA.x;
      const dy = coordsB.y - coordsA.y;
      const dz = coordsB.z - coordsA.z;

      return {
        distance: Math.sqrt(dx * dx + dy * dy + dz * dz),
        depthDiff: dz,
      };
    },
    [getStationCoordinates]
  );

  // Check connectivity and open appropriate merge/closure dialog
  const checkAndOpenMergeDialog = useCallback(
    async (stationA: StationRef, stationB: StationRef) => {
      // Immediate ref-based guard prevents re-entrancy from fast clicks
      if (connectivityInFlightRef.current) return;
      connectivityInFlightRef.current = true;

      // Staleness: capture request ID so we can discard stale results
      connectivityRequestIdRef.current += 1;
      const requestId = connectivityRequestIdRef.current;

      setIsCheckingConnectivity(true);
      setMergeStationB(stationB);
      showToast('Checking connectivity...', 'merge-connectivity-check');
      try {
        const result = await checkMergeConnectivity(stationA, stationB);
        // Discard result if a newer request was started or merge was cancelled
        if (requestId !== connectivityRequestIdRef.current) return;
        // Verify merge tool is still active (user may have switched tools)
        const currentTool = useUIStore.getState().activeTool;
        const currentA = useUIStore.getState().mergeStationA;
        if (currentTool !== 'merge' || !currentA) {
          clearMergeStations();
          return;
        }
        if (result.can_merge) {
          // Merge is allowed — open merge dialog
          setSource('map');
          openDialog('merge', {
            stationA,
            stationB,
          });
        } else if (result.connected || result.reason === 'Both sections have fixed coordinates') {
          // Connected (or both sections fixed) — redirect to closure dialog
          setSource('map');
          openDialog('closure', {
            stationA,
            stationB,
            preview: result.preview,
            reason: result.reason,
          });
        } else {
          // Not connected and merge blocked (e.g. both sides have zero datums)
          showToast(result.reason ?? 'Merge not allowed.', 'merge-blocked');
          clearMergeStations();
        }
      } catch (e) {
        if (requestId !== connectivityRequestIdRef.current) return;
        showToast(getErrorMessage(e), 'merge-error');
        clearMergeStations();
      } finally {
        if (requestId === connectivityRequestIdRef.current) {
          connectivityInFlightRef.current = false;
          setIsCheckingConnectivity(false);
        }
      }
    },
    [checkMergeConnectivity, clearMergeStations, openDialog, setMergeStationB, showToast]
  );

  // Handle station click based on active tool
  const handleStationClick = useCallback(
    async (ref: StationRef, event: { originalEvent: MouseEvent }) => {
      // GUARD: No interactions for pan/zoom tools
      if (isNonInteractiveTool(activeTool)) return;

      // GUARD: Block all station interactions when hidden
      if (!showStations) {
        showToast("Enable 'Stations' in Display menu to interact with station markers", 'stations-hidden');
        return;
      }

      const mouseEvent = event.originalEvent;
      setSource('map');

      switch (activeTool) {
        case 'select': {
          const sel: Selection = { type: 'station', stationRef: ref };
          if (mouseEvent.shiftKey) {
            addToSelection(sel);
          } else if (mouseEvent.ctrlKey || mouseEvent.metaKey) {
            toggleSelection(sel);
          } else {
            setSelection(sel);
          }
          // Distance gradient (#34): a plain select-click re-roots the overlay to
          // the clicked station (additive — selection still happens).
          if (showDistanceGradient && !mouseEvent.shiftKey && !mouseEvent.ctrlKey && !mouseEvent.metaKey) {
            setDistanceGradientOrigin(ref);
          }
          break;
        }

        case 'merge': {
          if (isCheckingConnectivity) break;
          if (!mergeStationA) {
            setMergeStationA(ref);
          } else {
            // Check if clicking the same station
            if (
              mergeStationA.section_id === ref.section_id &&
              mergeStationA.station_index === ref.station_index
            ) {
              // Clear selection
              clearMergeStations();
            } else {
              // Check connectivity and open appropriate dialog
              checkAndOpenMergeDialog(mergeStationA, ref);
            }
          }
          break;
        }

        case 'measure': {
          if (!measureStart) {
            setMeasureStart(ref);
          } else {
            setMeasureEnd(ref);
            // Calculate and display distance
            const result = calculateDistance(measureStart, ref);
            if (result) {
              options.onMeasureComplete?.(result.distance, result.depthDiff);
            }
            // Keep the measurement displayed but allow new measurement
          }
          break;
        }

        case 'move_station': {
          // Guard: block interaction with immovable stations (zero-datum or transitively connected)
          const stationKey = `${ref.section_id}:${ref.station_index}`;
          if (options.immovableStationKeys?.has(stationKey)) break;

          // Start drag operation - handled by MapCanvas
          setSelection({ type: 'station', stationRef: ref });
          options.onMoveDragStart?.({
            type: 'station',
            stationRef: ref,
            screenX: mouseEvent.clientX,
            screenY: mouseEvent.clientY,
          });
          break;
        }


        case 'move_segment': {
          // Start segment move drag - anchored sections are silently ignored
          options.onMoveDragStart?.({
            type: 'segment',
            sectionId: ref.section_id,
            stationRef: ref,
            screenX: mouseEvent.clientX,
            screenY: mouseEvent.clientY,
          });
          break;
        }

        case 'comment': {
          setSelection({ type: 'station', stationRef: ref });
          // Lookup the station's current comment
          const station = stations.find(
            (s) => s.station_ref.section_id === ref.section_id && s.station_ref.station_index === ref.station_index
          );
          const currentComment = station?.comment ?? '';
          useUIStore.getState().setCommentTarget({
            type: 'station',
            stationRef: ref,
            screenPos: { x: mouseEvent.clientX, y: mouseEvent.clientY },
            currentComment,
          });
          break;
        }

        case 'move_comment': {
          const { moveCommentSource, setMoveCommentSource, clearMoveCommentSource } = useUIStore.getState();
          const mcStation = stations.find(
            (s) => s.station_ref.section_id === ref.section_id && s.station_ref.station_index === ref.station_index
          );
          if (!moveCommentSource) {
            // First click: pick up source — just record it, don't mutate backend
            if (!mcStation?.comment) {
              showToast('No comment to move', 'move-comment-empty');
              break;
            }
            setSelection({ type: 'station', stationRef: ref });
            setMoveCommentSource({ type: 'station', stationRef: ref, comment: mcStation.comment, screenPos: { x: mouseEvent.clientX, y: mouseEvent.clientY } });
          } else {
            // Second click: target — use atomic move_comment IPC
            const targetComment = mcStation?.comment ?? '';
            if (targetComment) {
              // Target has comment — open swap dialog
              openDialog('swap-comments', {
                source: moveCommentSource,
                target: { type: 'station', stationRef: ref, comment: targetComment },
              });
            } else {
              // Target empty — atomic move
              const source = moveCommentSource.type === 'station' && moveCommentSource.stationRef
                ? { type: 'station' as const, station_ref: moveCommentSource.stationRef }
                : { type: 'shot' as const, section_id: moveCommentSource.sectionId!, shot_id: moveCommentSource.shotId! };
              const target = { type: 'station' as const, station_ref: ref };
              await useProjectStore.getState().moveComment(source, target, false);
              clearMoveCommentSource();
            }
          }
          break;
        }
      }
    },
    [
      activeTool,
      addToSelection,
      calculateDistance,
      checkAndOpenMergeDialog,
      clearMergeStations,
      isCheckingConnectivity,
      measureStart,
      mergeStationA,
      openDialog,
      options,
      project?.sections,
      setMeasureEnd,
      setMeasureStart,
      setMergeStationA,
      setSelection,
      showStations,
      showToast,
      stations,
      toggleSelection,
      showDistanceGradient,
      setDistanceGradientOrigin,
    ]
  );

  // Handle shot click based on active tool
  const handleShotClick = useCallback(
    async (sectionId: SectionId, shotId: ShotId, event: { originalEvent: MouseEvent }) => {
      // GUARD: No interactions for pan/zoom tools
      if (isNonInteractiveTool(activeTool)) return;

      // GUARD: Block all shot interactions when hidden
      if (!showShots) {
        showToast("Enable 'Shots' in Display menu to interact with shot lines", 'shots-hidden');
        return;
      }

      const mouseEvent = event.originalEvent;
      setSource('map');

      switch (activeTool) {
        case 'select': {
          const sel: Selection = { type: 'shot', sectionId, shotId };
          if (mouseEvent.shiftKey) {
            addToSelection(sel);
          } else if (mouseEvent.ctrlKey || mouseEvent.metaKey) {
            toggleSelection(sel);
          } else {
            setSelection(sel);
          }
          // Distance gradient (#34): re-root on a shot click too. With stations
          // hidden — common (and nicer-looking) while the gradient is on — you
          // can't click a station, so re-root to the shot's lower-numbered
          // endpoint station (section_id, shotIndex).
          if (
            showDistanceGradient &&
            !mouseEvent.shiftKey &&
            !mouseEvent.ctrlKey &&
            !mouseEvent.metaKey
          ) {
            const section = project?.sections.find((s) => s.id === sectionId);
            const shotIndex = section?.shots.findIndex((s) => s.id === shotId) ?? -1;
            if (shotIndex !== -1) {
              setDistanceGradientOrigin({ section_id: sectionId, station_index: shotIndex });
            }
          }
          break;
        }

        case 'move_shot': {
          // Guard: block interaction if either shot endpoint is immovable
          if (options.immovableStationKeys) {
            const section = project?.sections.find((s) => s.id === sectionId);
            if (section) {
              const shotIndex = section.shots.findIndex((s) => s.id === shotId);
              if (shotIndex !== -1) {
                const fromKey = `${sectionId}:${shotIndex}`;
                const toKey = `${sectionId}:${shotIndex + 1}`;
                if (options.immovableStationKeys.has(fromKey) || options.immovableStationKeys.has(toKey)) break;
              }
            }
          }

          // Select the shot and clear other selection effects
          setSelection({ type: 'shot', sectionId, shotId });
          // Find the shot index within the section
          const shotSection = project?.sections.find((s) => s.id === sectionId);
          if (shotSection) {
            const shotIndex = shotSection.shots.findIndex((s) => s.id === shotId);
            if (shotIndex !== -1) {
              options.onMoveDragStart?.({
                type: 'shot',
                sectionId,
                shotIndex,
                screenX: mouseEvent.clientX,
                screenY: mouseEvent.clientY,
              });
            }
          }
          break;
        }

        case 'move_segment': {
          // Start segment move drag from a shot click (same as station click)
          options.onMoveDragStart?.({
            type: 'segment',
            sectionId,
            screenX: mouseEvent.clientX,
            screenY: mouseEvent.clientY,
          });
          break;
        }

        case 'comment': {
          setSelection({ type: 'shot', sectionId, shotId });
          // Lookup the shot's current comment
          const section = project?.sections.find((s) => s.id === sectionId);
          const shot = section?.shots.find((s) => s.id === shotId);
          const currentComment = shot?.comment ?? '';
          useUIStore.getState().setCommentTarget({
            type: 'shot',
            sectionId,
            shotId,
            screenPos: { x: mouseEvent.clientX, y: mouseEvent.clientY },
            currentComment,
          });
          break;
        }

        case 'move_comment': {
          const { moveCommentSource, setMoveCommentSource, clearMoveCommentSource } = useUIStore.getState();
          const mcSection = project?.sections.find((s) => s.id === sectionId);
          const mcShot = mcSection?.shots.find((s) => s.id === shotId);
          if (!moveCommentSource) {
            // First click: pick up source — just record it, don't mutate backend
            if (!mcShot?.comment) {
              showToast('No comment to move', 'move-comment-empty');
              break;
            }
            setSelection({ type: 'shot', sectionId, shotId });
            setMoveCommentSource({ type: 'shot', sectionId, shotId, comment: mcShot.comment, screenPos: { x: mouseEvent.clientX, y: mouseEvent.clientY } });
          } else {
            // Second click: target — use atomic move_comment IPC
            const targetComment = mcShot?.comment ?? '';
            if (targetComment) {
              // Target has comment — open swap dialog
              openDialog('swap-comments', {
                source: moveCommentSource,
                target: { type: 'shot', sectionId, shotId, comment: targetComment },
              });
            } else {
              // Target empty — atomic move
              const source = moveCommentSource.type === 'station' && moveCommentSource.stationRef
                ? { type: 'station' as const, station_ref: moveCommentSource.stationRef }
                : { type: 'shot' as const, section_id: moveCommentSource.sectionId!, shot_id: moveCommentSource.shotId! };
              const target = { type: 'shot' as const, section_id: sectionId, shot_id: shotId };
              await useProjectStore.getState().moveComment(source, target, false);
              clearMoveCommentSource();
            }
          }
          break;
        }
      }
    },
    [activeTool, addToSelection, openDialog, options, project?.sections, setSelection, showShots, showToast, toggleSelection, showDistanceGradient, setDistanceGradientOrigin]
  );

  // Handle empty click (no feature) - but use snapped station if available
  const handleEmptyClick = useCallback(
    (_event: { originalEvent: MouseEvent }) => {
      // If we have a snapped station, use it instead of treating as empty click
      // This enables snap functionality for merge/measure tools
      if (snappedStation) {
        switch (activeTool) {
          case 'merge':
            // GUARD: Block merge snap when stations are hidden
            if (!showStations) {
              showToast("Enable 'Stations' in Display menu to merge", 'stations-hidden');
              return;
            }
            if (isCheckingConnectivity) return;
            if (!mergeStationA) {
              setMergeStationA(snappedStation);
            } else {
              // Check if clicking the same station
              if (
                mergeStationA.section_id === snappedStation.section_id &&
                mergeStationA.station_index === snappedStation.station_index
              ) {
                clearMergeStations();
              } else {
                // Check connectivity and open appropriate dialog
                checkAndOpenMergeDialog(mergeStationA, snappedStation);
              }
            }
            return;

          case 'measure':
            if (!measureStart) {
              setMeasureStart(snappedStation);
            } else {
              setMeasureEnd(snappedStation);
              const result = calculateDistance(measureStart, snappedStation);
              if (result) {
                options.onMeasureComplete?.(result.distance, result.depthDiff);
              }
            }
            return;
        }
      }

      // No snapped station, handle as regular empty click
      switch (activeTool) {
        case 'select':
        case 'move_segment':
          clearSelection();
          break;

        case 'comment':
          useUIStore.getState().clearCommentTarget();
          break;

        case 'move_comment': {
          // Cancel: no backend mutation happened, just clear UI state
          useUIStore.getState().clearMoveCommentSource();
          break;
        }

        case 'merge':
          // Don't clear during connectivity check - the staleness guard handles cancellation
          if (!isCheckingConnectivity) {
            clearMergeStations();
          }
          break;

        case 'measure':
          clearMeasure();
          break;
      }
    },
    [
      activeTool,
      checkAndOpenMergeDialog,
      snappedStation,
      isCheckingConnectivity,
      mergeStationA,
      measureStart,
      calculateDistance,
      clearMeasure,
      clearMergeStations,
      clearSelection,
      openDialog,
      options,
      setMeasureEnd,
      setMeasureStart,
      setMergeStationA,
      showStations,
      showToast,
    ]
  );

  // Handle station hover - only highlights the specific station, not the whole section.
  // Panel-side section-name highlight is derived in SectionsPanel from the hovered
  // shot/station, so we deliberately don't touch hoveredSectionId here (doing so would
  // (a) feed back into SurveyLayer.setHoveredSection and light up the whole section on
  // the map, and (b) get clobbered by the trailing null callback when the cursor moves
  // from a shot to a station).
  const handleStationHover = useCallback(
    (ref: StationRef | null) => {
      // GUARD: No hover for pan/zoom tools
      if (isNonInteractiveTool(activeTool)) {
        setHoveredStation(null);
        return;
      }
      setHoveredStation(ref);
    },
    [activeTool, setHoveredStation]
  );

  // Handle shot hover - only highlights the specific shot, not the whole section.
  // See handleStationHover for why we don't set hoveredSectionId here.
  const handleShotHover = useCallback(
    (shot: { sectionId: SectionId; shotId: ShotId } | null) => {
      // GUARD: No hover for pan/zoom tools
      if (isNonInteractiveTool(activeTool)) {
        setHoveredShot(null);
        return;
      }
      setHoveredShot(shot);
    },
    [activeTool, setHoveredShot]
  );

  // Handle context menu
  const handleContextMenu = useCallback(
    (
      target: { type: 'station'; ref: StationRef } | { type: 'shot'; sectionId: SectionId; shotId: ShotId } | null,
      event: { originalEvent: MouseEvent }
    ) => {
      // ALWAYS prevent native context menu
      event.originalEvent.preventDefault();

      // GUARD: No context menu for pan/zoom tools
      if (isNonInteractiveTool(activeTool)) return;

      if (target) {
        setSource('map');
        // Select the target first
        if (target.type === 'station') {
          setSelection({ type: 'station', stationRef: target.ref });
        } else {
          setSelection({ type: 'shot', sectionId: target.sectionId, shotId: target.shotId });
        }

        // Open context menu
        openDialog('context-menu', {
          target,
          position: { x: event.originalEvent.clientX, y: event.originalEvent.clientY },
        });
      }
    },
    [activeTool, openDialog, setSelection]
  );

  return {
    onStationClick: handleStationClick,
    onShotClick: handleShotClick,
    onEmptyClick: handleEmptyClick,
    onStationHover: handleStationHover,
    onShotHover: handleShotHover,
    onFeatureHover: options.onFeatureHover,
    onContextMenu: handleContextMenu,
  };
}
