# fn-51-g8j.2 Update tailwind.config.js to reference CSS variables

## Description

Change all hardcoded hex color values in `tailwind.config.js` to reference the `--cc-*` CSS variables defined in task 1. Since the scope was expanded to "theme everything," map visualization colors also get CSS variable references.

## Files to modify

- `tailwind.config.js` — Update `theme.extend.colors` entries

## Implementation

Replace each hardcoded color with its CSS variable equivalent:

```js
colors: {
  // UI Colors — reference CSS variables
  background: 'var(--cc-background)',
  panel: 'var(--cc-panel)',
  border: 'var(--cc-border)',
  'text-primary': 'var(--cc-text-primary)',
  'text-secondary': 'var(--cc-text-secondary)',
  accent: 'var(--cc-accent)',
  warning: 'var(--cc-warning)',
  error: 'var(--cc-error)',
  success: 'var(--cc-success)',

  // Section palette colors — remain hardcoded (per-project display settings)
  'section-teal': '#4ecdc4',
  'section-coral': '#ff6b6b',
  'section-mint': '#95e1d3',
  'section-salmon': '#f38181',
  'section-lavender': '#aa96da',
  'section-pink': '#fcbad3',
  'section-sky': '#a8d8ea',
  'section-peach': '#ffcb77',

  // Map colors — reference CSS variables (scope: theme everything)
  grid: 'var(--cc-grid-default)',
  'zero-datum': 'var(--cc-zero-datum)',
  'virtual-shot': 'rgba(255, 255, 255, 0.25)', // stays as-is (alpha on white)
  'loop-closure': 'var(--cc-warning)', // same as warning color
}
```

**Section palette colors remain hardcoded** because they are per-project display settings stored in `config.section_colors.palette`, not UI chrome.

**`virtual-shot`** stays as rgba since it's a semi-transparent overlay that works on any background.

**Note on opacity modifiers**: Tailwind's `bg-background/50` opacity modifier syntax does NOT work with CSS variable colors. Dedicated opacity variant entries are added in task 11.

## Acceptance

- [ ] All UI chrome colors reference `var(--cc-*)` variables
- [ ] Map colors `grid`, `zero-datum`, `loop-closure` reference CSS variables
- [ ] Section palette colors remain hardcoded hex values
- [ ] `virtual-shot` remains as rgba literal
- [ ] `pnpm tsc --noEmit` passes
- [ ] App renders identically in dark theme (no visual regression)
