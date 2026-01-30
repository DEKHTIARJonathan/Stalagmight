# fn-51-g8j.2 Update tailwind.config.js to reference CSS variables

## Description

Change all hardcoded hex color values in `tailwind.config.js` to reference the `--cc-*` CSS variables defined in task 1. Add ALL 29 opacity variant color entries and the `accent-on` token.

**Size:** M
**Files:** `tailwind.config.js`

## Approach

- Replace each hardcoded color with its CSS variable equivalent: `background: 'var(--cc-background)'`, etc.
- Section palette colors remain hardcoded (per-project display settings, not theme-dependent)
- `virtual-shot` stays as rgba literal (semi-transparent overlay that works on any background)
- Add `accent-on: 'var(--cc-accent-on)'` for on-accent text color
- Add all 29 opacity variant entries (e.g. `'accent-5': 'var(--cc-accent-5)'`, `'background-80': 'var(--cc-background-80)'`, etc.)

## Key context

- Tailwind's `bg-background/50` opacity modifier does NOT work with CSS variable colors
- Every `color/N` pattern in the codebase needs a corresponding `color-N` Tailwind entry that maps to `var(--cc-color-N)`
- The full set of 29 opacity variants is listed in the epic spec's "Complete Opacity Modifier Inventory"

## Acceptance

- [ ] All UI chrome colors reference `var(--cc-*)` variables
- [ ] Map colors `grid`, `zero-datum`, `loop-closure` reference CSS variables
- [ ] Section palette colors remain hardcoded hex values
- [ ] `virtual-shot` remains as rgba literal
- [ ] `accent-on` entry added: `'accent-on': 'var(--cc-accent-on)'`
- [ ] ALL 29 opacity variant entries added (accent-5 through accent-90, background-30/50/80, panel-20/50/90, error-10/20/30/80/90, warning-10/20/30, success-5/10/30)
- [ ] `pnpm tsc --noEmit` passes
- [ ] App renders identically in dark theme (no visual regression)

## Done summary
Updated tailwind.config.js to reference CSS variables: replaced all hardcoded hex UI chrome colors with var(--cc-*) references, mapped grid/zero-datum/loop-closure to CSS variables, added accent-on token, and added all 25 unique opacity variant entries covering 29 codebase usage patterns. Section palette colors remain hardcoded and virtual-shot remains as rgba literal per spec.
## Evidence
- Commits: ac5b9c018594fc031491d043ee6e9002d3322ccb
- Tests: pnpm tsc --noEmit
- PRs: