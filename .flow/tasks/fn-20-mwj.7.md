# fn-20-mwj.7 Implement DataTable hover/click/double-click to Map sync

## Description
Implement synchronization from DataTable interactions to Map: row hover highlights shot on map, row click selects shot, double-click pans map to shot midpoint.

**Size:** M
**Files:**
- `src/components/SingleSystemView/DataTable.tsx`
- `src/store/uiStore.ts` (add panToShot action)
- `src/components/Map/MapCanvas.tsx` (handle panToShot)

## Approach

1. **Row hover → Map highlight**:
   - Use new `onRowHover` prop from EditableTable
   - Call `setHoveredShot({ sectionId, shotId })` on hover
   - Call `setHoveredShot(null)` on mouse leave
   - Map already handles `hoveredShot` state for highlighting

2. **Row click → Selection**:
   - Activate the dormant `handleRowClick` (lines 61-69)
   - Wire to new `onRowClick` prop
   - Calls `setSelection({ type: 'shot', sectionId, shotId })`

3. **Cell edit → Selection**:
   - When `handleCellEdit` is called, also set selection for that shot
   - Ensures Detail Panel updates when editing

4. **Double-click → Map pan to shot midpoint**:
   - Add new uiStore action: `triggerPanToShot(sectionId: number, shotId: number)`
   - Add state: `requestPanToShot: { sectionId: number; shotId: number } | null`
   - In MapCanvas, watch for requestPanToShot:
     - Find the shot's from-station and to-station from stations array
     - Calculate shot midpoint: `midpoint = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }`
     - Convert midpoint to GPS coordinates using existing `projectToGps` utility
     - Call `map.easeTo({ center: [lng, lat] })` to pan to midpoint
   - Clear `requestPanToShot` after handling to avoid repeat pans

## Key context

Memory pitfall: "Hover state across feature types: When clearing hover state for one feature type, only fire onFeatureHover(false) if no other feature type is currently hovered"

Shot geometry: A shot connects two stations. The from-station is at `station_index = shotIndex`, the to-station is at `station_index = shotIndex + 1`.

References:
- uiStore hover state at lines 175-180
- MapCanvas easeTo pattern at lines 1224-1230
- Coordinate conversion utilities at `src/utils/coordinates.ts`

## Acceptance
- [ ] Hovering row in DataTable highlights corresponding shot on map
- [ ] Mouse leave clears hover highlight on map
- [ ] Clicking row selects the shot (Detail Panel updates)
- [ ] Entering cell edit mode selects the shot
- [ ] Double-clicking row pans map to center on shot midpoint (not station)
- [ ] Shot midpoint calculated from from/to station coordinates
- [ ] Map pan uses smooth animation (easeTo)
- [ ] requestPanToShot state cleared after handling
- [ ] No hover flicker when moving between rows
- [ ] Type check passes: `pnpm tsc --noEmit`

## Done summary
Blocked:
Auto-blocked after 5 attempts.
Run: 20260122T123130Z-ralph-cavechef@example.com-926025-2900
Task: fn-20-mwj.7

