import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Tooltip } from '../common/Tooltip';
import { useTileAttribution } from '../../hooks/useTileAttribution';

/**
 * Below this width the source names cannot be read at a glance, so the overlay
 * collapses to the `i` affordance. Esri allows exactly this: "Offer an
 * expandable UI when names don't fit on small screens."
 *
 * Sized from the string it has to hold - the Esri World Imagery list runs about
 * 66 characters, which needs ~400px at 12px - plus room for the map chrome it
 * shares the bottom edge with.
 */
const COMPACT_BELOW_PX = 460;

/** Pointer dwell before the compact panel opens. */
const HOVER_OPEN_MS = 350;
/** Grace after the pointer leaves, so a wobble does not dismiss it. */
const HOVER_CLOSE_MS = 150;

/**
 * Esri's recommended attribution styling, applied verbatim rather than through
 * the app's theme tokens. This chip sits on photographic imagery, not on app
 * chrome: a themed panel colour is legible against one basemap and invisible
 * against the next, whereas #323232 on white-at-65% is the pairing Esri
 * specifies and tests against its own tiles. Same reasoning in both themes -
 * the imagery underneath does not get darker because the UI did.
 */
const CHIP_STYLE = {
  color: '#323232',
  backgroundColor: 'rgba(255, 255, 255, 0.65)',
  fontFamily: '"Avenir Next W00", "Helvetica Neue", Helvetica, Arial, sans-serif',
  fontSize: '12px',
} as const;

interface MapAttributionProps {
  /** Tile provider whose imagery is on screen. */
  provider?: string;
  /**
   * Whether imagery is currently drawn. Attribution is required exactly as long
   * as the imagery is visible, so this must track the layer, not the map.
   */
  visible: boolean;
  /**
   * `auto` shows the names inline when there is room and collapses below
   * {@link COMPACT_BELOW_PX}. `compact` forces the collapsed form - for small
   * surfaces like the Section Preview, where inline names would cover the very
   * thing being previewed.
   */
  variant?: 'auto' | 'compact';
  /** Positioning classes; the caller owns where on the map this sits. */
  className?: string;
}

/**
 * The on-map data attribution for satellite imagery.
 *
 * Esri splits its attribution requirements in two, and only one half belongs
 * here. The *source names* must be "directly on or at the bottom of the map
 * where it is always visible" - that is this component. The "Powered by Esri"
 * notice may live "in a window that is accessible from a menu or button", so it
 * is credited in the About dialog instead and deliberately does NOT appear here;
 * spending scarce map real estate on text the licence does not require it to
 * carry makes the part that IS required harder to read. See
 * https://developers.arcgis.com/documentation/esri-and-data-attribution/interactive-maps/
 */
export function MapAttribution({
  provider = 'esri',
  visible,
  variant = 'auto',
  className = '',
}: MapAttributionProps) {
  const { t } = useTranslation();
  const { text } = useTileAttribution(provider);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  const [pinned, setPinned] = useState(false);

  // Measure the map area this sits over, not the chip itself: the chip shrinks
  // to whatever it renders, so measuring it would make the decision circular.
  useLayoutEffect(() => {
    if (!visible || variant === 'compact') return;
    const host = wrapperRef.current?.parentElement;
    if (!host) return;

    const measure = () => setNarrow(host.clientWidth < COMPACT_BELOW_PX);
    measure();

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [visible, variant]);

  // Escape closes a pinned panel, matching every other dismissible layer.
  useEffect(() => {
    if (!pinned) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPinned(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pinned]);

  // Imagery gone means the obligation is gone. Also drop the pin, so it does not
  // spring back open the next time the layer returns.
  useEffect(() => {
    if (!visible) setPinned(false);
  }, [visible]);

  const togglePinned = useCallback(() => setPinned((v) => !v), []);

  if (!visible || !text) return null;

  const isCompact = variant === 'compact' || narrow;

  if (!isCompact) {
    return (
      <div
        ref={wrapperRef}
        className={`pointer-events-none select-none rounded px-1.5 py-0.5 leading-tight ${className}`}
        style={CHIP_STYLE}
        data-testid="map-attribution"
      >
        <span data-testid="map-attribution-text">{text}</span>
      </div>
    );
  }

  return (
    <div ref={wrapperRef} className={className} data-testid="map-attribution">
      <Tooltip
        content={<span data-testid="map-attribution-text">{text}</span>}
        openDelayMs={HOVER_OPEN_MS}
        closeDelayMs={HOVER_CLOSE_MS}
        // Pinning wins over hover, so a click (or a tap, which produces no
        // hover at all) keeps the names up until they are dismissed.
        open={pinned || undefined}
        tooltipTestId="map-attribution-panel"
      >
        <button
          type="button"
          onClick={togglePinned}
          // Keyboard users get the same panel: tabbing to the button pins it,
          // tabbing away releases it.
          onFocus={() => setPinned(true)}
          onBlur={() => setPinned(false)}
          aria-expanded={pinned}
          aria-label={t('map.attribution.expandAria')}
          title={text}
          className="flex h-5 w-5 items-center justify-center rounded-full font-semibold leading-none"
          style={CHIP_STYLE}
          data-testid="map-attribution-toggle"
        >
          i
        </button>
      </Tooltip>
    </div>
  );
}

export default MapAttribution;
