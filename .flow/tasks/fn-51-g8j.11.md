# fn-51-g8j.11 Migrate Tailwind opacity modifier usage to dedicated opacity tokens

## Description

Replace all Tailwind opacity modifier patterns (e.g., `bg-accent/10`, `bg-background/80`) with dedicated CSS variable references. Tailwind's `/N` opacity syntax does NOT work when the color value is a CSS variable (`var(...)`).

**Division of work with tasks 1 and 2:**
- Task 1 defines the `--cc-*-N` opacity CSS variables in both theme blocks (already included in task 1 spec)
- Task 2 defines the Tailwind color entries for opacity variants (added in this task since task 2 only handles base colors)
- **This task** handles: (a) adding opacity variant entries to `tailwind.config.js`, and (b) replacing all component-side `bg-color/N` patterns with `bg-color-N`

## Files to modify

- `tailwind.config.js` — Add opacity variant color entries
- All component files using Tailwind opacity modifiers on theme colors (36+ instances)

Key component files:
- `src/components/Dialogs/ExportPreview.tsx` — `bg-background/80`
- `src/components/Dialogs/SettingsDialog.tsx` — `bg-panel/50`
- `src/components/SingleSystemView/DisplayMenu.tsx` — `hover:bg-background/80`
- `src/components/SingleSystemView/UndoHistoryDropdown.tsx` — `bg-background/80`
- `src/components/common/Button.tsx` — `bg-accent/90`
- `src/components/common/OfflineIndicator.tsx` — `bg-warning/10`, `border-warning/30`
- `src/components/common/ContextMenu.tsx` — `hover:bg-accent/10`
- `src/components/GlobalView/GlobalView.tsx` — `bg-accent/10`, `bg-accent/20`
- `src/components/GlobalView/GlobalViewMap.tsx` — `bg-panel/90`
- `src/App.tsx` — `bg-accent/20`
- (More files — run grep to find all)

## Implementation

### Step 1: Catalog all opacity modifier usage

Run comprehensive grep to find ALL instances:
```bash
grep -rn '/[0-9]\+' src/ --include='*.tsx' --include='*.ts' | grep -E '(bg|border|text)-(background|panel|accent|warning|error|success|border)/'
```

### Step 2: Add Tailwind color entries for opacity variants

In `tailwind.config.js`, add to the `colors` object (after the base color entries set in task 2):
```js
colors: {
  // ... base colors from task 2 ...
  
  // Opacity variants (resolves Tailwind /N modifier breakage)
  'background-80': 'var(--cc-background-80)',
  'panel-50': 'var(--cc-panel-50)',
  'panel-90': 'var(--cc-panel-90)',
  'accent-10': 'var(--cc-accent-10)',
  'accent-20': 'var(--cc-accent-20)',
  'accent-90': 'var(--cc-accent-90)',
  'warning-10': 'var(--cc-warning-10)',
  'warning-30': 'var(--cc-warning-30)',
  // ... additional as determined by grep scan
}
```

**Note**: The corresponding `--cc-*-N` CSS variables are defined in task 1's theme blocks.

### Step 3: Replace in components

```typescript
// Before
className="bg-accent/10"

// After  
className="bg-accent-10"
```

For hover/state variants:
```typescript
// Before
className="hover:bg-accent/10"

// After
className="hover:bg-accent-10"
```

For border variants:
```typescript
// Before
className="border-warning/30"

// After
className="border-warning-30"
```

## Acceptance

- [ ] Comprehensive grep confirms all opacity modifier instances found
- [ ] Opacity variant Tailwind color entries added to tailwind.config.js
- [ ] All component `bg-color/N` patterns replaced with `bg-color-N`
- [ ] All component `border-color/N` patterns replaced with `border-color-N`
- [ ] All component `text-color/N` patterns replaced (if any exist)
- [ ] `pnpm tsc --noEmit` passes
- [ ] No visual regression in dark theme
- [ ] Correct opacity colors in light theme
