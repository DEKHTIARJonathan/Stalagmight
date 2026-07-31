import logoUrl from '../../assets/speleodb-logo.png';

/**
 * The official SpeleoDB brand mark (the white line-art cave scene), from the
 * SpeleoDB repo's app icon. It's raster line art (no vector source exists).
 * Decorative - callers provide the accessible label.
 *
 * The asset is a PNG - white pixels on a fully transparent background - so it
 * is always recoloured by using its ALPHA as a mask over a solid colour block,
 * which reproduces the line art exactly in the chosen colour. A CSS `filter`
 * chain would only approximate it, and there is no vector source to
 * `currentColor` directly, hence the mask. `tint` recolours the mark (#270:
 * yellow when the project has changes that are only on this computer); when
 * omitted, the mark inherits `currentColor` so it stays legible against
 * whatever chrome (light or dark) it's placed on.
 */
export function SpeleoDbLogo({
  size = 18,
  className,
  tint,
}: {
  size?: number;
  className?: string;
  /** CSS colour to paint the mark in (e.g. `UNPUSHED_ACCENT`); `currentColor` when omitted. */
  tint?: string | undefined;
}) {
  return (
    <span
      className={className}
      aria-hidden="true"
      {...(tint ? { 'data-testid': 'speleodb-logo-tinted', 'data-tint': tint } : {})}
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        backgroundColor: tint ?? 'currentColor',
        maskImage: `url(${logoUrl})`,
        WebkitMaskImage: `url(${logoUrl})`,
        maskSize: 'contain',
        WebkitMaskSize: 'contain',
        maskRepeat: 'no-repeat',
        WebkitMaskRepeat: 'no-repeat',
        maskPosition: 'center',
        WebkitMaskPosition: 'center',
      }}
    />
  );
}
