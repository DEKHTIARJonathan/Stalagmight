# fn-7-2vm.1 Add statistics footer to DMP Import Dialog

## Description
## Overview

Add statistics footer showing aggregated stats for selected sections.

## Implementation

### 1. Add stats calculation with debounce

```tsx
const [stats, setStats] = useState({ length: 0, shots: 0, minDepth: 0, maxDepth: 0 });

// Debounced calculation
useEffect(() => {
  const timer = setTimeout(() => {
    const selected = sections.filter((_, i) => selectedIndices.has(i));
    const allShots = selected.flatMap(s => s.shots);
    
    setStats({
      length: allShots.reduce((sum, shot) => sum + shot.length, 0),
      shots: allShots.length,
      minDepth: Math.min(...allShots.map(s => s.depth_in)),
      maxDepth: Math.max(...allShots.map(s => s.depth_out)),
    });
  }, 500);
  
  return () => clearTimeout(timer);
}, [selectedIndices, sections]);
```

### 2. Add footer UI

```tsx
<div 
  className="border-t border-border p-3 text-sm text-text-secondary select-text"
  data-testid="stats-footer"
>
  <span data-testid="stats-total-length">Total: {stats.length.toFixed(1)}m</span>
  <span className="mx-2">|</span>
  <span data-testid="stats-shot-count">Shots: {stats.shots}</span>
  <span className="mx-2">|</span>
  <span data-testid="stats-depth-range">
    Depth: {stats.minDepth.toFixed(1)}m to {stats.maxDepth.toFixed(1)}m
  </span>
</div>
```

### 3. Handle edge cases

- No selection: show "Total: 0.0m | Shots: 0 | Depth: --"
- Missing depth: skip from range calculation

## Files to Modify
- `src/components/Dialogs/DmpImportDialog.tsx`
- `e2e-playwright/import-dialog.spec.ts`

## References
- Task spec: `./tasks/task-04-statistics-footer.md`
## Acceptance
- [ ] Stats footer visible below section table
- [ ] Total length calculated correctly
- [ ] Shot count accurate
- [ ] Depth range min/max displayed
- [ ] Updates when selection changes
- [ ] 500ms debounce implemented
- [ ] Placeholder values for no selection
- [ ] Text is selectable (select-text class)
- [ ] data-testid attributes present
- [ ] Playwright tests added
- [ ] TypeScript types pass
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
