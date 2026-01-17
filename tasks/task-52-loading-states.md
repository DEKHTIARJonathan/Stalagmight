# Task 52: Loading States

## Overview
Add loading spinners and progress indicators for all async operations. Include spinner, status text, and percentage for quantifiable operations.

## Priority
Medium - Phase F (Performance)

## Risk Level
Medium

## Dependencies
- None

## Files to Modify
- `src/components/common/LoadingOverlay.tsx` - New component
- `src/components/common/Spinner.tsx` - New component
- `src/hooks/useLoading.ts` - New hook
- Various components - Add loading states

## Specifications

### Loading Overlay Component
```tsx
interface LoadingOverlayProps {
  isLoading: boolean;
  message?: string;
  progress?: number; // 0-100
  showCancel?: boolean;
  onCancel?: () => void;
}

<LoadingOverlay
  isLoading={isImporting}
  message="Importing DMP file..."
  progress={45}
/>
```

### Spinner Component
```tsx
interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

<Spinner size="md" />
```

### Loading Hook
```typescript
const { isLoading, message, progress, startLoading, stopLoading } = useLoading();

startLoading('Importing...', 0);
updateProgress(50);
stopLoading();
```

### Operations Requiring Loading State
| Operation | Type | Shows Progress |
|-----------|------|----------------|
| Project open | Overlay | No |
| Project save | Status bar | No |
| DMP import | Overlay | Yes |
| Export | Overlay | Yes |
| Large operation | Overlay | If quantifiable |

### Progress Display
- Spinner + text for indeterminate
- Progress bar for quantifiable
- Percentage text: "45%"

### Cancellation (Future)
- Some operations cancellable (not in v1)
- Cancel button placeholder
- Returns to previous state

### Skeleton Loading
- For panels/sections still loading
- Animated placeholder shapes
- Matches expected content layout

### Status Bar Integration
- Small spinner in status bar for quick ops
- Full overlay for blocking ops

## Acceptance Criteria
- [ ] LoadingOverlay component working
- [ ] Spinner component working
- [ ] Progress display for quantifiable ops
- [ ] Loading state for all IPC calls
- [ ] Skeleton loading for panels
- [ ] TypeScript types pass
- [ ] Tests pass

## Test Requirements

### Playwright Tests (Mocked IPC)
1. Test LoadingOverlay component renders
2. Test Spinner component renders in 3 sizes
3. Test progress bar shows percentage
4. Test message text displays correctly
5. Test loading overlay blocks interaction
6. Test loading clears on operation complete
7. Test loading clears on operation error
8. Test skeleton loading renders for panels

### WebdriverIO Tests (Full App)
1. Test loading appears during project open
2. Test loading appears during DMP import
3. Test progress updates during export
4. Test no flicker for fast operations
5. Test loading state with real slow operation

## Edge Cases
- Very fast operations (flicker prevention)
- Very slow operations (timeout?)
- Error during loading
- Multiple concurrent operations
