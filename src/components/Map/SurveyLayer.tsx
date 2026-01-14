import type { Map as MaplibreMap, MapMouseEvent } from 'maplibre-gl';
import type maplibregl from 'maplibre-gl';
import type { Section, SectionId, ShotId, Station, StationRef, StationMerge } from '../../types/project';
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
  private mergesLayerId = 'survey-merges';
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

    // Labels layer disabled - requires glyphs URL in map style
    // Zero datum stations are shown as larger gold circles instead
    // TODO: Re-enable when glyphs are configured in the map style

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

  update(sections: Section[], stations: Station[], stationMerges?: StationMerge[]) {
    // Build shot features
    const shotFeatures: GeoJSON.Feature[] = [];

    console.log('[SurveyLayer] update called', { sectionsCount: sections.length, stationsCount: stations.length, mergesCount: stationMerges?.length ?? 0 });

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

    // Build merge connection features
    const mergeFeatures: GeoJSON.Feature[] = [];
    if (stationMerges && stationMerges.length > 0) {
      // Helper to find station coordinates
      const findStationCoords = (ref: StationRef) => {
        const station = stations.find(
          (s) => s.station_ref.section_id === ref.section_id && s.station_ref.station_index === ref.station_index
        );
        return station?.coordinates;
      };

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

    console.log(`[SurveyLayer] Created ${shotFeatures.length} shot features, ${stationFeatures.length} station features, ${mergeFeatures.length} merge features`);
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
    if (this.map.getSource(this.sourceId + '-shots')) {
      this.map.removeSource(this.sourceId + '-shots');
    }
    if (this.map.getSource(this.sourceId + '-stations')) {
      this.map.removeSource(this.sourceId + '-stations');
    }
    if (this.map.getSource(this.sourceId + '-merges')) {
      this.map.removeSource(this.sourceId + '-merges');
    }
  }
}
