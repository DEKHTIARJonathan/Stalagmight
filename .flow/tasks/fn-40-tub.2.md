# fn-40-tub.2 Frontend: MergeDialog simplification, new ClosureDialog, merge tool flow update

## Description

Update the frontend merge tool flow: call `check_merge_connectivity` before opening any dialog, simplify MergeDialog to a station-names-only confirmation, and create a new ClosureDialog component with full preview data and strategy selector.

**Size:** M
**Files:**
- `src/hooks/useMapTools.ts` — update merge tool click handler to call connectivity check
- `src/components/Dialogs/MergeDialog.tsx` — simplify to confirmation-only
- `src/components/Dialogs/ClosureDialog.tsx` — **new file**
- `src/App.tsx` — register ClosureDialog
- `src/store/projectStore.ts` — add `createLoopClosure()` action + `checkMergeConnectivity()` query
- `src/types/project.ts` — add `ConnectivityResult`, `ClosurePreview` types

## Approach

### 1. Add frontend types and store methods
- Add `ConnectivityResult` and `ClosurePreview` TypeScript types to `src/types/project.ts` matching the Rust structs from task 1
- Add `checkMergeConnectivity(stationA: StationRef, stationB: StationRef): Promise<ConnectivityResult>` to projectStore — calls `invoke('check_merge_connectivity', ...)`
- Add `createLoopClosure(stationA: StationRef, stationB: StationRef, strategy: ClosureStrategy): Promise<CommandResult>` to projectStore — calls `invoke('create_loop_closure', ...)` 

### 2. Update merge tool flow in `useMapTools.ts`
- At `useMapTools.ts:116-136`: When station B is selected, instead of immediately opening the merge dialog:
  1. Call `checkMergeConnectivity(stationA, stationB)` 
  2. If error (duplicate merge/closure), show error and clear selection
  3. If `connected === false` → open `merge` dialog with `{ stationA, stationB }`
  4. If `connected === true` → open `closure` dialog with `{ stationA, stationB, preview: result.preview }`
- Show a brief loading state while connectivity check runs (set a local loading flag)

### 3. Simplify MergeDialog
- Remove distance/depth calculation (`useMemo` at lines 45-57)
- Remove loop detection logic (`createsLoop` at lines 60-74, `closureErrorPercent` at lines 77-84)
- Remove distance info panel (lines 146-159)
- Remove loop closure warning (lines 162-176)
- Keep: station names with section context, error display, loading state, confirm/cancel buttons
- Update button text: "Merge" (not "Merge Stations")
- Remove `closure_strategy` from `mergeStations()` call (backend no longer accepts it)

### 4. Create ClosureDialog component
- New file `src/components/Dialogs/ClosureDialog.tsx`
- Follow `DialogWrapper` pattern from `MergeDialog.tsx` and other dialogs in `src/components/Dialogs/`
- Title: "Create Loop Closure"
- Content:
  - Station A and B names (with section context, same format as simplified MergeDialog)
  - Preview data panel: Error %, Path length, Misclosure distance, Horizontal misclosure, Vertical misclosure
  - Use `toFixed(2)` for distances, `toFixed(1)` for percentages (follow existing MergeDialog patterns)
  - Color-code the error percentage: green (<1%), yellow (1-3%), orange (3-5%), red (>5%) — matching map layer colors at `features.ts:339-355`
  - `ClosureStrategy` selector (radio buttons or select dropdown) — options from `ClosureStrategy` enum: ProportionalByLength (default), EqualDistribution, KeepRaw, ManualAdjustment
- Buttons: "Cancel" (left), "Create Closure" (right, primary)
- Loading/error states following MergeDialog pattern
- Call `createLoopClosure()` from projectStore on confirm

### 5. Register in App.tsx
- Add `{activeDialog === 'closure' && <ClosureDialog />}` following pattern at `App.tsx:553`

## Key context

- `useUIStore` manages dialog state via `openDialog(name, data)` / `closeDialog()` / `dialogData` — follow existing pattern
- `clearMergeStations()` must be called on both dialog close and successful operation
- Memory pitfall: async action queues (ref-based) must be cleared on all close/teardown paths
- Memory pitfall: Select.tsx has many close paths — if using Select for strategy, audit all close paths
## Acceptance
- [ ] Merge tool calls `check_merge_connectivity` before opening any dialog
- [ ] If connectivity check returns error (duplicate), error is shown and selection cleared
- [ ] If stations not connected → MergeDialog opens
- [ ] If stations connected → ClosureDialog opens with preview data
- [ ] MergeDialog shows only station names, section context, and confirm/cancel — no distances, no loop warning, no strategy selector
- [ ] MergeDialog calls `mergeStations()` without `closure_strategy` parameter
- [ ] ClosureDialog shows error %, path length, misclosure distance, horizontal/vertical misclosure
- [ ] ClosureDialog error percentage is color-coded (green/yellow/orange/red)
- [ ] ClosureDialog includes strategy selector with all 4 options, ProportionalByLength as default
- [ ] ClosureDialog calls `createLoopClosure()` on confirm
- [ ] Both dialogs clear merge station selection on close/success
- [ ] Loading state shown during connectivity check
- [ ] `pnpm tsc --noEmit` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
