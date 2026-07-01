import type { ReactNode } from 'react';
import { SpeleoDbLogo } from './SpeleoDbLogo';

/**
 * The SpeleoDB mark with a small state/action badge composited onto its corner
 * (shared by the toolbar status button and the hamburger SpeleoDB submenu, so
 * both speak the same visual language). The badge is a dark disc holding a
 * `currentColor` glyph, coloured by `badgeColor`.
 */
export function SpeleoBadgedIcon({
  badge,
  badgeColor,
  size = 20,
}: {
  badge: ReactNode;
  badgeColor: string;
  size?: number;
}) {
  return (
    <span className="relative inline-flex">
      <SpeleoDbLogo size={size} />
      <span className={`absolute -bottom-1 -right-1 flex items-center justify-center ${badgeColor}`}>
        {badge}
      </span>
    </span>
  );
}

/** Filled hourglass glyph (someone else is editing). */
export function HourglassGlyph({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M4 2h8v3L8 8 4 5V2zM4 14h8v-3L8 8l-4 3v3z" />
    </svg>
  );
}

/** Filled two-arrow circular glyph (refresh / sync with the server). */
export function RefreshGlyph({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z" />
    </svg>
  );
}

/** Filled up-arrow glyph (push to the server). */
export function PushGlyph({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 2l5 6h-3v6H6V8H3l5-6z" />
    </svg>
  );
}

/** Filled exclamation-mark glyph (local/remote conflict). */
export function ExclamationGlyph({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M6.6 2h2.8l-0.5 7h-1.8l-0.5-7z" />
      <circle cx="8" cy="12.4" r="1.5" />
    </svg>
  );
}
