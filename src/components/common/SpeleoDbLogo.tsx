import logoUrl from '../../assets/speleodb-logo.png';

/**
 * The official SpeleoDB brand mark (the white line-art cave scene), from the
 * SpeleoDB repo's app icon. It's raster line art (no vector source exists), and
 * already white, so it's shown as-is on a dark chip/button. Decorative - callers
 * provide the accessible label.
 *
 * `tint` recolours the mark (#270: yellow when the project has changes that are
 * only on this computer). The asset is a PNG - white pixels on a fully transparent
 * background - so it is recoloured by using its ALPHA as a mask over a solid block
 * of the tint, which reproduces the line art exactly in the new colour. A CSS
 * `filter` chain would only approximate it, and there is no vector source to
 * `currentColor`.
 */
export function SpeleoDbLogo({
  size = 18,
  className,
  tint,
}: {
  size?: number;
  className?: string;
  /** CSS colour to paint the mark in (e.g. `UNPUSHED_ACCENT`); white when omitted. */
  tint?: string | undefined;
}) {
  if (tint) {
    return (
      <span
        className={className}
        aria-hidden="true"
        data-testid="speleodb-logo-tinted"
        data-tint={tint}
        style={{
          display: 'inline-block',
          width: size,
          height: size,
          backgroundColor: tint,
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
  return (
    <img
      src={logoUrl}
      width={size}
      height={size}
      className={className}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
