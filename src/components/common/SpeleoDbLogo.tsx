/**
 * SpeleoDB brand mark for the action button (T2c). A simple filled "database"
 * cylinder in `currentColor` — a placeholder for the real brand asset, swappable
 * without touching callers. Filled (not stroked) per the WebKit stroke-zoom rule.
 */
export function SpeleoDbLogo({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      {/* top disc */}
      <ellipse cx="10" cy="5" rx="6.5" ry="2.6" />
      {/* body: from the top disc down, closed with the bottom curve */}
      <path d="M3.5 5 V14.6 C3.5 16.1 6.4 17.3 10 17.3 C13.6 17.3 16.5 16.1 16.5 14.6 V5 C16.5 6.5 13.6 7.6 10 7.6 C6.4 7.6 3.5 6.5 3.5 5 Z" />
    </svg>
  );
}