Last output:
{"type":"system","subtype":"init","cwd":"/home/ubuntu/projects/CaveChef","session_id":"aad76e69-5816-4f25-ba04-1f05a8e9139e","tools":["Task","TaskOutput","Bash","Glob","Grep","ExitPlanMode","Read","Edit","Write","NotebookEdit","WebFetch","TodoWrite","WebSearch","KillShell","AskUserQuestion","Skill","EnterPlanMode","ToolSearch"],"mcp_servers":[],"model":"claude-opus-4-5-20251101","permissionMode":"bypassPermissions","slash_commands":["codex","ralph","prd","flow-next:flow-next:impl-review","flow-next:flow-next:sync","flow-next:flow-next:setup","flow-next:flow-next:plan-review","flow-next:flow-next:ralph-init","flow-next:flow-next:uninstall","flow-next:flow-next:plan","flow-next:flow-next:interview","flow-next:flow-next:work","flow-next:flow-next-rp-explorer","flow-next:browser","flow-next:flow-next-export-context","flow-next:flow-next-ralph-init","flow-next:flow-next-plan","flow-next:flow-next-worktree-kit","flow-next:flow-next-work","flow-next:flow-next","flow-next:flow-next-plan-review","flow-next:flow-next-sync","flow-next:flow-next-setup","flow-next:flow-next-interview","flow-next:flow-next-impl-review","compact","context","cost","init","pr-comments","release-notes","review","security-review"],"apiKeySource":"none","claude_code_version":"2.1.17","output_style":"default","agents":["Bash","general-purpose","statusline-setup","Explore","Plan","flow-next:worker","flow-next:epic-scout","flow-next:docs-scout","flow-next:memory-scout","flow-next:repo-scout","flow-next:flow-gap-analyst","flow-next:github-scout","flow-next:docs-gap-scout","flow-next:practice-scout","flow-next:quality-auditor","flow-next:context-scout","flow-next:plan-sync"],"skills":["codex","ralph","prd","flow-next:flow-next-rp-explorer","flow-next:browser","flow-next:flow-next-export-context","flow-next:flow-next-ralph-init","flow-next:flow-next-plan","flow-next:flow-next-worktree-kit","flow-next:flow-next-work","flow-next:flow-next","flow-next:flow-next-plan-review","flow-next:flow-next-sync","flow-next:flow-next-setup","flow-next:flow-next-interview","flow-next:flow-next-impl-review"],"plugins":[{"name":"flow-next","path":"/home/ubuntu/.claude/plugins/cache/gmickel-claude-marketplace/flow-next/0.17.4"}],"uuid":"4e5af177-f7f0-4b1d-8f08-be3d0285d59d"}
{"type":"assistant","message":{"id":"f5fe04cd-6f87-44ec-929e-0bbf2a2ef64a","container":null,"model":"<synthetic>","role":"assistant","stop_reason":"stop_sequence","stop_sequence":"","type":"message","usage":{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":null,"cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0}},"content":[{"type":"text","text":"API Error: 500 {\"type\":\"error\",\"error\":{\"type\":\"api_error\",\"message\":\"Internal server error\"},\"request_id\":\"req_011CXPBiuZMc3R1oaNU91m9H\"}"}],"context_management":null},"parent_tool_use_id":null,"session_id":"aad76e69-5816-4f25-ba04-1f05a8e9139e","uuid":"6d32c669-de1b-46ab-9f64-1060f225af5e","error":"unknown"}
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Stop hook feedback:\nCannot stop: Review receipt not written. You must write the receipt to: /home/ubuntu/projects/CaveChef/scripts/ralph/runs/20260122T123130Z-ralph-cavechef@example.com-926025-2900/receipts/impl-fn-20-mwj.7.json\nRun:\nmkdir -p \"$(dirname '/home/ubuntu/projects/CaveChef/scripts/ralph/runs/20260122T123130Z-ralph-cavechef@example.com-926025-2900/receipts/impl-fn-20-mwj.7.json')\"\nts=\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"\ncat > '/home/ubuntu/projects/CaveChef/scripts/ralph/runs/20260122T123130Z-ralph-cavechef@example.com-926025-2900/receipts/impl-fn-20-mwj.7.json' <<EOF\n{\"type\":\"impl_review\",\"id\":\"fn-20-mwj.7\",\"mode\":\"rp\",\"timestamp\":\"$ts\"}\nEOF"}]},"parent_tool_use_id":null,"session_id":"aad76e69-5816-4f25-ba04-1f05a8e9139e","uuid":"5583a76f-39a0-4bf8-90ab-d9516523478c","isSynthetic":true}
{"type":"assistant","message":{"id":"c641be26-4664-41c3-827c-06e1a2a67190","container":null,"model":"<synthetic>","role":"assistant","stop_reason":"stop_sequence","stop_sequence":"","type":"message","usage":{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":null,"cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0}},"content":[{"type":"text","text":"API Error: 500 {\"type\":\"error\",\"error\":{\"type\":\"api_error\",\"message\":\"Internal server error\"},\"request_id\":\"req_011CXPBivjo6gxdF5GFpk9mN\"}"}],"context_management":null},"parent_tool_use_id":null,"session_id":"aad76e69-5816-4f25-ba04-1f05a8e9139e","uuid":"bc4d83d4-d003-4c3f-920a-58b4dfbb6da9","error":"unknown"}
{"type":"result","subtype":"success","is_error":true,"duration_ms":567,"duration_api_ms":0,"num_turns":2,"result":"API Error: 500 {\"type\":\"error\",\"error\":{\"type\":\"api_error\",\"message\":\"Internal server error\"},\"request_id\":\"req_011CXPBivjo6gxdF5GFpk9mN\"}","session_id":"aad76e69-5816-4f25-ba04-1f05a8e9139e","total_cost_usd":0,"usage":{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0}},"modelUsage":{},"permission_denials":[],"uuid":"3e383473-f24f-4055-80a1-0799d14869ac"}
ralph: missing impl review receipt; forcing retry
ralph: task not done; forcing retry
## Evidence
- Commits:
- Tests:
- PRs:
