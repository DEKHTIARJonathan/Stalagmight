# Task 31: Loop Detection Algorithm

## Overview
Implement loop detection when merging stations. Detect when a merge would create a closed loop by checking if a path already exists between the two stations being merged.

## Priority
High - Phase A (Loop Closure)

## Risk Level
Medium-High

## Dependencies
- Assumes tasks 1-30 from ingested/ are complete

## Files to Modify
- `src-tauri/src/models/project.rs` - Add comprehensive loop detection
- `src-tauri/src/persistence/sqlite.rs` - Add loop_closures table

## Specifications

### Detection Algorithm
- Use BFS/DFS to find if path exists between two stations before merge
- Optimize for 50-200 sections (revisit 200+ in v3)
- Include virtual shots in loop path calculations
- Detect multi-section loops (A→B→C→A, not just A→B→A)

### When to Detect
- Merge dialog only (not proactive scanning)
- No automatic merge suggestions

### Loop Data Structure
```rust
pub struct LoopClosure {
    pub id: u64,
    pub merge_id: u64,
    pub path_stations: Vec<StationRef>,
    pub path_length: f64,
    pub misclosure_distance: f64,
    pub error_percentage: f64,
    pub strategy: ClosureStrategy,
    pub created_at: DateTime<Utc>,
}
```

### Database Schema
```sql
CREATE TABLE loop_closures (
    id INTEGER PRIMARY KEY,
    merge_id INTEGER NOT NULL REFERENCES station_merges(id),
    path_stations_json TEXT NOT NULL,
    path_length REAL NOT NULL,
    misclosure_distance REAL NOT NULL,
    error_percentage REAL NOT NULL,
    strategy TEXT NOT NULL,
    created_at TEXT NOT NULL
);
```

### UI Requirements
- Show loop detection result in merge dialog
- Display path visualization when loop detected
- Add `data-testid="loop-detected-indicator"`

## Acceptance Criteria
- [ ] Loop detected when merge creates closed path
- [ ] Multi-section loops (3+ sections) detected
- [ ] Virtual shots included in path calculation
- [ ] Loop data stored in new SQLite table
- [ ] Path visualization in merge dialog
- [ ] TypeScript types pass (`pnpm tsc --noEmit`)
- [ ] Playwright tests pass
- [ ] Rust tests pass (`cargo test`)

## Test Requirements

### Rust Tests
1. Test loop detection with simple 2-section loop (A→B→A)
2. Test loop detection with 3+ section diamond graph (A→B→C→A)
3. Test virtual shots included in loop path calculation
4. Test no false positives when merging unconnected sections
5. Test performance with 100 sections (< 100ms detection)
6. Test loop path correctly identifies all stations in loop
7. Test multiple loops from single merge detected

### Playwright Tests (Mocked IPC)
1. Test loop indicator appears in merge dialog when loop detected
2. Test path visualization displays correct stations
3. Test merge dialog shows loop closure data
4. Test no loop indicator for non-loop merges

### WebdriverIO Tests (Full App)
1. Test end-to-end loop detection with real DMP import
2. Test loop data persists to SQLite after merge
3. Test loop indicator survives app restart
4. Test merge dialog with actual backend calculation

## Edge Cases
- Merging already-merged stations
- Loops involving only virtual shots
- Very long loop paths (50+ sections)
- Multiple simultaneous loops from single merge
