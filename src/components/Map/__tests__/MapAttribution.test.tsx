/**
 * Component tests for the on-map Esri attribution.
 *
 * The defect these guard is the one that shipped: three MapLibre instances built
 * with `attributionControl: false`, so imagery drew with no attribution at all.
 * The obligations under test come from
 * https://developers.arcgis.com/documentation/esri-and-data-attribution/interactive-maps/
 *
 *   - the source names are visible for as long as the imagery is drawn
 *   - they may collapse behind an expandable affordance when they do not fit
 *   - they render offline, because the fallback is what the field sees
 *   - "Powered by Esri" is NOT here (it belongs in About, which is allowed)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';

const invokeIpc = vi.fn();
vi.mock('../../../utils/ipc', () => ({
  invokeIpc: (...args: unknown[]) => invokeIpc(...args),
}));

import '../../../i18n';
import { MapAttribution, primarySourceName } from '../MapAttribution';
import { resetTileAttributionCache } from '../../../hooks/useTileAttribution';

const FALLBACK = 'Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community';
const LIVE = 'Source: Esri, Somebody New, and the GIS User Community';

/**
 * Force the auto variant one way or the other. `MapAttribution` measures the
 * element it is positioned over, and jsdom reports 0 for every dimension, which
 * would silently pin every test to the compact branch.
 */
function setHostWidth(width: number) {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return width;
    },
  });
}

