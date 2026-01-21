# fn-9-d6v.1 Add hoveredSectionId state to uiStore

## Description
Add `hoveredSectionId` state to uiStore for bidirectional section hover sync.

## Files to Modify

### `src/store/uiStore.ts`

**Add state (near L182-186 where other hover states are):**
```typescript
hoveredSectionId: SectionId | null;
setHoveredSectionId: (sectionId: SectionId | null) => void;
```

**Add to initial state:**
```typescript
hoveredSectionId: null,
```

**Add setter action:**
```typescript
setHoveredSectionId: (sectionId) => set({ hoveredSectionId: sectionId }),
```

## Why This Approach
- Matches existing patterns: `hoveredStation: StationRef | null`, `hoveredShot: {sectionId, shotId} | null`
- Null explicitly means "nothing hovered" (vs undefined which could mean "not initialized")
- Simple setter - doesn't clear other hover states (they're independent)
- Enables bidirectional sync: panel sets it, map derives it from hovered features
## Acceptance
- [ ] `hoveredSectionId: SectionId | null` added to UIStore interface
- [ ] `setHoveredSectionId` action added to UIStore interface
- [ ] Initial state has `hoveredSectionId: null`
- [ ] Setter implementation follows existing pattern
- [ ] Type exports updated if needed
- [ ] `pnpm tsc --noEmit` passes
## Done summary
Added hoveredSectionId state and setHoveredSectionId action to uiStore for bidirectional section hover sync, following existing hover state patterns. Updated setActiveTool to clear hoveredSectionId when switching to non-interactive tools, using explicit null checks to handle section ID 0.
## Evidence
- Commits: eddbc624f3e60ff7db0b600a5a2cf7f2f8105e60, aff2209427a35cd9fc8983e6b7b3107339dfb39e
- Tests: pnpm tsc --noEmit
- PRs: