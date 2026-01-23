# fn-20-mwj.8 Implement external selection to DataTable sync

## Description
Implement synchronization from external selection (Map, Sections Panel) to DataTable: auto-switch section dropdown, highlight row, scroll row into view.

**Size:** M
**Files:**
- `src/components/SingleSystemView/DataTable.tsx`

## Approach

1. **Watch external selection**:
   - Subscribe to `uiStore.selection` changes
   - When selection changes and is a shot or station, react accordingly

2. **Shot selection sync**:
   - If `selection.type === 'shot'` and `selection.sectionId !== selectedSectionId`:
     - Auto-switch dropdown to `selection.sectionId`
   - Set `scrollToKey` to the shot's ID to trigger scroll

3. **Station selection sync**:
   - If `selection.type === 'station'`:
     - Station N = end of shot N, so highlight shot where `station_index === N`
     - Auto-switch section if needed
     - Scroll to that shot row

4. **Section selection sync**:
   - If `selection.type === 'section'`:
     - Switch dropdown to that section
     - Clear any row highlight (no specific shot selected)

5. **Only sync if open**:
   - Check `dataTableOpen` before syncing
   - If closed, still update `selectedSectionId` for next open

6. **Section dropdown manual change**:
   - When user manually switches dropdown, clear selection and select the new section:
     - `setSelection({ type: 'section', sectionId: newSectionId })`

## Key context

Memory convention: "Concurrency guards at store level (not hook level) when multiple UI paths can trigger the same action"

Selection type at uiStore.ts:56-61:
```tsx
interface Selection {
  type: 'station' | 'shot' | 'section';
  stationRef?: StationRef;
  sectionId?: SectionId;
  shotId?: ShotId;
}
```

Use scrollIntoView({ block: 'nearest' }) for minimal scroll - only scrolls if row not visible.
## Acceptance
- [ ] Selecting shot on map switches DataTable to correct section
- [ ] Selecting shot on map highlights corresponding row
- [ ] Selecting shot on map scrolls row into view (minimal scroll)
- [ ] Selecting station highlights the shot that ends at that station
- [ ] Selecting section in Sections Panel switches DataTable dropdown
- [ ] Section selection clears row highlight
- [ ] Manual dropdown change selects the new section and clears shot selection
- [ ] Sync only happens when DataTable is open (no auto-expand)
- [ ] Type check passes: `pnpm tsc --noEmit`
## Done summary
Blocked:
Auto-blocked after 5 attempts.
Run: 20260122T123130Z-ralph-cavechef@example.com-926025-2900
Task: fn-20-mwj.8

