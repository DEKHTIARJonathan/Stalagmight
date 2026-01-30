# fn-51-g8j.11 Migrate Tailwind opacity modifier usage to dedicated opacity tokens

## Description

Replace all Tailwind opacity modifier patterns (e.g., `bg-accent/10`, `bg-background/80`) with dedicated CSS variable references. Tailwind's `/N` opacity syntax does NOT work when the color value is a CSS variable (`var(...)`).

## Files to modify

All files using Tailwind opacity modifiers on theme colors (36+ instances). Key files:

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

Run: `grep -rn 'bg-\(background\|panel\|accent\|warning\|error\|success\|border\)/[0-9]' src/`
Also: `grep -rn 'border-\(background\|panel\|accent\|warning\|error\|success\|border\)/[0-9]' src/`
Also: `grep -rn 'text-\(text-primary\|text-secondary\|accent\|warning\|error\|success\)/[0-9]' src/`

### Step 2: Define opacity variant CSS variables

In task 1's CSS variable blocks, add all needed opacity variants. The exact set is determined by the grep results. Expected variants:

```css
:root, [data-theme="dark"] {
  /* Opacity variants */
  --cc-background-80: rgba(26, 26, 46, 0.8);
  --cc-panel-50: rgba(22, 33, 62, 0.5);
  --cc-panel-90: rgba(22, 33, 62, 0.9);
  --cc-accent-10: rgba(78, 205, 196, 0.1);
  --cc-accent-20: rgba(78, 205, 196, 0.2);
  --cc-accent-90: rgba(78, 205, 196, 0.9);
  --cc-warning-10: rgba(255, 203, 119, 0.1);
  --cc-warning-30: rgba(255, 203, 119, 0.3);
  /* ... additional as needed from grep results */
}

[data-theme="light"] {
  --cc-background-80: rgba(245, 240, 232, 0.8);
  --cc-panel-50: rgba(255, 255, 255, 0.5);
  --cc-panel-90: rgba(255, 255, 255, 0.9);
  --cc-accent-10: rgba(58, 138, 130, 0.1);
  --cc-accent-20: rgba(58, 138, 130, 0.2);
  --cc-accent-90: rgba(58, 138, 130, 0.9);
  --cc-warning-10: rgba(196, 144, 26, 0.1);
  --cc-warning-30: rgba(196, 144, 26, 0.3);
}
```

### Step 3: Add Tailwind color entries for opacity variants

In `tailwind.config.js`:
```js
colors: {
  // ... existing
  'background-80': 'var(--cc-background-80)',
  'panel-50': 'var(--cc-panel-50)',
  'panel-90': 'var(--cc-panel-90)',
  'accent-10': 'var(--cc-accent-10)',
  'accent-20': 'var(--cc-accent-20)',
  'accent-90': 'var(--cc-accent-90)',
  'warning-10': 'var(--cc-warning-10)',
  'warning-30': 'var(--cc-warning-30)',
}
```

### Step 4: Replace in components

```typescript
// Before
className="bg-accent/10"

// After  
className="bg-accent-10"
```

For hover variants:
```typescript
// Before
className="hover:bg-accent/10"

// After
className="hover:bg-accent-10"
```

## Acceptance

- [ ] All Tailwind opacity modifier patterns (`/N`) on theme colors are replaced
- [ ] Dedicated `--cc-*-N` opacity CSS variables defined in both dark and light theme blocks
- [ ] Corresponding Tailwind color entries added in tailwind.config.js
- [ ] Components use new color class names (e.g., `bg-accent-10` instead of `bg-accent/10`)
- [ ] `pnpm tsc --noEmit` passes
- [ ] No visual regression in dark theme
- [ ] Correct opacity colors in light theme
