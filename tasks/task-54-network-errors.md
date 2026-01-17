# Task 54: Network Error Handling

## Overview
Handle offline state gracefully for satellite tile loading. Show offline indicator and serve cached tiles when network is unavailable.

## Priority
Medium - Phase G (Error Handling)

## Risk Level
Medium

## Dependencies
- Task 62: Tile caching (related)

## Files to Modify
- `src/components/Map/MapCanvas.tsx` - Offline detection
- `src/components/StatusBar.tsx` - Offline indicator
- `src/hooks/useNetworkStatus.ts` - New hook

## Specifications

### Network Status Detection
```typescript
function useNetworkStatus() {
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return isOnline;
}
```

### Offline Indicator
- Status bar shows network status
- Icon: cloud with slash when offline
- Tooltip: "Offline - some features unavailable"

### Tile Loading Behavior
When offline:
- Serve tiles from cache (if available)
- Show placeholder for missing tiles
- Don't show error for each failed tile

### Cached Tiles
- Previously viewed areas available
- Clear visual distinction for cached vs fresh
- Cache size limit (see Task 62)

### Error Handling
| Scenario | Behavior |
|----------|----------|
| Network down | Show offline indicator, use cache |
| Tile server error | Retry 3x, then use cache/placeholder |
| Cache miss | Show neutral placeholder tile |

### Recovery
- Auto-detect when back online
- Refresh tiles that were placeholders
- Clear offline indicator

### User Notification
- Non-blocking notification on offline
- No repeated notifications
- Single status bar indicator sufficient

## Acceptance Criteria
- [ ] Offline state detected
- [ ] Offline indicator in status bar
- [ ] Cached tiles served when offline
- [ ] Placeholder for uncached areas
- [ ] Auto-recovery when back online
- [ ] TypeScript types pass
- [ ] Tests pass

## Test Requirements

### Playwright Tests (Mocked IPC)
1. Test useNetworkStatus detects online state
2. Test useNetworkStatus detects offline state
3. Test offline indicator appears in status bar
4. Test offline icon is cloud-with-slash
5. Test tooltip shows "Offline - some features unavailable"
6. Test indicator clears when back online
7. Test no repeated offline notifications

### WebdriverIO Tests (Full App)
1. Test offline detection with network disabled
2. Test cached tiles load when offline
3. Test placeholder shown for uncached tiles
4. Test auto-recovery when back online
5. Test tiles refresh after reconnection
6. Test map remains functional offline (with cache)

## Edge Cases
- Intermittent connection
- Partial cache availability
- Very large cached area
- Cache corruption
