import type { Map as MaplibreMap } from 'maplibre-gl';
import type maplibregl from 'maplibre-gl';
import type { Section, Station } from '../../types/project';

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

  constructor(map: MaplibreMap) {
    this.map = map;
    this.initializeSources();
    this.initializeLayers();
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
  }

  private initializeLayers() {
    // Shots layer (lines)
    this.map.addLayer({
      id: this.shotsLayerId,
      type: 'line',
      source: this.sourceId + '-shots',
      paint: {
        'line-color': ['get', 'color'],
        'line-width': 2,
        'line-dasharray': [
          'case',
          ['get', 'isVirtual'],
          ['literal', [2, 2]],
          ['literal', [1, 0]],
        ],
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
          '#ffffff',
        ],
        'circle-stroke-width': 1,
        'circle-stroke-color': '#000000',
      },
    });

    // Labels layer (for zero datum)
    this.map.addLayer({
      id: this.labelsLayerId,
      type: 'symbol',
      source: this.sourceId + '-stations',
      filter: ['==', ['get', 'isZeroDatum'], true],
      layout: {
        'text-field': 'ZD',
        'text-size': 10,
        'text-offset': [1, 0],
        'text-anchor': 'left',
      },
      paint: {
        'text-color': '#ffd700',
        'text-halo-color': '#000000',
        'text-halo-width': 1,
      },
    });

    // Add click handlers
    this.map.on('click', this.stationsLayerId, (e) => {
      const feature = e.features?.[0];
      if (feature) {
        console.log('Station clicked:', feature.properties);
        // TODO: Dispatch selection event
      }
    });

    this.map.on('click', this.shotsLayerId, (e) => {
      const feature = e.features?.[0];
      if (feature) {
        console.log('Shot clicked:', feature.properties);
        // TODO: Dispatch selection event
      }
    });

    // Hover cursors
    this.map.on('mouseenter', this.stationsLayerId, () => {
      this.map.getCanvas().style.cursor = 'pointer';
    });

    this.map.on('mouseleave', this.stationsLayerId, () => {
      this.map.getCanvas().style.cursor = '';
    });

    this.map.on('mouseenter', this.shotsLayerId, () => {
      this.map.getCanvas().style.cursor = 'pointer';
    });

    this.map.on('mouseleave', this.shotsLayerId, () => {
      this.map.getCanvas().style.cursor = '';
    });
  }

  update(sections: Section[], stations: Station[]) {
    // Build shot features
    const shotFeatures: GeoJSON.Feature[] = [];

    for (const section of sections) {
      const sectionStations = stations.filter(
        (s) => s.station_ref.section_id === section.id
      );

      for (let i = 0; i < section.shots.length; i++) {
        const shot = section.shots[i];
        const fromStation = sectionStations[i];
        const toStation = sectionStations[i + 1];

        if (fromStation && toStation && shot) {
          shotFeatures.push({
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: [
                [fromStation.coordinates.x, fromStation.coordinates.y],
                [toStation.coordinates.x, toStation.coordinates.y],
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
    const stationFeatures: GeoJSON.Feature[] = stations.map((station) => ({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [station.coordinates.x, station.coordinates.y],
      },
      properties: {
        sectionId: station.station_ref.section_id,
        stationIndex: station.station_ref.station_index,
        isZeroDatum: station.is_zero_datum,
        isMerged: station.merged_with.length > 0,
        depth: station.coordinates.z,
      },
    }));

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
    if (this.map.getSource(this.sourceId + '-shots')) {
      this.map.removeSource(this.sourceId + '-shots');
    }
    if (this.map.getSource(this.sourceId + '-stations')) {
      this.map.removeSource(this.sourceId + '-stations');
    }
  }
}