Last output:
{"type":"system","subtype":"init","cwd":"/home/ubuntu/projects/CaveChef","session_id":"db6d79df-55d1-474d-8863-ef567ed8fb5c","tools":["Task","TaskOutput","Bash","Glob","Grep","ExitPlanMode","Read","Edit","Write","NotebookEdit","WebFetch","TodoWrite","WebSearch","KillShell","AskUserQuestion","Skill","EnterPlanMode","ToolSearch"],"mcp_servers":[],"model":"claude-opus-4-5-20251101","permissionMode":"bypassPermissions","slash_commands":["codex","ralph","prd","flow-next:flow-next:impl-review","flow-next:flow-next:sync","flow-next:flow-next:setup","flow-next:flow-next:plan-review","flow-next:flow-next:ralph-init","flow-next:flow-next:uninstall","flow-next:flow-next:plan","flow-next:flow-next:interview","flow-next:flow-next:work","flow-next:flow-next-rp-explorer","flow-next:browser","flow-next:flow-next-export-context","flow-next:flow-next-ralph-init","flow-next:flow-next-plan","flow-next:flow-next-worktree-kit","flow-next:flow-next-work","flow-next:flow-next","flow-next:flow-next-plan-review","flow-next:flow-next-sync","flow-next:flow-next-setup","flow-next:flow-next-interview","flow-next:flow-next-impl-review","compact","context","cost","init","pr-comments","release-notes","review","security-review"],"apiKeySource":"none","claude_code_version":"2.1.17","output_style":"default","agents":["Bash","general-purpose","statusline-setup","Explore","Plan","flow-next:worker","flow-next:epic-scout","flow-next:docs-scout","flow-next:memory-scout","flow-next:repo-scout","flow-next:flow-gap-analyst","flow-next:github-scout","flow-next:docs-gap-scout","flow-next:practice-scout","flow-next:quality-auditor","flow-next:context-scout","flow-next:plan-sync"],"skills":["codex","ralph","prd","flow-next:flow-next-rp-explorer","flow-next:browser","flow-next:flow-next-export-context","flow-next:flow-next-ralph-init","flow-next:flow-next-plan","flow-next:flow-next-worktree-kit","flow-next:flow-next-work","flow-next:flow-next","flow-next:flow-next-plan-review","flow-next:flow-next-sync","flow-next:flow-next-setup","flow-next:flow-next-interview","flow-next:flow-next-impl-review"],"plugins":[{"name":"flow-next","path":"/home/ubuntu/.claude/plugins/cache/gmickel-claude-marketplace/flow-next/0.17.4"}],"uuid":"688ef936-c655-4130-a1ed-68dc3f53bf9d"}
{"type":"assistant","message":{"id":"9d435595-f6ea-48ed-a1a8-1bb140847f8a","container":null,"model":"<synthetic>","role":"assistant","stop_reason":"stop_sequence","stop_sequence":"","type":"message","usage":{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":null,"cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0}},"content":[{"type":"text","text":"API Error: 500 {\"type\":\"error\",\"error\":{\"type\":\"api_error\",\"message\":\"Internal server error\"},\"request_id\":\"req_011CXPBkQWB5M579Nt1ozxdr\"}"}],"context_management":null},"parent_tool_use_id":null,"session_id":"db6d79df-55d1-474d-8863-ef567ed8fb5c","uuid":"3e1b145e-5682-4cc8-bdb9-0a9ba86e5e21","error":"unknown"}
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Stop hook feedback:\nCannot stop: Review receipt not written. You must write the receipt to: /home/ubuntu/projects/CaveChef/scripts/ralph/runs/20260122T123130Z-ralph-cavechef@example.com-926025-2900/receipts/impl-fn-20-mwj.8.json\nRun:\nmkdir -p \"$(dirname '/home/ubuntu/projects/CaveChef/scripts/ralph/runs/20260122T123130Z-ralph-cavechef@example.com-926025-2900/receipts/impl-fn-20-mwj.8.json')\"\nts=\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"\ncat > '/home/ubuntu/projects/CaveChef/scripts/ralph/runs/20260122T123130Z-ralph-cavechef@example.com-926025-2900/receipts/impl-fn-20-mwj.8.json' <<EOF\n{\"type\":\"impl_review\",\"id\":\"fn-20-mwj.8\",\"mode\":\"rp\",\"timestamp\":\"$ts\"}\nEOF"}]},"parent_tool_use_id":null,"session_id":"db6d79df-55d1-474d-8863-ef567ed8fb5c","uuid":"7628a84a-39ee-4d5f-894e-f48e3a2ea366","isSynthetic":true}
{"type":"assistant","message":{"id":"693e5828-dae4-4754-9d31-19eed9ddaf21","container":null,"model":"<synthetic>","role":"assistant","stop_reason":"stop_sequence","stop_sequence":"","type":"message","usage":{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":null,"cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0}},"content":[{"type":"text","text":"API Error: 500 {\"type\":\"error\",\"error\":{\"type\":\"api_error\",\"message\":\"Internal server error\"},\"request_id\":\"req_011CXPBkS4ghh6gfChQuCkaS\"}"}],"context_management":null},"parent_tool_use_id":null,"session_id":"db6d79df-55d1-474d-8863-ef567ed8fb5c","uuid":"e0f4248d-f15f-4f08-8ea7-259ddb69d98a","error":"unknown"}
{"type":"result","subtype":"success","is_error":true,"duration_ms":715,"duration_api_ms":0,"num_turns":2,"result":"API Error: 500 {\"type\":\"error\",\"error\":{\"type\":\"api_error\",\"message\":\"Internal server error\"},\"request_id\":\"req_011CXPBkS4ghh6gfChQuCkaS\"}","session_id":"db6d79df-55d1-474d-8863-ef567ed8fb5c","total_cost_usd":0,"usage":{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0}},"modelUsage":{},"permission_denials":[],"uuid":"5b456ce7-8cb4-4e27-9e39-bf2de9e43898"}
ralph: missing impl review receipt; forcing retry
ralph: task not done; forcing retry
## Evidence
- Commits:
- Tests:
- PRs:
