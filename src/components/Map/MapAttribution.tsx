import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Tooltip } from '../common/Tooltip';
import { useTileAttribution } from '../../hooks/useTileAttribution';

/**
 * Below this host width the source names cannot fit on the bottom edge, so the
 * overlay collapses to the `i` affordance. Esri allows exactly this: "Offer an
 * expandable UI when names don't fit on small screens."
 *
 * Budgeted against everything sharing that edge, measured at 10px:
 *   340  the Esri World Imagery list (~66 characters) plus the bar's padding
 *  + 85  right inset: the Data dock's tab (~45px) at its own 40px inset
 *  + 110 the MapLibre ScaleControl at the other end, plus a gap
 *  = 535, rounded up.
 *
 * Undershooting here does not merely crowd the bar - it slides the names under
 * the scale bar, which is the obstruction Esri's terms forbid.
 */
const COMPACT_BELOW_PX = 540;

/** Pointer dwell before the compact panel opens. */
const HOVER_OPEN_MS = 350;
/** Grace after the pointer leaves, so a wobble does not dismiss it. */
const HOVER_CLOSE_MS = 150;

/**
 * Themed surface, shared by the inline bar and the compact button.
 *
 * These are the app's own tokens rather than Esri's recommended fixed palette
 * (#323232 on white at 65%), so a dark theme gets a dark chip instead of a white
 * card punched into the map. Esri's colours are a recommendation, not a term;
 * what the terms require is that the names be legible and unobstructed, and a
 * panel-coloured chip carrying the app's own text colour is legible in whichever
 * theme is actually on screen.
 *
 * Deliberately the same tokens the Data dock's tab uses (`PanelOpenerTab`), because
 * the bar sits directly alongside it on the map's bottom edge and the two should
 * read as one row of chrome.
 */
const CHIP_SURFACE = 'bg-panel-90 text-text-secondary border-border';

/**
 * Font size. Below Esri's recommended 12px minimum, which is design guidance
 * rather than a term of use; the requirement it serves - legible source names -
 * still holds at this size against a themed backing. Attribution is a credit the
 * map has to carry, not something it should compete with.
 */
const CHIP_TEXT = 'text-[10px] leading-none';

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
  /** Positioning styles, for insets that come from a shared layout constant. */
  style?: CSSProperties;
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
  style,
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
        // A bottom-flush bar, not a floating card: `min-h-6` with centred
        // content rather than a tight vertical padding, so the names sit on the
        // bar's centre line instead of riding its top edge. Top-left is the only
        // rounded corner, because it is the only exposed one - the bottom meets
        // the map's edge and the right butts the Data dock's tab. `border-r` is
        // dropped for the same reason: the tab brings its own left border, and
        // two abutting borders read as a double rule.
        className={`pointer-events-none flex min-h-6 select-none items-center border-l border-t px-2 rounded-tl ${CHIP_SURFACE} ${CHIP_TEXT} ${className}`}
        style={style}
        data-testid="map-attribution"
      >
        <span data-testid="map-attribution-text">{text}</span>
      </div>
    );
  }

  return (
    <div ref={wrapperRef} className={className} style={style} data-testid="map-attribution">
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
          // Stays a round badge rather than inheriting the bar's single rounded
          // corner: it is a control, and a one-cornered `i` reads as clipped.
          className={`flex h-5 w-5 items-center justify-center rounded-full border font-semibold ${CHIP_SURFACE} ${CHIP_TEXT}`}
          data-testid="map-attribution-toggle"
        >
          i
        </button>
      </Tooltip>
    </div>
  );
}

export default MapAttribution;
