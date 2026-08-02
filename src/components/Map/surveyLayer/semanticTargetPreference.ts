import type { MapMouseEvent } from 'maplibre-gl';
import type { SurveyLayerCallbacks } from '../SurveyLayer';
import type { SemanticMapGeometry, SemanticMapTarget } from './semanticTarget';
import { resolveSemanticMapTarget } from './semanticTarget';

interface SemanticTargetPreferenceOptions {
  geometry: () => SemanticMapGeometry | null;
  project: (lngLat: [number, number]) => { x: number; y: number };
  visibility: () => { stations: boolean; shots: boolean };
  callbacks: () => SurveyLayerCallbacks;
}

export class SemanticTargetPreference {
  private target: SemanticMapTarget | null = null;

  constructor(private readonly options: SemanticTargetPreferenceOptions) {}

  set(target: SemanticMapTarget | null): void {
    this.target = target;
  }

  handleClick(
    event: MapMouseEvent,
    stationReach: number,
    shotReach: number,
    suppressStations: boolean,
    suppressShots: boolean,
  ): boolean {
    const resolved = this.take(event, stationReach, shotReach, suppressStations, suppressShots);
    if (resolved?.type === 'station') {
      this.options.callbacks().onStationClick?.(
        { section_id: resolved.sectionId, station_index: resolved.stationIndex },
        event,
      );
      return true;
    }
    if (resolved?.type === 'shot') {
      this.options.callbacks().onShotClick?.(resolved.sectionId, resolved.shotId, event);
      return true;
    }
    return false;
  }

  handleContextMenu(event: MapMouseEvent, stationReach: number, shotReach: number): boolean {
    const resolved = this.take(event, stationReach, shotReach, false, false);
    if (resolved?.type === 'station') {
      this.options.callbacks().onContextMenu?.(
        { type: 'station', ref: { section_id: resolved.sectionId, station_index: resolved.stationIndex } },
        event,
      );
      return true;
    }
    if (resolved?.type === 'shot') {
      this.options.callbacks().onContextMenu?.(
        { type: 'shot', sectionId: resolved.sectionId, shotId: resolved.shotId, alongT: resolved.alongT },
        event,
      );
      return true;
    }
    return false;
  }

  private take(
    event: MapMouseEvent,
    stationReach: number,
    shotReach: number,
    suppressStations: boolean,
    suppressShots: boolean,
  ) {
    const target = this.target;
    this.target = null;
    if (!target) return null;

    const visibility = this.options.visibility();
    if (target.featureType === 'station' && (suppressStations || !visibility.stations)) return null;
    if (target.featureType === 'shot' && (suppressShots || !visibility.shots)) return null;
    const geometry = this.options.geometry();
    if (!geometry) return null;
    return resolveSemanticMapTarget(
      target,
      geometry,
      this.options.project,
      event.point,
      stationReach,
      shotReach,
    );
  }
}
