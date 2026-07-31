/**
 * Component test (#357 item 11): the untinted SpeleoDB mark must stay legible
 * on light chrome, not just dark chrome.
 *
 * Before this fix, an untinted mark rendered as a bare `<img>` of white line
 * art on a transparent PNG, which vanished against any light theme
 * (`kaleido_eink`, and PR #361's `light`). No prior test pinned the untinted
 * colour, which is exactly why that shipped. This asserts the untinted mark
 * takes the SAME mask-over-solid-colour path as the tinted mark, with the
 * solid colour set to `currentColor` so it follows the surrounding text
 * colour on any theme, instead of being a bare `<img>` whose colour cannot
 * follow the theme at all.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { SpeleoDbLogo } from './SpeleoDbLogo';

describe('SpeleoDbLogo untinted mark (#357 item 11)', () => {
  it('renders via the mask path and inherits currentColor, not a bare <img>', () => {
    render(<SpeleoDbLogo />);
    // A bare <img> (the old, invisible-on-light path) must not be present.
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    const mark = document.querySelector('[style*="mask-image"]') as HTMLElement | null;
    expect(mark).not.toBeNull();
    // Check the authored inline style, not the computed style: jsdom RESOLVES
    // `currentcolor` to an actual rgb() in `getComputedStyle`, which would pass
    // for any solid colour and defeat the point of this assertion.
    expect(mark?.style.backgroundColor).toBe('currentcolor');
  });

  it('has no tinted testid/attribute when untinted, preserving the #270 contract', () => {
    render(<SpeleoDbLogo />);
    expect(screen.queryByTestId('speleodb-logo-tinted')).not.toBeInTheDocument();
  });

  it('still takes the tinted colour and testid/attribute when a tint is given', () => {
    render(<SpeleoDbLogo tint="#ff0" />);
    const mark = screen.getByTestId('speleodb-logo-tinted');
    expect(mark).toHaveAttribute('data-tint', '#ff0');
    expect(mark).toHaveStyle({ backgroundColor: '#ff0' });
  });
});
