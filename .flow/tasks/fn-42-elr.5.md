# fn-42-elr.5 Update ShortcutsSettings UI: flex-grow column, condensed rows, alternating colors, reserved section position

## Description
Apply all UI layout improvements to ShortcutsSettings: flex-grow name column, condensed rows with alternating colors, and move reserved section above search bar.

**Size:** M
**Files:**
- `src/components/Dialogs/settings/ShortcutsSettings.tsx`

## Approach

### 1. Name column flex-grow (line 389)
- Replace `w-32 text-sm truncate` with `flex-1 min-w-32 text-sm truncate`
- Add tooltip showing full action name on hover (use existing Tooltip component)

### 2. Row condensing (~40% reduction)
- Change category `space-y-2` (line 372) to `space-y-0.5`
- Change row `py-1` (line 384) to `py-0.5`

### 3. Alternating row colors (reset per category)
- Track row index within each category mapping
- Use Tailwind classes: odd rows get subtle background, even rows transparent
- Classes: `odd:bg-muted/30 even:bg-transparent dark:odd:bg-muted/20`
- Each category starts fresh (index resets to 0)

### 4. Move reserved section above search bar
- Move JSX block at lines 319-335 (reserved shortcuts section)
- Place it BEFORE the search bar JSX at lines 282-305
- Keep reserved section style unchanged
- Reserved section always visible (not affected by search filter)
<!-- Updated by plan-sync: fn-42-elr.3 added File category to SHORTCUT_CATEGORIES, shifting line numbers in ShortcutsSettings.tsx -->

## Key context
- Use Tailwind `odd:` and `even:` variants for alternating colors
- Theme tokens: `bg-muted` works in both light and dark themes
- Current row container: `flex items-center gap-3 py-1`

## Acceptance
- [ ] Name column uses flex-grow to fill available space
- [ ] Name column has min-width to prevent squishing (min-w-32)
- [ ] Long names truncate with ellipsis
- [ ] Tooltip shows full action name on hover
- [ ] Row vertical spacing reduced ~40% (py-0.5, space-y-0.5)
- [ ] Alternating row colors: odd rows have subtle background (odd:bg-muted/30)
- [ ] Even rows are transparent (even:bg-transparent)
- [ ] Alternating colors work in both light and dark themes
- [ ] Color alternation resets at each category boundary
- [ ] Reserved shortcuts section appears above search bar
- [ ] Reserved section always visible during search
- [ ] Reserved section keeps current 2-column grid style

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
