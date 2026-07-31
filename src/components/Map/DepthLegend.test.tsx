import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DepthLegend } from './DepthLegend';
import { getDepthColor } from '../../utils/colors';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => opts?.min ? `${opts.min}-${opts.max}` : key }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

/**
 * Guard against the legend drifting from the map: a CSS/SVG gradient with only
 * two stops interpolates in sRGB, but `getDepthColor` interpolates in HSL along
 * the SHORTEST hue path (src/utils/colors.ts:179). Those two only agree at the
 * endpoints - any theme whose shallow/deep hues are more than 180deg apart (or
 * whose saturation/lightness differ) will show a visibly different gradient
 * mid-ramp. This asserts every rendered <stop> matches `getDepthColor` exactly,
 * so a future rewrite back to a naive 2-stop gradient fails loudly here instead
 * of shipping a legend that lies about what the map drew.
 */
describe('DepthLegend', () => {
  it('every gradient stop matches getDepthColor at the same t (hue-path parity)', () => {
    const shallowColor = '#a89060'; // hue ~35 (tan)
    const deepColor = '#b85048'; // hue ~5 (salmon) - a case where naive RGB and
    // HSL-shortest-path interpolation diverge visibly in the interior.
    const minDepth = 0;
    const maxDepth = 50;

    const { container } = render(
      <DepthLegend
        minDepth={minDepth}
        maxDepth={maxDepth}
        shallowColor={shallowColor}
        deepColor={deepColor}
        visible
      />
    );

    const stops = Array.from(container.querySelectorAll('stop'));
    expect(stops.length).toBeGreaterThan(2);

    for (const stop of stops) {
      const offsetPct = parseFloat(stop.getAttribute('offset') ?? '0');
      const t = offsetPct / 100;
      const depth = minDepth + t * (maxDepth - minDepth);
      const expected = getDepthColor(depth, shallowColor, deepColor, minDepth, maxDepth);
      expect(stop.getAttribute('stop-color')).toBe(expected);
    }
  });
});
