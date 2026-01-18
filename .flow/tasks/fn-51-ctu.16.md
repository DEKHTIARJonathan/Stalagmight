# fn-51-ctu.16 Implement Session Surveyor Memory

## Description
Remember last used surveyor name during session (not persisted to config).

## Files to Modify
- `src/store/uiStore.ts`
- `src/components/Dialogs/DmpSelectionDialog.tsx`

## Implementation
```tsx
// In uiStore.ts
interface UIState {
  lastUsedSurveyor: string;
}

setLastUsedSurveyor: (surveyor: string) => set({ lastUsedSurveyor: surveyor }),
```

Pre-fill default surveyor in Step 1 with `lastUsedSurveyor`, update store on change.

## References
- `tasks/urgent/task-16-session-surveyor-memory.md`
## Acceptance
- [ ] lastUsedSurveyor added to uiStore
- [ ] Default surveyor field pre-filled with last used value
- [ ] Changing surveyor updates the store
- [ ] Next import shows previously used surveyor
- [ ] Value cleared on app restart (session only)
- [ ] TypeScript compiles without errors
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
