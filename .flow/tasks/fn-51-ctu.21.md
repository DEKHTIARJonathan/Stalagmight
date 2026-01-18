# fn-51-ctu.21 Implement App Close Confirmation

## Description
Show confirmation when user closes app window while import dialog is open.

## Files to Modify
- `src/App.tsx`
- `src-tauri/src/main.rs` (or lib.rs)

## Files to Create
- `src/hooks/useBeforeUnload.ts`

## Implementation
```tsx
function useBeforeUnload(shouldBlock: boolean, message: string) {
  useEffect(() => {
    if (!shouldBlock) return;
    
    // Handle Tauri window close request
    const unlisten = listen('tauri://close-requested', async () => {
      const confirmed = await confirm(message, { ... });
      if (confirmed) {
        await getCurrentWindow().destroy();
      }
    });
    
    return () => { unlisten.then(fn => fn()); };
  }, [shouldBlock, message]);
}
```

Configure Tauri to emit close-requested event instead of closing directly.

## References
- `tasks/urgent/task-21-app-close-confirmation.md`
## Acceptance
- [ ] Closing app during import shows confirmation
- [ ] Confirmation message mentions discarding import data
- [ ] Cancel keeps the app open
- [ ] Confirm closes the app
- [ ] Placed sections are deleted on confirm
- [ ] Works in Tauri production build
- [ ] Works in dev mode (browser)
- [ ] TypeScript compiles without errors
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
