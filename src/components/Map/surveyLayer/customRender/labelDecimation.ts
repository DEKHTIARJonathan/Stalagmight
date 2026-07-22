/**
 * Zoom-band label decimation planning (#customRender labels, Phase 1).
 *
 * The stock shot- and station-label layers thin labels by a zoom-banded
 * `['%', ['get', 'index' | 'globalOrdinal'], N]` filter (SurveyLayer.tsx), with
 * the station layer additionally always showing the first station of each
 * section (`isFirstInSection`). Section names and comments are NOT decimated.
 *
 * The custom renderer reproduces this with a per-kind scalar `u_decim_mod`
 * (recomputed only when the zoom BAND changes — one CPU comparison, no buffer
 * rebuild) plus a per-vertex ordinal + FIRST_IN_SECTION flag the shader reads
 * (`labelShaders.ts`). These pure helpers own the band thresholds and the
 * first-in-section override so the shader uniform and the CPU collision
 * candidate filter (Phase 4/5) agree by construction. See §6 of the design.
 */
import { LABEL_KIND, LABEL_KIND_COUNT, type LabelKind } from './labelShaders';

/**
 * Decimation modulus N for shot / station labels at `zoom`, matching the stock
 * `shotLabelsBaseFilter` / `stationLabelsBaseFilter` bands:
 *   - `[14, 16)` -> 5 (every 5th)
 *   - `[16, 18)` -> 2 (every 2nd)
 *   - `>= 18`    -> 1 (show all)
 * Below zoom 14 the stock filter shows NOTHING, but that hard cutoff is the
 * kind's `minzoom` (the `u_kind_visible` gate), not decimation — so below 14 we
 * return the first visible band's modulus (5); it is moot because the kind is
 * hidden there anyway.
 */
export function shotStationDecimationModulus(zoom: number): number {
  if (zoom < 16) return 5;
  if (zoom < 18) return 2;
  return 1;
}

/**
 * Per-kind decimation modulus at `zoom`. Shot + station labels use the zoom
 * bands; section names and comments never decimate (modulus 1 = show all).
 */
export function decimationModulusForKind(kind: LabelKind, zoom: number): number {
  return kind === LABEL_KIND.SHOT_LABEL || kind === LABEL_KIND.STATION_LABEL
    ? shotStationDecimationModulus(zoom)
    : 1;
}

/** The full `u_decim_mod[5]` uniform array for the current zoom (one slot per
 *  {@link LabelKind}). Cheap enough to rebuild every frame; the controller only
 *  re-uploads it on a zoom-band crossing. */
export function decimationModuli(zoom: number): Float32Array {
  const arr = new Float32Array(LABEL_KIND_COUNT);
  for (let k = 0; k < LABEL_KIND_COUNT; k++) arr[k] = decimationModulusForKind(k as LabelKind, zoom);
  return arr;
}

/**
 * Whether a label is thinned OUT by decimation — the exact predicate the vertex
 * shader evaluates (`n > 1.5 && !firstInSection && mod(ordinal, n) >= 0.5`).
 * A first-in-section station label always survives; a modulus <= 1 shows all.
 * Used by the CPU collision candidate filter so it never collides labels the
 * shader would hide.
 */
export function isLabelDecimatedOut(ordinal: number, modulus: number, firstInSection: boolean): boolean {
  if (firstInSection) return false;
  if (modulus <= 1.5) return false;
  return ordinal % modulus !== 0;
}
