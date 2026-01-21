import { useCallback } from 'react';
import { useUIStore, type Selection } from '../store/uiStore';
import { useProjectStore } from '../store/projectStore';
import { isNonInteractiveTool } from '../utils/toolUtils';
import type { SectionId, ShotId, StationRef, Coordinates } from '../types/project';
import type { SurveyLayerCallbacks } from '../components/Map/SurveyLayer';

interface MoveDragStartData {
  type: 'section' | 'station';
  sectionId?: number;
  stationRef?: StationRef;
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
    setHoveredSectionId,
    openDialog,
    snappedStation,
    showStations,
    showShots,
    showToast,
  } = useUIStore();

  const { stations, project } = useProjectStore();

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
              // Set station B and open merge dialog
              setMergeStationB(ref);
              openDialog('merge', {
                stationA: mergeStationA,
                stationB: ref,
              });
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
          options.onMoveDragStart?.({ type: 'station', stationRef: ref });
          break;
        }

        case 'move_section': {
          // Find the section for this station
          const section = project?.sections.find((s) => s.id === ref.section_id);
          if (section) {
            setSelection({ type: 'section', sectionId: ref.section_id });
            options.onMoveDragStart?.({ type: 'section', sectionId: ref.section_id });
          }
          break;
        }
      }
    },
    [
      activeTool,
      addToSelection,
      calculateDistance,
      clearMergeStations,
      measureStart,
      mergeStationA,
      openDialog,
      options,
      project?.sections,
      setDrawFromStation,
      setMeasureEnd,
      setMeasureStart,
      setMergeStationA,
      setMergeStationB,
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
                setMergeStationB(snappedStation);
                openDialog('merge', {
                  stationA: mergeStationA,
                  stationB: snappedStation,
                });
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
          clearMergeStations();
          break;

        case 'measure':
          clearMeasure();
          break;
      }
    },
    [
      activeTool,
      snappedStation,
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
      setMergeStationB,
      showStations,
      showToast,
    ]
  );

  // Handle station hover
  // When a station is hovered, set hoveredSectionId for panel highlight
  // When leaving a station (null), only clear hoveredSectionId if no shot is hovered
  // This prevents flicker when transitioning between features in the same section
  const handleStationHover = useCallback(
    (ref: StationRef | null) => {
      // GUARD: No hover for pan/zoom tools
      if (isNonInteractiveTool(activeTool)) {
        setHoveredStation(null);
        setHoveredSectionId(null);
        return;
      }
      setHoveredStation(ref);
      if (ref) {
        // Entering a station - set section for panel highlight
        setHoveredSectionId(ref.section_id);
      } else {
        // Leaving a station - only clear section if no shot is hovered
        // Check current state to avoid flicker during feature transitions
        const { hoveredShot } = useUIStore.getState();
        if (!hoveredShot) {
          setHoveredSectionId(null);
        }
      }
    },
    [activeTool, setHoveredStation, setHoveredSectionId]
  );

  // Handle shot hover
  // When a shot is hovered, set hoveredSectionId for panel highlight
  // When leaving a shot (null), only clear hoveredSectionId if no station is hovered
  // This prevents flicker when transitioning between features in the same section
  const handleShotHover = useCallback(
    (shot: { sectionId: SectionId; shotId: ShotId } | null) => {
      // GUARD: No hover for pan/zoom tools
      if (isNonInteractiveTool(activeTool)) {
        setHoveredShot(null);
        setHoveredSectionId(null);
        return;
      }
      setHoveredShot(shot);
      if (shot) {
        // Entering a shot - set section for panel highlight
        setHoveredSectionId(shot.sectionId);
      } else {
        // Leaving a shot - only clear section if no station is hovered
        // Check current state to avoid flicker during feature transitions
        const { hoveredStation } = useUIStore.getState();
        if (!hoveredStation) {
          setHoveredSectionId(null);
        }
      }
    },
    [activeTool, setHoveredShot, setHoveredSectionId]
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
