import type { StationRef } from '../types/project';
import type { SectionMetadata, SurveyData } from '../types/survey-data';

type ShotTopology = Pick<SurveyData, 'shotStartSectionIds' | 'shotStartIndices'>;
type StationLookup = ReadonlyMap<number, ReadonlyMap<number, number>>;

/** Endpoint aliases come from the backend graph, independently of metadata row order. */
export function shotStartRef(data: ShotTopology, section: SectionMetadata, index: number): StationRef {
  const global = section.shotOffset + index;
  return {
    section_id: data.shotStartSectionIds?.[global] ?? section.id,
    station_index: data.shotStartIndices?.[global] ?? index,
  };
}

export function shotEndRef(section: SectionMetadata, index: number): StationRef {
  return { section_id: section.id, station_index: index + 1 };
}

export function shotStationGlobals(
  data: ShotTopology,
  section: SectionMetadata,
  index: number,
  lookup: StationLookup,
): [number | undefined, number | undefined] {
  const start = shotStartRef(data, section, index);
  return [lookup.get(start.section_id)?.get(start.station_index), lookup.get(section.id)?.get(index + 1)];
}
