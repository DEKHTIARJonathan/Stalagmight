import { useShallow } from 'zustand/react/shallow';
import type { Station } from '../types/project';
import { useProjectStore } from '../store/projectStore';
import { useUIStore } from '../store/uiStore';
import { selectActiveStations } from '../store/geometrySelectors';

/**
 * Station coordinates for the active geometry display mode: the measured set in
 * `measured` mode (and as a fallback before the adjusted set is fetched), the
 * closure-adjusted set in `closureAdjusted` mode.
 *
 * Read-only consumers that *show or compute coordinates* (coordinate inspection,
 * the measure tool) should use this so they stay consistent with what the map
 * draws. Editing paths and headline stats keep using the measured `stations`
 * directly - adjustment is non-destructive and stats are always measured.
 */
export function useActiveStations(): Station[] {
  const geometryMode = useUIStore((s) => s.geometryMode);
  const slice = useProjectStore(
    useShallow((s) => ({
      stations: s.stations,
      surveyData: s.surveyData,
      stationsAdjusted: s.stationsAdjusted,
      surveyDataAdjusted: s.surveyDataAdjusted,
    }))
  );
  return selectActiveStations(slice, geometryMode);
}
