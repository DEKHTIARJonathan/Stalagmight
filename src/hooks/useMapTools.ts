import { useCallback, useRef, useState } from 'react';
import { useUIStore, type Selection } from '../store/uiStore';
import { useProjectStore } from '../store/projectStore';
import { isNonInteractiveTool } from '../utils/toolUtils';
import type { SectionId, ShotId, StationRef, Coordinates } from '../types/project';
import type { SurveyLayerCallbacks } from '../components/Map/SurveyLayer';

interface MoveDragStartData {
  type: 'section' | 'station';
  sectionId?: number;
  stationRef?: StationRef;
  /** Screen coordinates of the click that initiated the drag */
  screenX?: number;
  screenY?: number;
}

interface MapToolsOptions {
  onMeasureComplete?: (distance: number, depthDiff: number) => void;
  onMoveDragStart?: (data: MoveDragStartData) => void;
  onFeatureHover?: (isHovering: boolean) => void;
}

export function useMapTools(options: MapToolsOptions = {}): SurveyLayerCallbacks {
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
    setDrawFromStation,
    setHoveredStation,
    setHoveredShot,
    openDialog,
    snappedStation,
    showStations,
    showShots,
    showToast,
  } = useUIStore();

  const { stations, project, checkMergeConnectivity } = useProjectStore();

  const [isCheckingConnectivity, setIsCheckingConnectivity] = useState(false);
  // Ref-based guard prevents re-entrancy from fast successive clicks
  const connectivityInFlightRef = useRef(false);
  // Monotonic request ID for staleness detection
  const connectivityRequestIdRef = useRef(0);

  // Get station coordinates by ref
  const getStationCoordinates = useCallback(
    (ref: StationRef): Coordinates | null => {
      const station = stations.find(
        (s) => s.station_ref.section_id === ref.section_id && s.station_ref.station_index === ref.station_index
      );
      return station?.coordinates ?? null;
    },
    [stations]
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
        if (result.connected) {
          openDialog('closure', {
            stationA,
            stationB,
            preview: result.preview,
          });
        } else {
          openDialog('merge', {
            stationA,
            stationB,
          });
        }
      } catch (e) {
        if (requestId !== connectivityRequestIdRef.current) return;
        const message = e instanceof Error ? e.message : String(e);
        showToast(message, 'merge-error');
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
    (ref: StationRef, event: { originalEvent: MouseEvent }) => {
      // GUARD: No interactions for pan/zoom tools
      if (isNonInteractiveTool(activeTool)) return;

      // GUARD: Block all station interactions when hidden
      if (!showStations) {
        showToast("Enable 'Stations' in Display menu to interact with station markers", 'stations-hidden');
        return;
      }

      const mouseEvent = event.originalEvent;

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
          break;
        }

        case 'delete': {
          // For now, we can't delete individual stations - need to delete shots
          // Show a message or open a dialog explaining this
          openDialog('confirm-delete', {
            type: 'station',
            stationRef: ref,
            message: 'Deleting a station will also delete all connected shots.',
          });
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

        case 'draw': {
          setDrawFromStation(ref);
          openDialog('draw-shot', { fromStation: ref });
          break;
        }

        case 'move_station': {
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

        case 'move_section': {
          // Find the section for this station
          const section = project?.sections.find((s) => s.id === ref.section_id);
          if (section) {
            setSelection({ type: 'section', sectionId: ref.section_id });
            options.onMoveDragStart?.({
              type: 'section',
              sectionId: ref.section_id,
              screenX: mouseEvent.clientX,
              screenY: mouseEvent.clientY,
            });
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
      setDrawFromStation,
      setMeasureEnd,
      setMeasureStart,
      setMergeStationA,
      setSelection,
      showStations,
      showToast,
      toggleSelection,
    ]
  );

  // Handle shot click based on active tool
  const handleShotClick = useCallback(
    (sectionId: SectionId, shotId: ShotId, event: { originalEvent: MouseEvent }) => {
      // GUARD: No interactions for pan/zoom tools
      if (isNonInteractiveTool(activeTool)) return;

      // GUARD: Block all shot interactions when hidden
      if (!showShots) {
        showToast("Enable 'Shots' in Display menu to interact with shot lines", 'shots-hidden');
        return;
      }

      const mouseEvent = event.originalEvent;

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
          break;
        }

        case 'delete': {
          openDialog('confirm-delete', {
            type: 'shot',
            sectionId,
            shotId,
            message: 'Are you sure you want to delete this shot?',
          });
          break;
        }

        // Other tools don't respond to shot clicks
      }
    },
    [activeTool, addToSelection, openDialog, setSelection, showShots, showToast, toggleSelection]
  );

  // Handle empty click (no feature) - but use snapped station if available
  const handleEmptyClick = useCallback(
    (_event: { originalEvent: MouseEvent }) => {
      // If we have a snapped station, use it instead of treating as empty click
      // This enables snap functionality for draw/merge/measure tools
      if (snappedStation) {
        switch (activeTool) {
          case 'draw':
            setDrawFromStation(snappedStation);
            openDialog('draw-shot', { fromStation: snappedStation });
            return;

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
          clearSelection();
          break;

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
      setDrawFromStation,
      setMeasureEnd,
      setMeasureStart,
      setMergeStationA,
      showStations,
      showToast,
    ]
  );

  // Handle station hover - only highlights the specific station, not the whole section
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

  // Handle shot hover - only highlights the specific shot, not the whole section
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
