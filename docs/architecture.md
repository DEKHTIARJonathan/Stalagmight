# CaveChef Architecture

> For full data model, UI design, and workflows, see [SPEC.md](SPEC.md).

## State Flow

```
User Action → Zustand Store → Tauri IPC → Rust Command Executor
     ↑                                              │
     └──────────── State Update ←──────── Command Result
```

## Command Pattern

All persistent operations go through the Rust `Command` enum in `src-tauri/src/core/command.rs`. The `AppState` in `state.rs` executes commands and manages undo/redo.

## Data Model

- **Project**: Contains sections, station merges, zero datums, section offsets
- **Section**: Group of shots with metadata (name, surveyor, date, color)
- **Shot**: Single measurement (azimuth, length, depth, LRUD)
- **Station**: Computed from shots, can be merged or set as zero datum

## Key Files

| File | Purpose |
|------|---------|
| `src-tauri/src/core/command.rs` | Command enum and result types |
| `src-tauri/src/core/state.rs` | AppState with command execution, auto-save |
| `src-tauri/src/persistence/sqlite.rs` | Database schema and operations |
| `src-tauri/src/parsers/dmp.rs` | mNemo DMP file parser |
| `src-tauri/src/models/project.rs` | Project model with merge/offset logic |
| `src-tauri/src/cache/tiles.rs` | Satellite tile cache (SQLite-based) |
| `src-tauri/src/commands/cache.rs` | Cache IPC commands (stats, clear, fetch) |
| `src/store/projectStore.ts` | Frontend state, Tauri IPC calls |
| `src/store/uiStore.ts` | UI state (selection, tools, panels) |
| `src/components/Map/MapCanvas.tsx` | MapLibre map initialization |
| `src/components/Map/SurveyLayer.tsx` | Survey rendering on map |
| `src/utils/coordinates.ts` | Coordinate transforms (meters ↔ GPS) |
| `src/utils/tileProtocol.ts` | MapLibre tile protocol for caching |
| `src/hooks/useProject.ts` | Project file operations hook |
| `src/hooks/useMapTools.ts` | Map tool handlers |
| `src/hooks/useKeyboardShortcuts.ts` | Global keyboard shortcut handler |

## Rust Backend Patterns

### Mutex Lock Ordering

**Critical**: Never hold a Mutex lock while calling methods that acquire other locks. This caused a deadlock bug where auto-save held the `config` lock while calling `save_project`, which tried to lock `config` again.

**Pattern to avoid**:
```rust
// BAD - holds lock while calling other method
if let Ok(config) = self.config.lock() {
    if config.auto_save {
        self.save_project(None); // save_project also locks config!
    }
}

// GOOD - release lock before calling
let should_save = self.config.lock().map(|c| c.auto_save).unwrap_or(false);
if should_save {
    self.save_project(None);
}
```

### Safe File Save

Always use temp file + atomic rename pattern for saves:
1. Write to `file.cvproj.tmp`
2. On success, rename to `file.cvproj`
3. On failure, delete temp file

This prevents data loss if save fails mid-write.

### Section Offset Tracking

When stations are merged, section positions are recalculated:
1. Build graph of section connections through merges
2. Anchor section (first or with zero datum) stays fixed
3. Calculate offsets for connected sections
4. Store in `Project.section_offsets: HashMap<SectionId, (f64, f64)>`

### Database Operations

- Use `Database::open_existing()` for reading (doesn't create files)
- Use `Database::open()` for writing (creates if needed)
- Shot IDs are generated on load: `section_id * 100000 + sequence`
