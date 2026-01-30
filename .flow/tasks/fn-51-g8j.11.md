# fn-51-g8j.11 Migrate Tailwind opacity modifier usage to dedicated opacity tokens

## Description

Replace ALL 29 Tailwind opacity modifier patterns that use theme colors (e.g., `bg-accent/10`, `bg-background/80`, `border-error/30`, `ring-accent/30`, `text-accent/80`) with dedicated CSS variable references. Tailwind's `/N` opacity syntax does NOT work when the color value is a CSS variable (`var(...)`).

**Division of work with tasks 1 and 2:**
- Task 1 defines the `--cc-*-N` opacity CSS variables in both theme blocks
- Task 2 defines the Tailwind color entries for opacity variants (e.g. `'accent-10': 'var(--cc-accent-10)'`)
- **This task** replaces all component-side `color/N` patterns with `color-N`

**Size:** M
**Files:** All component files using Tailwind opacity modifiers on theme colors (29 patterns across many files)

## Approach

### Step 1: Catalog ALL opacity modifier usage

Run comprehensive grep to find ALL instances across `bg|text|border|ring` utilities for ALL theme color families (background, panel, accent, warning, error, success):

```
grep -rn '/(5|10|20|30|50|70|80|85|90)' src/ --include='*.tsx' --include='*.ts'
```

### Step 2: Replace in components

All theme-color opacity patterns become hyphenated:
- `bg-accent/10` → `bg-accent-10`
- `hover:bg-accent/10` → `hover:bg-accent-10`
- `border-warning/30` → `border-warning-30`
- `ring-accent/30` → `ring-accent-30`
- `text-accent/80` → `text-accent-80`
- `text-error/80` → `text-error-80`
- `bg-error/90` → `bg-error-90`
- `border-error/20` → `border-error-20`
- `bg-success/5` → `bg-success-5`
- `border-success/30` → `border-success-30`

### Non-theme patterns: DO NOT change
These use standard Tailwind colors (not CSS variables) so opacity modifiers still work:
- `bg-black/50`, `bg-black/85` — standard Tailwind black
- `bg-red-500/20`, `bg-red-500/30` — standard Tailwind red
- `bg-yellow-500/20` — standard Tailwind yellow

## Complete inventory (29 patterns requiring migration)

### accent family (11)
- `bg-accent/5`, `bg-accent/10`, `bg-accent/20`, `bg-accent/30`, `bg-accent/50`, `bg-accent/70`, `bg-accent/80`, `bg-accent/90`
- `border-accent/20`
- `ring-accent/30`
- `text-accent/80`

### background family (3)
- `bg-background/30`, `bg-background/50`, `bg-background/80`

### panel family (3)
- `bg-panel/20`, `bg-panel/50`, `bg-panel/90`

### error family (5)
- `bg-error/10`, `bg-error/90`
- `border-error/20`, `border-error/30`
- `text-error/80`

### warning family (4)
- `bg-warning/10`, `bg-warning/20`
- `border-warning/20`, `border-warning/30`

### success family (3)
- `bg-success/5`, `bg-success/10`
- `border-success/30`

### Key files (not exhaustive — run grep for complete list)
- `src/components/Dialogs/ExportPreview.tsx` — `bg-background/80` (UI overlay, not render)
- `src/components/Dialogs/SettingsDialog.tsx` — `bg-panel/50`
- `src/components/SingleSystemView/DisplayMenu.tsx` — `hover:bg-background/80`
- `src/components/SingleSystemView/UndoHistoryDropdown.tsx` — `bg-background/80`
- `src/components/common/Button.tsx` — `bg-accent/90`, `hover:bg-accent/90`
- `src/components/common/OfflineIndicator.tsx` — `bg-warning/10`, `border-warning/30`
- `src/components/common/ContextMenu.tsx` — `hover:bg-accent/10`
- `src/components/GlobalView/GlobalView.tsx` — `bg-accent/10`, `bg-accent/20`
- `src/components/GlobalView/GlobalViewMap.tsx` — `bg-panel/90`
- `src/App.tsx` — `bg-accent/20`

## Acceptance

- [ ] Comprehensive grep confirms ALL 29 theme-color opacity patterns found and replaced
- [ ] All `bg-color/N` patterns → `bg-color-N`
- [ ] All `border-color/N` patterns → `border-color-N`
- [ ] All `text-color/N` patterns → `text-color-N`
- [ ] All `ring-color/N` patterns → `ring-color-N`
- [ ] Non-theme patterns (black, red-500, yellow-500) left unchanged
- [ ] `pnpm tsc --noEmit` passes
- [ ] No visual regression in dark theme
- [ ] Correct opacity colors in light theme

## Done summary
Migrated all 29 theme-color Tailwind opacity modifier patterns (color/N → color-N) across the codebase. Replaced bg-accent/10 → bg-accent-10 style patterns for all theme color families (accent, background, panel, error, warning, success) across all utility prefixes (bg, text, border, ring) including hover/focus variants. Non-theme opacity patterns (black/50, red-500/20, yellow-500/20) were correctly left unchanged. TypeScript check passes.
## Evidence
- Commits:
- Tests:
- PRs: