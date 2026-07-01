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
      {/* The disc is the panel BACKGROUND colour (like the DisplayMenu badge-bg,
          fill: var(--cc-panel)) so it knocks the icon out around the badge - a
          cutout, not a coloured circle. */}
      <span
        className={`absolute -bottom-1 -right-1 flex items-center justify-center rounded-full bg-panel p-[1px] ${badgeColor}`}
      >
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

/**
 * Filled pencil with a slash through it (read-only / web-viewer: you can view
 * but not edit). The slash carries a panel-coloured under-stroke so it reads as
 * a distinct diagonal cut across the pencil.
 */
export function CrossedPencilGlyph({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      {/* vertical pencil, tip pointing down */}
      <path d="M5.4 2h3.2v9l-1.6 3-1.6-3z" />
      {/* diagonal "no" slash: a wider panel-coloured line underneath cuts a gap so
          the slash reads as separate from the pencil, then the slash on top. */}
      <path d="M2.5 13.5L13.5 2.5" style={{ stroke: 'var(--cc-panel)' }} strokeWidth={3.4} />
      <path d="M2.5 13.5L13.5 2.5" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" />
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

/**
 * "Edit without lock" glyph (#213): a pencil + exclamation in a single
 * badge-sized box (so it takes no more space than the other badges), entirely in
 * `currentColor`. The exclamation carries a panel-coloured border (painted under
 * its fill) so it reads as separate from the pencil.
 */
export function EditNoLockGlyph({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      {/* vertical pencil (left), tip pointing down */}
      <path d="M2.8 2h3.2v9l-1.6 3-1.6-3z" />
      {/* exclamation right beside it, with a panel-coloured border to separate it */}
      <g
        style={{ stroke: 'var(--cc-panel)' }}
        strokeWidth={1.3}
        strokeLinejoin="round"
        strokeLinecap="round"
        paintOrder="stroke"
      >
        <path d="M7.7 2h2.3l-0.4 6.4h-1.5z" />
        <circle cx="8.85" cy="12" r="1.3" />
      </g>
    </svg>
  );
}
