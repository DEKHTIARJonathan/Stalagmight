# fn-51-g8j.2 Update tailwind.config.js to reference CSS variables

## Description

Change all hardcoded hex color values in `tailwind.config.js` to reference the `--cc-*` CSS variables defined in task 1.

## Files to modify

- `tailwind.config.js` — Update `theme.extend.colors` entries

## Implementation

Replace each hardcoded color with its CSS variable equivalent:

```js
colors: {
  // UI Colors - now reference CSS variables
  background: 'var(--cc-background)',
  panel: 'var(--cc-panel)',
  border: 'var(--cc-border)',
  'text-primary': 'var(--cc-text-primary)',
  'text-secondary': 'var(--cc-text-secondary)',
  accent: 'var(--cc-accent)',
  warning: 'var(--cc-warning)',
  error: 'var(--cc-error)',
  success: 'var(--cc-success)',
  // Section palette colors — remain hardcoded (per-project, not theme-dependent)
  'section-teal': '#4ecdc4',
  'section-coral': '#ff6b6b',
  'section-mint': '#95e1d3',
  'section-salmon': '#f38181',
  'section-lavender': '#aa96da',
  'section-pink': '#fcbad3',
  'section-sky': '#a8d8ea',
  'section-peach': '#ffcb77',
  // Map colors — remain hardcoded (per-project display settings)
  grid: '#333366',
  'zero-datum': '#ffd700',
  'virtual-shot': 'rgba(255, 255, 255, 0.25)',
  'loop-closure': '#ffcb77',
}
```

**Important**: Section palette and map colors stay hardcoded because they are per-project display settings, not UI chrome colors.

**Note on opacity modifiers**: Tailwind's `bg-background/50` opacity modifier syntax does NOT work with CSS variable colors. This is expected. For opacity variants, use the dedicated `--cc-hover` variable or Tailwind's `bg-[var(--cc-background)]` with opacity utilities instead.

## Acceptance

- [ ] All UI chrome colors reference `var(--cc-*)` variables
- [ ] Section palette colors remain hardcoded hex values
- [ ] Map colors remain hardcoded hex values
- [ ] `pnpm tsc --noEmit` passes
- [ ] App renders identically in dark theme (no visual regression)
