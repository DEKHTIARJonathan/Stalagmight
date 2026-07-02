import logoUrl from '../../assets/speleodb-logo.png';

/**
 * The official SpeleoDB brand mark (the white line-art cave scene), from the
 * SpeleoDB repo's app icon. It's raster line art (no vector source exists), and
 * already white, so it's shown as-is on a dark chip/button. Decorative - callers
 * provide the accessible label.
 */
export function SpeleoDbLogo({ size = 18, className }: { size?: number; className?: string }) {
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
