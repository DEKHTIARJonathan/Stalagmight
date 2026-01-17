import type { Map as MaplibreMap, MapMouseEvent } from 'maplibre-gl';
import type maplibregl from 'maplibre-gl';
import type { Section, SectionId, ShotId, Station, StationRef, StationMerge, LoopClosure } from '../../types/project';
import { metersToMapCoords } from '../../utils/coordinates';

export interface SurveyLayerCallbacks {
  onStationClick?: (ref: StationRef, event: MapMouseEvent) => void;
  onShotClick?: (sectionId: SectionId, shotId: ShotId, event: MapMouseEvent) => void;
  onEmptyClick?: (event: MapMouseEvent) => void;
  onStationHover?: (ref: StationRef | null) => void;
  onShotHover?: (shot: { sectionId: SectionId; shotId: ShotId } | null) => void;
  onFeatureHover?: ((isHovering: boolean) => void) | undefined;
  onContextMenu?: (
    target: { type: 'station'; ref: StationRef } | { type: 'shot'; sectionId: SectionId; shotId: ShotId } | null,
    event: MapMouseEvent
  ) => void;
}

/**
 * Survey layer that renders shots and stations on the map
 *
 * This is a simplified implementation using MapLibre GL JS.
 * For better performance with large datasets, this could be
 * replaced with deck.gl layers.
 */
export default class SurveyLayer {
  private map: MaplibreMap;
  private sourceId = 'survey-data';
  private shotsLayerId = 'survey-shots';
  private stationsLayerId = 'survey-stations';
  private labelsLayerId = 'survey-labels';
  private shotLabelsLayerId = 'survey-shot-labels';
  private mergesLayerId = 'survey-merges';
  private loopClosuresLayerId = 'survey-loop-closures';
  private callbacks: SurveyLayerCallbacks;

  // Visual state
  private selectedStationId: string | null = null;
  private selectedShotId: string | null = null;
  private hoveredStationId: string | null = null;
  private hoveredShotId: string | null = null;
  private snappedStationId: string | null = null;

  constructor(map: MaplibreMap, callbacks: SurveyLayerCallbacks = {}) {
    this.map = map;
    this.callbacks = callbacks;
    this.initializeSources();
    this.initializeLayers();
    this.initializeEventHandlers();
  }

  setCallbacks(callbacks: SurveyLayerCallbacks) {
    this.callbacks = callbacks;
  }

