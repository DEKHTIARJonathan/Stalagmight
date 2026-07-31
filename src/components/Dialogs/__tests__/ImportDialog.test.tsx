/**
 * #357 item 9 (second half) - a section's colour is per-project user data.
 * Recolouring an already-decided section when the theme changes is explicitly
 * rejected on the issue: a survey must keep the colour it was created with.
 * `ImportDialog` restores `savedFormState.color` when reopening after a
 * placement cancel, and that restore path must win over the theme-aware
 * seed - a section a user already picked (or was seeded on a previous
 * render) must not be silently recoloured just because `resolvedTheme`
 * changed underneath it.
 *
 * `.tsx` so vitest runs it under jsdom.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('../../../utils/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/telemetry')>()),
  trackDialogComplete: vi.fn(),
  setSource: vi.fn(),
}));

import ImportDialog from '../ImportDialog';
import { useUIStore } from '../../../store/uiStore';
import { useProjectStore } from '../../../store/projectStore';
import { SECTION_COLORS, LIGHT_SECTION_COLORS } from '../../../utils/colors';

// DialogWrapper renders via a portal, so the input lives on document.body
// rather than under the RTL container.
function getColorInputValue(): string {
  const input = document.body.querySelector('input[type="color"]') as HTMLInputElement | null;
  if (!input) throw new Error('color input not found');
  return input.value;
}

beforeEach(() => {
  useUIStore.setState({
    dialogData: {},
    resolvedTheme: 'dark',
  });
  useProjectStore.setState({ project: null, config: null });
});

describe('ImportDialog color seeding (#357 item 9)', () => {
  it('seeds a brand-new section from the theme-appropriate palette', () => {
    useUIStore.setState({ dialogData: {}, resolvedTheme: 'light' });
    render(<ImportDialog />);
    expect(getColorInputValue().toLowerCase()).toBe(LIGHT_SECTION_COLORS[0]!.toLowerCase());
  });

  it('does NOT rewrite a restored color when the theme differs from the one it was seeded under', () => {
    // Simulates reopening the dialog (after a placement cancel) under a
    // different theme than the one active when this color was picked: a
    // dark-palette color, restored while `resolvedTheme` is now 'light'.
    const persistedColor = SECTION_COLORS[0]!;
    useUIStore.setState({
      dialogData: { savedFormState: { name: '', surveyor: '', date: '', color: persistedColor, shots: [], showLrud: false } },
      resolvedTheme: 'light',
    });
    render(<ImportDialog />);
    const value = getColorInputValue().toLowerCase();
    expect(value).toBe(persistedColor.toLowerCase());
    // The important negative: it must NOT have been reseeded from the light
    // canvas palette just because the theme is now light.
    expect(LIGHT_SECTION_COLORS.map((c) => c.toLowerCase())).not.toContain(value);
  });
});