beforeEach(() => {
  resetTileAttributionCache();
  invokeIpc.mockReset();
  invokeIpc.mockResolvedValue({
    provider: 'esri',
    text: LIVE,
    notice: 'Powered by Esri',
    notice_url: 'https://www.esri.com',
    live: true,
  });
  setHostWidth(1200);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MapAttribution', () => {
  it('renders the source names while imagery is drawn', async () => {
    render(<MapAttribution visible />);
    expect(await screen.findByTestId('map-attribution-text')).toHaveTextContent(LIVE);
  });

  it('renders nothing when the imagery is not drawn', () => {
    // The obligation tracks the layer, not the map: satellite off means there is
    // nothing to attribute, and a stale credit over a blank map is wrong.
    render(<MapAttribution visible={false} />);
    expect(screen.queryByTestId('map-attribution')).not.toBeInTheDocument();
  });

  it('shows the compiled-in names before the live value arrives', () => {
    let resolve!: (v: unknown) => void;
    invokeIpc.mockReturnValue(new Promise((r) => { resolve = r; }));

    render(<MapAttribution visible />);

    // Imagery is already on screen at this point, so "attribution pending" is
    // not an acceptable state to render.
    expect(screen.getByTestId('map-attribution-text')).toHaveTextContent(FALLBACK);
    act(() => resolve({ provider: 'esri', text: LIVE, notice: null, notice_url: null, live: true }));
  });

  it('keeps the compiled-in names when the backend call fails', async () => {
    // The offline case, which is the normal case in a cave.
    invokeIpc.mockRejectedValue(new Error('offline'));
    render(<MapAttribution visible />);
    await waitFor(() =>
      expect(screen.getByTestId('map-attribution-text')).toHaveTextContent(FALLBACK),
    );
  });

  it('keeps the compiled-in names when the backend answers with an empty string', async () => {
    invokeIpc.mockResolvedValue({
      provider: 'esri',
      text: '',
      notice: null,
      notice_url: null,
      live: true,
    });
    render(<MapAttribution visible />);
    await waitFor(() =>
      expect(screen.getByTestId('map-attribution-text')).toHaveTextContent(FALLBACK),
    );
  });

  it('does not put the "Powered by Esri" notice on the map', async () => {
    render(<MapAttribution visible />);
    await screen.findByTestId('map-attribution-text');
    // Esri allows that notice behind a menu or button, and the About dialog
    // carries it. Map space goes to what the licence actually requires there.
    expect(screen.queryByText(/Powered by Esri/)).not.toBeInTheDocument();
  });

  describe('chrome', () => {
    it('takes its colours from the theme rather than a fixed palette', async () => {
      render(<MapAttribution visible />);
      const chip = await screen.findByTestId('map-attribution');
      // This shipped with Esri's recommended #323232-on-white applied inline,
      // which punched a white card into the dark theme. The durable guard is
      // that no colour is hard-coded at all: the tokens resolve per theme.
      expect(chip.style.color).toBe('');
      expect(chip.style.backgroundColor).toBe('');
      expect(chip.className).toContain('bg-panel-90');
      expect(chip.className).toContain('text-text-secondary');
    });

    it('rounds only its top-left corner', async () => {
      // It is a bottom-flush bar butted against the map edge and the Data dock
      // tab, not a floating card - a fully rounded chip reads as detached, and
      // top-left is the sole corner not meeting something.
      render(<MapAttribution visible />);
      const chip = await screen.findByTestId('map-attribution');
      // Token-wise, not substring: `rounded-tl` contains `rounded`.
      const rounding = [...chip.classList].filter((c) => c.startsWith('rounded'));
      expect(rounding).toEqual(['rounded-tl']);
    });
  });

  describe('compact affordance', () => {
    it('collapses when the map is too narrow for the names', async () => {
      setHostWidth(300);
      render(<MapAttribution visible />);
      expect(await screen.findByTestId('map-attribution-toggle')).toBeInTheDocument();
      expect(screen.queryByTestId('map-attribution-text')).not.toBeInTheDocument();
    });

    it('is forced regardless of width for small surfaces', async () => {
      // The Section Preview passes variant="compact": it is a few hundred pixels
      // square and exists to show the geometry underneath.
      setHostWidth(1200);
      render(<MapAttribution visible variant="compact" />);
      expect(await screen.findByTestId('map-attribution-toggle')).toBeInTheDocument();
    });

    it('opens the names only after the pointer dwells', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      render(<MapAttribution visible variant="compact" />);
      const toggle = await screen.findByTestId('map-attribution-toggle');

      fireEvent.mouseEnter(toggle.parentElement as HTMLElement);
      // A cursor crossing the corner of a map must not flash the panel open.
      expect(screen.queryByTestId('map-attribution-panel')).not.toBeInTheDocument();

      act(() => { vi.advanceTimersByTime(400); });
      expect(screen.getByTestId('map-attribution-panel')).toHaveTextContent(LIVE);
    });

    it('pins open on click, for pointers that never hover', async () => {
      render(<MapAttribution visible variant="compact" />);
      const toggle = await screen.findByTestId('map-attribution-toggle');

      fireEvent.click(toggle);
      expect(screen.getByTestId('map-attribution-panel')).toHaveTextContent(LIVE);
      expect(toggle).toHaveAttribute('aria-expanded', 'true');

      fireEvent.click(toggle);
      expect(screen.queryByTestId('map-attribution-panel')).not.toBeInTheDocument();
    });

    it('opens on focus so the names are reachable by keyboard', async () => {
      render(<MapAttribution visible variant="compact" />);
      const toggle = await screen.findByTestId('map-attribution-toggle');

      fireEvent.focus(toggle);
      expect(screen.getByTestId('map-attribution-panel')).toHaveTextContent(LIVE);

      fireEvent.blur(toggle);
      expect(screen.queryByTestId('map-attribution-panel')).not.toBeInTheDocument();
    });

    it('closes a pinned panel on Escape', async () => {
      render(<MapAttribution visible variant="compact" />);
      const toggle = await screen.findByTestId('map-attribution-toggle');

      fireEvent.click(toggle);
      expect(screen.getByTestId('map-attribution-panel')).toBeInTheDocument();

      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByTestId('map-attribution-panel')).not.toBeInTheDocument();
    });

    it('names the primary source rather than showing a bare i', async () => {
      // A lone `i` credits nobody. The collapsed chip stays an attribution by
      // naming the first source, with the rest of the list in the panel.
      render(<MapAttribution visible variant="compact" />);
      expect(await screen.findByTestId('map-attribution-label')).toHaveTextContent('by Esri');
    });

    it('falls back to the bare i when no source name can be read', async () => {
      invokeIpc.mockResolvedValue({
        provider: 'esri',
        text: 'Sources:',
        notice: null,
        notice_url: null,
        live: true,
      });
      render(<MapAttribution visible variant="compact" />);
      // "Sources:" parses to nothing; inventing a name would be worse than the
      // fallback list, which is what actually renders here.
      const toggle = await screen.findByTestId('map-attribution-toggle');
      expect(toggle).toBeInTheDocument();
    });

    it('carries the names on the button itself, so they survive a missed hover', async () => {
      render(<MapAttribution visible variant="compact" />);
      const toggle = await screen.findByTestId('map-attribution-toggle');
      expect(toggle).toHaveAttribute('title', LIVE);
      expect(toggle).toHaveAccessibleName();
    });
  });

  describe('primarySourceName', () => {
    it('reads the first source out of the live Esri string', () => {
      expect(primarySourceName(LIVE)).toBe('Esri');
      expect(primarySourceName(FALLBACK)).toBe('Esri');
    });

    it('tolerates either prefix spelling and none at all', () => {
      // Both appear across ArcGIS services, and a service may use neither.
      expect(primarySourceName('Sources: Esri, TomTom, Garmin')).toBe('Esri');
      expect(primarySourceName('source:Esri, TomTom')).toBe('Esri');
      expect(primarySourceName('Esri, TomTom')).toBe('Esri');
    });

    it('yields nothing rather than a stray fragment', () => {
      expect(primarySourceName('')).toBe('');
      expect(primarySourceName('Source:')).toBe('');
      expect(primarySourceName('   ')).toBe('');
    });
  });

  it('asks the backend once no matter how many surfaces are mounted', async () => {
    // All three map surfaces can be on screen together; that must not mean three
    // round trips for one string.
    render(
      <>
        <MapAttribution visible />
        <MapAttribution visible />
        <MapAttribution visible variant="compact" />
      </>,
    );
    await screen.findAllByTestId('map-attribution');
    expect(invokeIpc).toHaveBeenCalledTimes(1);
    expect(invokeIpc).toHaveBeenCalledWith(
      'get_tile_attribution',
      { provider: 'esri' },
      expect.anything(),
    );
  });
});
