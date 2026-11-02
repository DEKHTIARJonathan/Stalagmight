/**
 * The distance-gradient origin follows its physical station across survey edits
 * (#576 D39(g), "Follow the station").
 *
 * The origin is a positional `StationRef`, and an insert, a delete or a reverse
 * before it renumbers its section silently: the index stays in range and simply
 * starts naming a different station, so the ramp, legend, origin ring and the
 * DetailPanel badge re-root on a neighbour with no error. The gas-plan pins solved
 * the same problem with backend anchors (#310) - a station described by the shots
 * either side of it - and the origin rides the same seam: `captureDistanceOrigin`
 * takes an anchor before the edit, next to `flushPlanAnchors`, and
 * `remapDistanceOrigin` re-resolves it after, next to `remapPlanPins`. That covers
 * a reverse too (an anchor survives one by construction), which is why
 * `applyReverseAftermath` no longer mirrors the origin - doing both would move it
 * twice.
 *
 * Only while a station is picked: the entrance origin (`null`) costs no round trip.
 * A failed capture or re-resolve leaves the origin where it is (positional, as
 * before #576), the same degradation the plan pins accept. A station that no
 * longer exists falls back to the entrance, with a notice.
 */
import type { StationRef } from '../types/project';
import { useUIStore } from '../store/uiStore';
import { planAnchorsForRefs, planRefsForAnchors, type PlanAnchor } from './divePlanApi';
import { TOAST_KEYS } from './toastKeys';
import i18n from '../i18n';

/** An anchor for the origin, with the ref it was taken against. */
export interface OriginCapture {
  ref: StationRef;
  anchor: PlanAnchor;
}

const sameRef = (a: StationRef | null, b: StationRef | null): boolean =>
  a === b || (a !== null && b !== null && a.section_id === b.section_id && a.station_index === b.station_index);

/** Anchor the picked origin against the survey as it stands BEFORE an edit; null when there is
 *  nothing to anchor (the entrance origin) or the backend cannot anchor it. */
export async function captureDistanceOrigin(): Promise<OriginCapture | null> {
  const ref = useUIStore.getState().distanceGradientOrigin;
  if (ref === null) return null;
  try {
    const taken = await planAnchorsForRefs([ref]);
    const anchor = Array.isArray(taken) ? taken[0] : null;
    return anchor === null || anchor === undefined ? null : { ref, anchor };
  } catch (e) {
    console.debug('[distance-origin] anchor capture failed', e);
    return null;
  }
}

/** Re-resolve a captured origin against the survey as it stands AFTER the edit. */
export async function remapDistanceOrigin(capture: OriginCapture | null): Promise<void> {
  if (capture === null) return;
  let resolved: StationRef | null | undefined;
  try {
    const refs = await planRefsForAnchors([capture.anchor]);
    resolved = Array.isArray(refs) ? refs[0] : undefined;
  } catch (e) {
    console.debug('[distance-origin] re-resolve failed', e);
    return;
  }
  if (resolved === undefined) return;
  const ui = useUIStore.getState();
  // A pick (or a project switch, which clears the origin) during the round trip wins.
  if (!sameRef(ui.distanceGradientOrigin, capture.ref)) return;
  if (resolved === null) {
    ui.setDistanceGradientOrigin(null);
    ui.showToast(i18n.t('map.distanceLegend.originRemoved'), TOAST_KEYS.DISTANCE_ORIGIN_RESET, 'info');
    return;
  }
  // Unchanged: leave the cached field alone (the setter clears it).
  if (!sameRef(resolved, capture.ref)) ui.setDistanceGradientOrigin(resolved);
}
