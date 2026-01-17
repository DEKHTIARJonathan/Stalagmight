# Task 53: Error Boundary Wrapper

## Overview
Implement React error boundaries at the per-panel level to catch rendering errors and provide recovery UI without crashing the entire application.

## Priority
Medium - Phase G (Error Handling)

## Risk Level
Medium

## Dependencies
- None

## Files to Modify
- `src/components/common/ErrorBoundary.tsx` - New component
- `src/components/SingleSystemView/index.tsx` - Wrap panels
- `src/components/GlobalView/index.tsx` - Wrap sections

## Specifications

### Error Boundary Component
```tsx
interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
  onReset?: () => void;
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, State> {
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    this.props.onError?.(error, errorInfo);
    console.error('Error boundary caught:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback || <DefaultErrorFallback />;
    }
    return this.props.children;
  }
}
```

### Error Fallback UI
```tsx
function DefaultErrorFallback({ error, onReset, onReload }) {
  return (
    <div className="error-fallback">
      <h3>Something went wrong</h3>
      <details>
        <summary>Error details</summary>
        <pre>{error.message}</pre>
      </details>
      <div className="actions">
        <button onClick={onReset}>Try Again</button>
        <button onClick={onReload}>Reload Panel</button>
      </div>
    </div>
  );
}
```

### Recovery Options
Two recovery approaches:
1. **Reset**: Clear error state, re-render same component
2. **Reload**: Reload panel data from backend

### Per-Panel Boundaries
Wrap each major panel:
- Map panel
- Sections panel
- Detail panel
- Data table panel
- Dialog contents

### Error Logging
- Log to console in development
- Store in error log (for bug reporter)
- Include component stack trace

### Expandable Details
- Error summary shown by default
- "Show details" expands full stack trace
- Copyable for bug reports

### State Recovery
- Try to preserve other panels
- Only affected panel shows error
- Global state remains intact

## Acceptance Criteria
- [ ] ErrorBoundary component working
- [ ] Per-panel error isolation
- [ ] Recovery UI with reset/reload options
- [ ] Error details expandable
- [ ] Errors logged for debugging
- [ ] TypeScript types pass
- [ ] Tests pass

## Test Requirements

### Playwright Tests (Mocked IPC)
1. Test ErrorBoundary catches render error
2. Test fallback UI displays error message
3. Test "Try Again" button clears error state
4. Test "Reload Panel" button reloads data
5. Test error details expandable
6. Test error details copyable
7. Test other panels remain functional
8. Test error logged to console

### WebdriverIO Tests (Full App)
1. Test error boundary with real render error
2. Test recovery restores panel functionality
3. Test error isolation between panels
4. Test error boundary in dialog content
5. Test error logging for bug reporter

## Edge Cases
- Error in error boundary itself
- Error during recovery
- Multiple panels error simultaneously
- Error in dialog