  private initializeSources() {
    // Shots line source
    this.map.addSource(this.sourceId + '-shots', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: [],
      },
    });

    // Stations point source
    this.map.addSource(this.sourceId + '-stations', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: [],
      },
    });

    // Merge connections line source
    this.map.addSource(this.sourceId + '-merges', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: [],
      },
    });

    // Loop closures line source
    this.map.addSource(this.sourceId + '-loop-closures', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: [],
      },
    });

    // Shot labels point source (midpoint of each shot)
    this.map.addSource(this.sourceId + '-shot-labels', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: [],
      },
    });

    // Section name labels point source (first station of each section)
    this.map.addSource(this.sourceId + '-section-labels', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: [],
      },
    });
  }

  private initializeLayers() {
    // Merge connections layer (dashed lines) - rendered first so it's behind everything
    this.map.addLayer({
      id: this.mergesLayerId,
      type: 'line',
      source: this.sourceId + '-merges',
      paint: {
        'line-color': '#00cccc', // Cyan for merge connections
        'line-width': 2,
        'line-opacity': 0.5,
        'line-dasharray': [4, 4], // Dashed line
      },
    });

    // Loop closures layer (dashed lines with color based on error severity)
    this.map.addLayer({
      id: this.loopClosuresLayerId,
      type: 'line',
      source: this.sourceId + '-loop-closures',
      paint: {
        // Color based on error percentage: green (<1%), yellow (1-3%), orange (3-5%), red (>5%)
        'line-color': ['get', 'color'],
        'line-width': 3,
        'line-opacity': 0.8,
        'line-dasharray': [6, 4], // Longer dashes than regular merges
      },
    });

    // Shots layer (lines) - solid lines, virtual shots handled by opacity
    this.map.addLayer({
      id: this.shotsLayerId,
      type: 'line',
      source: this.sourceId + '-shots',
      paint: {
        'line-color': ['get', 'color'],
        'line-width': 2,
        'line-opacity': ['case', ['get', 'isVirtual'], 0.5, 1],
      },
    });

    // Stations layer (circles)
    this.map.addLayer({
      id: this.stationsLayerId,
      type: 'circle',
      source: this.sourceId + '-stations',
      paint: {
        'circle-radius': [
          'case',
          ['get', 'isZeroDatum'],
          8,
          4,
        ],
        'circle-color': [
          'case',
          ['get', 'isZeroDatum'],
          '#ffd700',
          ['get', 'color'],
        ],
        // Stroke width varies based on selection/hover state (updated dynamically)
        'circle-stroke-width': 1,
        'circle-stroke-color': '#000000',
      },
    });

    // Shot data labels layer - shows azimuth, length, depth at shot midpoint
    // Visibility controlled by showShotLabels toggle and zoom-based density
    this.map.addLayer({
      id: this.shotLabelsLayerId,
      type: 'symbol',
      source: this.sourceId + '-shot-labels',
      layout: {
        'text-field': ['get', 'label'],
        'text-font': ['Open Sans Regular'],
        'text-size': [
          'interpolate',
          ['linear'],
          ['zoom'],
          14, 9,
          18, 12,
        ],
        'text-offset': [0, 0.5],
        'text-anchor': 'top',
        // Progressive density: hide labels at low zoom
        'text-allow-overlap': false,
        'visibility': 'none', // Start hidden, controlled by setShowShotLabels
      },
      paint: {
        'text-color': '#ffffff',
        'text-halo-color': '#000000',
        'text-halo-width': 1.5,
        'text-opacity': [
          'interpolate',
          ['linear'],
          ['zoom'],
          14, 0.7,
          18, 1,
        ],
      },
      filter: [
        'case',
        // At zoom < 14: show nothing (filter all)
        ['<', ['zoom'], 14],
        false,
        // At zoom 14-16: show every 5th label (index % 5 == 0)
        ['all', ['>=', ['zoom'], 14], ['<', ['zoom'], 16]],
        ['==', ['%', ['get', 'index'], 5], 0],
        // At zoom 16-18: show every 2nd label
        ['all', ['>=', ['zoom'], 16], ['<', ['zoom'], 18]],
        ['==', ['%', ['get', 'index'], 2], 0],
        // At zoom >= 18: show all
        true,
      ],
    });

    // Section name labels layer - shows section name at first station
    // Visibility controlled by showSectionNames toggle
    this.map.addLayer({
      id: this.labelsLayerId,
      type: 'symbol',
      source: this.sourceId + '-section-labels',
      layout: {
        'text-field': ['get', 'name'],
        'text-font': ['Open Sans Regular'],
        'text-size': [
          'interpolate',
          ['linear'],
          ['zoom'],
          12, 11,
          18, 14,
        ],
        'text-offset': [0, -1.2],
        'text-anchor': 'bottom',
        'text-allow-overlap': true,
        'visibility': 'visible', // Start visible, controlled by setShowSectionNames
      },
      paint: {
        'text-color': ['get', 'color'],
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.5,
        'text-opacity': 1,
      },
    });

  }

  private initializeEventHandlers() {
    // Station click handler
    this.map.on('click', this.stationsLayerId, (e) => {
      e.preventDefault();
      const feature = e.features?.[0];
      if (feature?.properties) {
        const { sectionId, stationIndex } = feature.properties;
        const ref: StationRef = {
          section_id: sectionId as number,
          station_index: stationIndex as number,
        };
        this.callbacks.onStationClick?.(ref, e);
      }
    });

    // Shot click handler
    this.map.on('click', this.shotsLayerId, (e) => {
      e.preventDefault();
      const feature = e.features?.[0];
      if (feature?.properties) {
        const { sectionId, shotId } = feature.properties;
        this.callbacks.onShotClick?.(sectionId as number, shotId as number, e);
      }
    });

    // Empty click handler (on map, not on features)
    this.map.on('click', (e) => {
      // Check if we clicked on a feature
      const stationFeatures = this.map.queryRenderedFeatures(e.point, { layers: [this.stationsLayerId] });
      const shotFeatures = this.map.queryRenderedFeatures(e.point, { layers: [this.shotsLayerId] });

      if (stationFeatures.length === 0 && shotFeatures.length === 0) {
        this.callbacks.onEmptyClick?.(e);
      }
    });

    // Station hover handlers
    this.map.on('mouseenter', this.stationsLayerId, (e) => {
      this.map.getCanvas().style.cursor = 'pointer';
      this.callbacks.onFeatureHover?.(true);
      const feature = e.features?.[0];
      if (feature?.properties) {
        const { sectionId, stationIndex } = feature.properties;
        const ref: StationRef = {
          section_id: sectionId as number,
          station_index: stationIndex as number,
        };
        this.hoveredStationId = `${sectionId}:${stationIndex}`;
        this.callbacks.onStationHover?.(ref);
        this.updateVisualState();
      }
    });

    this.map.on('mouseleave', this.stationsLayerId, () => {
      this.callbacks.onFeatureHover?.(false);
      this.hoveredStationId = null;
      this.callbacks.onStationHover?.(null);
      this.updateVisualState();
    });

    // Shot hover handlers
    this.map.on('mouseenter', this.shotsLayerId, (e) => {
      this.map.getCanvas().style.cursor = 'pointer';
      this.callbacks.onFeatureHover?.(true);
      const feature = e.features?.[0];
      if (feature?.properties) {
        const { sectionId, shotId } = feature.properties;
        this.hoveredShotId = `${sectionId}:${shotId}`;
        this.callbacks.onShotHover?.({ sectionId: sectionId as number, shotId: shotId as number });
        this.updateVisualState();
      }
    });

    this.map.on('mouseleave', this.shotsLayerId, () => {
      this.callbacks.onFeatureHover?.(false);
      this.hoveredShotId = null;
      this.callbacks.onShotHover?.(null);
      this.updateVisualState();
    });

    // Context menu handler
    this.map.on('contextmenu', (e) => {
      const stationFeatures = this.map.queryRenderedFeatures(e.point, { layers: [this.stationsLayerId] });
      const shotFeatures = this.map.queryRenderedFeatures(e.point, { layers: [this.shotsLayerId] });

      if (stationFeatures.length > 0) {
        const feature = stationFeatures[0];
        if (feature?.properties) {
          const { sectionId, stationIndex } = feature.properties;
          const ref: StationRef = {
            section_id: sectionId as number,
            station_index: stationIndex as number,
          };
          this.callbacks.onContextMenu?.({ type: 'station', ref }, e);
        }
      } else if (shotFeatures.length > 0) {
        const feature = shotFeatures[0];
        if (feature?.properties) {
          const { sectionId, shotId } = feature.properties;
          this.callbacks.onContextMenu?.({ type: 'shot', sectionId: sectionId as number, shotId: shotId as number }, e);
        }
      } else {
        this.callbacks.onContextMenu?.(null, e);
      }
    });
  }

  // Update visual state for selection/hover/snap highlighting
  private updateVisualState() {
    // Build station ID expression for matching
    const stationIdExpr = ['concat', ['to-string', ['get', 'sectionId']], ':', ['to-string', ['get', 'stationIndex']]];

    // Update station stroke width based on snap/hover/selection (snap takes priority for visual feedback)
    this.map.setPaintProperty(this.stationsLayerId, 'circle-stroke-width', [
      'case',
      ['==', stationIdExpr, this.snappedStationId ?? ''],
      4, // Snapped station has prominent ring
      ['==', stationIdExpr, this.hoveredStationId ?? ''],
      3,
      ['==', stationIdExpr, this.selectedStationId ?? ''],
      2,
      1,
    ]);

    // Update station stroke color for snap/selection/hover
    this.map.setPaintProperty(this.stationsLayerId, 'circle-stroke-color', [
      'case',
      ['==', stationIdExpr, this.snappedStationId ?? ''],
      '#00ffcc', // Cyan/teal for snap indicator
      ['==', stationIdExpr, this.selectedStationId ?? ''],
      '#00aaff',
      ['==', stationIdExpr, this.hoveredStationId ?? ''],
      '#0066ff',
      '#000000',
    ]);

    // Update station radius when snapped for extra visibility
    this.map.setPaintProperty(this.stationsLayerId, 'circle-radius', [
      'case',
      ['==', stationIdExpr, this.snappedStationId ?? ''],
      7, // Slightly larger when snapped
      ['get', 'isZeroDatum'],
      8,
      4,
    ]);

    // Update shot line width based on hover/selection
    this.map.setPaintProperty(this.shotsLayerId, 'line-width', [
      'case',
      ['==', ['concat', ['to-string', ['get', 'sectionId']], ':', ['to-string', ['get', 'shotId']]], this.hoveredShotId ?? ''],
      4,
      ['==', ['concat', ['to-string', ['get', 'sectionId']], ':', ['to-string', ['get', 'shotId']]], this.selectedShotId ?? ''],
      3,
      2,
    ]);
  }

  // Set selected station (called from outside to sync with uiStore)
  setSelectedStation(ref: StationRef | null) {
    this.selectedStationId = ref ? `${ref.section_id}:${ref.station_index}` : null;
    this.updateVisualState();
  }

  // Set selected shot (called from outside to sync with uiStore)
  setSelectedShot(sectionId: SectionId | null, shotId: ShotId | null) {
    this.selectedShotId = sectionId !== null && shotId !== null ? `${sectionId}:${shotId}` : null;
    this.updateVisualState();
  }

  // Set snapped station (called from outside for snap indicator)
  setSnappedStation(ref: StationRef | null) {
    this.snappedStationId = ref ? `${ref.section_id}:${ref.station_index}` : null;
    this.updateVisualState();
  }

  // Control shot data labels visibility
  setShowShotLabels(show: boolean) {
    this.map.setLayoutProperty(
      this.shotLabelsLayerId,
      'visibility',
      show ? 'visible' : 'none'
    );
  }

  // Control section name labels visibility
  setShowSectionNames(show: boolean) {
    this.map.setLayoutProperty(
      this.labelsLayerId,
      'visibility',
      show ? 'visible' : 'none'
    );
  }

  update(sections: Section[], stations: Station[], stationMerges?: StationMerge[], loopClosures?: LoopClosure[]) {
    // Build shot features and shot label features
    const shotFeatures: GeoJSON.Feature[] = [];
    const shotLabelFeatures: GeoJSON.Feature[] = [];
    let globalShotIndex = 0;

    console.log('[SurveyLayer] update called', { sectionsCount: sections.length, stationsCount: stations.length, mergesCount: stationMerges?.length ?? 0, loopClosuresCount: loopClosures?.length ?? 0 });

    for (const section of sections) {
      const sectionStations = stations
        .filter((s) => s.station_ref.section_id === section.id)
        .sort((a, b) => a.station_ref.station_index - b.station_ref.station_index);

      console.log(`[SurveyLayer] Section ${section.id}: ${section.shots.length} shots, ${sectionStations.length} stations`);

      for (let i = 0; i < section.shots.length; i++) {
        const shot = section.shots[i];
        const fromStation = sectionStations[i];
        const toStation = sectionStations[i + 1];

        if (!fromStation || !toStation) {
          console.warn(`[SurveyLayer] Missing station for shot ${i}: from=${!!fromStation}, to=${!!toStation}`);
        }

        if (fromStation && toStation && shot) {
          shotFeatures.push({
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: [
                metersToMapCoords(fromStation.coordinates.x, fromStation.coordinates.y),
                metersToMapCoords(toStation.coordinates.x, toStation.coordinates.y),
              ],
            },
            properties: {
              sectionId: section.id,
              shotId: shot.id,
              color: section.color,
              isVirtual: shot.is_virtual,
              length: shot.length,
              azimuth: shot.azimuth_in,
            },
          });

          // Generate shot label at midpoint
          const midX = (fromStation.coordinates.x + toStation.coordinates.x) / 2;
          const midY = (fromStation.coordinates.y + toStation.coordinates.y) / 2;
          const avgDepth = (fromStation.coordinates.z + toStation.coordinates.z) / 2;

          // Format: "45° 3.2m -12.5m" (azimuth, length, depth)
          const label = `${shot.azimuth_in.toFixed(0)}° ${shot.length.toFixed(1)}m ${avgDepth.toFixed(1)}m`;

          shotLabelFeatures.push({
            type: 'Feature',
            geometry: {
              type: 'Point',
              coordinates: metersToMapCoords(midX, midY),
            },
            properties: {
              label,
              index: globalShotIndex,
              sectionId: section.id,
              shotId: shot.id,
            },
          });

          globalShotIndex++;
        }
      }
    }

    // Build station features
    const stationFeatures: GeoJSON.Feature[] = stations.map((station) => {
      // Find section color for this station
      const section = sections.find((s) => s.id === station.station_ref.section_id);
      const color = section?.color ?? '#ffffff';

      return {
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: metersToMapCoords(station.coordinates.x, station.coordinates.y),
        },
        properties: {
          sectionId: station.station_ref.section_id,
          stationIndex: station.station_ref.station_index,
          isZeroDatum: station.is_zero_datum,
          isMerged: station.merged_with.length > 0,
          depth: station.coordinates.z,
          color,
        },
      };
    });

    // Helper to find station coordinates (used by merges and loop closures)
    const findStationCoords = (ref: StationRef) => {
      const station = stations.find(
        (s) => s.station_ref.section_id === ref.section_id && s.station_ref.station_index === ref.station_index
      );
      return station?.coordinates;
    };

    // Build merge connection features
    const mergeFeatures: GeoJSON.Feature[] = [];
    if (stationMerges && stationMerges.length > 0) {
      for (const merge of stationMerges) {
        const coordsA = findStationCoords(merge.station_a);
        const coordsB = findStationCoords(merge.station_b);

        if (coordsA && coordsB) {
          mergeFeatures.push({
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: [
                metersToMapCoords(coordsA.x, coordsA.y),
                metersToMapCoords(coordsB.x, coordsB.y),
              ],
            },
            properties: {
              stationA: `${merge.station_a.section_id}:${merge.station_a.station_index}`,
              stationB: `${merge.station_b.section_id}:${merge.station_b.station_index}`,
            },
          });
        }
      }
    }

    // Build section name label features (at first station of each section)
    const sectionLabelFeatures: GeoJSON.Feature[] = [];
    for (const section of sections) {
      // Find the first station (station_index === 0) for this section
      const firstStation = stations.find(
        (s) => s.station_ref.section_id === section.id && s.station_ref.station_index === 0
      );
      if (firstStation) {
        sectionLabelFeatures.push({
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: metersToMapCoords(firstStation.coordinates.x, firstStation.coordinates.y),
          },
          properties: {
            name: section.name,
            color: section.color,
            sectionId: section.id,
          },
        });
      }
    }

    console.log(`[SurveyLayer] Created ${shotFeatures.length} shot features, ${stationFeatures.length} station features, ${mergeFeatures.length} merge features, ${sectionLabelFeatures.length} section label features`);
    if (shotFeatures.length > 0) {
      console.log('[SurveyLayer] First shot feature:', JSON.stringify(shotFeatures[0]));
    }

    // Update sources
    const shotsSource = this.map.getSource(this.sourceId + '-shots');
    if (shotsSource && 'setData' in shotsSource) {
      (shotsSource as maplibregl.GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: shotFeatures,
      });
    }

    const stationsSource = this.map.getSource(this.sourceId + '-stations');
    if (stationsSource && 'setData' in stationsSource) {
      (stationsSource as maplibregl.GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: stationFeatures,
      });
    }

    const mergesSource = this.map.getSource(this.sourceId + '-merges');
    if (mergesSource && 'setData' in mergesSource) {
      (mergesSource as maplibregl.GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: mergeFeatures,
      });
    }

    // Update shot labels source
    const shotLabelsSource = this.map.getSource(this.sourceId + '-shot-labels');
    if (shotLabelsSource && 'setData' in shotLabelsSource) {
      (shotLabelsSource as maplibregl.GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: shotLabelFeatures,
      });
    }

    // Update section labels source
    const sectionLabelsSource = this.map.getSource(this.sourceId + '-section-labels');
    if (sectionLabelsSource && 'setData' in sectionLabelsSource) {
      (sectionLabelsSource as maplibregl.GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: sectionLabelFeatures,
      });
    }

    // Build loop closure features with severity-based colors
    const loopClosureFeatures: GeoJSON.Feature[] = [];
    if (loopClosures && loopClosures.length > 0) {
      // Helper function to get color based on error percentage
      const getErrorColor = (errorPct: number): string => {
        if (errorPct < 1) return '#22c55e'; // Green - excellent
        if (errorPct < 3) return '#eab308'; // Yellow - acceptable
        if (errorPct < 5) return '#f97316'; // Orange - marginal
        return '#ef4444'; // Red - poor
      };

      for (const closure of loopClosures) {
        const coordsA = findStationCoords(closure.station_a);
        const coordsB = findStationCoords(closure.station_b);

        if (coordsA && coordsB) {
          loopClosureFeatures.push({
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: [
                metersToMapCoords(coordsA.x, coordsA.y),
                metersToMapCoords(coordsB.x, coordsB.y),
              ],
            },
            properties: {
              stationA: `${closure.station_a.section_id}:${closure.station_a.station_index}`,
              stationB: `${closure.station_b.section_id}:${closure.station_b.station_index}`,
              errorPercentage: closure.error_percentage,
              misclosureDistance: closure.misclosure_distance,
              pathLength: closure.path_length,
              color: getErrorColor(closure.error_percentage),
            },
          });
        }
      }
    }

    const loopClosuresSource = this.map.getSource(this.sourceId + '-loop-closures');
    if (loopClosuresSource && 'setData' in loopClosuresSource) {
      (loopClosuresSource as maplibregl.GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: loopClosureFeatures,
      });
    }
  }

  destroy() {
    if (this.map.getLayer(this.labelsLayerId)) {
      this.map.removeLayer(this.labelsLayerId);
    }
    if (this.map.getLayer(this.stationsLayerId)) {
      this.map.removeLayer(this.stationsLayerId);
    }
    if (this.map.getLayer(this.shotsLayerId)) {
      this.map.removeLayer(this.shotsLayerId);
    }
    if (this.map.getLayer(this.mergesLayerId)) {
      this.map.removeLayer(this.mergesLayerId);
    }
    if (this.map.getLayer(this.loopClosuresLayerId)) {
      this.map.removeLayer(this.loopClosuresLayerId);
    }
    if (this.map.getSource(this.sourceId + '-shots')) {
      this.map.removeSource(this.sourceId + '-shots');
    }
    if (this.map.getSource(this.sourceId + '-stations')) {
      this.map.removeSource(this.sourceId + '-stations');
    }
    if (this.map.getSource(this.sourceId + '-merges')) {
      this.map.removeSource(this.sourceId + '-merges');
    }
    if (this.map.getSource(this.sourceId + '-loop-closures')) {
      this.map.removeSource(this.sourceId + '-loop-closures');
    }
    if (this.map.getSource(this.sourceId + '-section-labels')) {
      this.map.removeSource(this.sourceId + '-section-labels');
    }
    if (this.map.getSource(this.sourceId + '-shot-labels')) {
      this.map.removeSource(this.sourceId + '-shot-labels');
    }
    if (this.map.getLayer(this.shotLabelsLayerId)) {
      this.map.removeLayer(this.shotLabelsLayerId);
    }
  }
}
