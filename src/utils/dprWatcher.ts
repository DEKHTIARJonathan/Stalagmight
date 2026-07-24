/**
 * Notify `onChange` whenever the device pixel ratio changes — e.g. the desktop
 * window is dragged to a monitor with a different scale factor. Returns a dispose
 * function.
 *
 * The custom WebGL layers bake `devicePixelRatio` into device-pixel sizes at
 * build time (line widths, station radii, highlight sizes, antialiasing). MapLibre
 * resizes its drawing buffer on a DPR change, but nothing recomputes those baked
 * sizes, so shots/stations/labels render at the wrong CSS size until an unrelated
 * rebuild. Callers use this to resync their custom layers when it fires.
 *
 * Implementation: a `matchMedia((resolution: <dpr>dppx))` listener fires once when
 * the current DPR stops matching; the handler re-arms against the NEW dpr (a media
 * query is bound to a fixed value, so it must be recreated each time). No-ops in a
 * non-DOM / matchMedia-less environment.
 */
export function watchDevicePixelRatio(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }

  let mql: MediaQueryList | null = null;

  const handler = (): void => {
    onChange();
    arm();
  };

  const arm = (): void => {
    if (mql) mql.removeEventListener('change', handler);
    mql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    mql.addEventListener('change', handler);
  };

  arm();

  return () => {
    if (mql) mql.removeEventListener('change', handler);
    mql = null;
  };
}
