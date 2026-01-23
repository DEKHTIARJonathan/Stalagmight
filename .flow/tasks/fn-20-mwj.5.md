# fn-20-mwj.5 Update ID format display in DataTable, DetailPanel, and Warnings

## Description
Update ID display format across DataTable, DetailPanel, and Warnings panel to use sectionId:shotPosition (1-indexed position) instead of internal database IDs.

**Size:** S
**Files:**
- `src/components/SingleSystemView/DataTable.tsx`
- `src/components/SingleSystemView/DetailPanel.tsx`
- `src/utils/formatters.ts` (import)

## Approach

1. **DataTable ID column** (lines 94):
   - Currently shows `shot.id` directly
   - Change to: `formatShotId(selectedSectionId, shots.indexOf(shot) + 1)`
   - Or pass index from render: the column can receive index in render function

2. **DetailPanel ShotDetail** (line 342):
   - Currently: `<DetailRow label="ID" value={section.id}:{shot.id} />`
   - Change to: `formatShotId(section.id, section.shots.indexOf(shot) + 1)`

3. **DetailPanel WarningsContent** (line 235):
   - Currently: `Shot {warning.shot_index + 1}`
   - Change to: `Shot {formatShotId(warning.section_id, warning.shot_index + 1)}`

## Key context

- Section ID: Use internal database ID as-is (not display position)
- Shot position: 1-indexed position within section (1st shot = 1)
- Virtual shots are included in position count

Current DetailPanel shot display at line 342:
```tsx
<DetailRow label="ID" value={`${section.id}:${shot.id}`} />
```
## Acceptance
- [ ] DataTable ID column shows sectionId:shotPosition format
- [ ] DetailPanel ShotDetail shows sectionId:shotPosition format
- [ ] Warnings panel shows sectionId:shotPosition format
- [ ] Shot position is 1-indexed (first shot = 1)
- [ ] Section ID uses internal database ID
- [ ] Format is consistent across all three locations
- [ ] Type check passes: `pnpm tsc --noEmit`
## Done summary
Blocked:
Auto-blocked after 5 attempts.
Run: 20260122T123130Z-ralph-cavechef@example.com-926025-2900
Task: fn-20-mwj.5

Last output:
{"type":"system","subtype":"init","cwd":"/home/ubuntu/projects/CaveChef","session_id":"6a340459-69be-4020-90c2-ca4b9e79756d","tools":["Task","TaskOutput","Bash","Glob","Grep","ExitPlanMode","Read","Edit","Write","NotebookEdit","WebFetch","TodoWrite","WebSearch","KillShell","AskUserQuestion","Skill","EnterPlanMode","ToolSearch"],"mcp_servers":[],"model":"claude-opus-4-5-20251101","permissionMode":"bypassPermissions","slash_commands":["codex","ralph","prd","flow-next:flow-next:impl-review","flow-next:flow-next:sync","flow-next:flow-next:setup","flow-next:flow-next:plan-review","flow-next:flow-next:ralph-init","flow-next:flow-next:uninstall","flow-next:flow-next:plan","flow-next:flow-next:interview","flow-next:flow-next:work","flow-next:flow-next-rp-explorer","flow-next:browser","flow-next:flow-next-export-context","flow-next:flow-next-ralph-init","flow-next:flow-next-plan","flow-next:flow-next-worktree-kit","flow-next:flow-next-work","flow-next:flow-next","flow-next:flow-next-plan-review","flow-next:flow-next-sync","flow-next:flow-next-setup","flow-next:flow-next-interview","flow-next:flow-next-impl-review","compact","context","cost","init","pr-comments","release-notes","review","security-review"],"apiKeySource":"none","claude_code_version":"2.1.17","output_style":"default","agents":["Bash","general-purpose","statusline-setup","Explore","Plan","flow-next:worker","flow-next:epic-scout","flow-next:docs-scout","flow-next:memory-scout","flow-next:repo-scout","flow-next:flow-gap-analyst","flow-next:github-scout","flow-next:docs-gap-scout","flow-next:practice-scout","flow-next:quality-auditor","flow-next:context-scout","flow-next:plan-sync"],"skills":["codex","ralph","prd","flow-next:flow-next-rp-explorer","flow-next:browser","flow-next:flow-next-export-context","flow-next:flow-next-ralph-init","flow-next:flow-next-plan","flow-next:flow-next-worktree-kit","flow-next:flow-next-work","flow-next:flow-next","flow-next:flow-next-plan-review","flow-next:flow-next-sync","flow-next:flow-next-setup","flow-next:flow-next-interview","flow-next:flow-next-impl-review"],"plugins":[{"name":"flow-next","path":"/home/ubuntu/.claude/plugins/cache/gmickel-claude-marketplace/flow-next/0.17.4"}],"uuid":"cb465c7f-b364-4e02-add1-88ed116bc14f"}
{"type":"assistant","message":{"id":"7761d142-8085-4922-8100-224dcbf58005","container":null,"model":"<synthetic>","role":"assistant","stop_reason":"stop_sequence","stop_sequence":"","type":"message","usage":{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":null,"cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0}},"content":[{"type":"text","text":"API Error: 500 {\"type\":\"error\",\"error\":{\"type\":\"api_error\",\"message\":\"Internal server error\"},\"request_id\":\"req_011CXPBfqbekk82pVvpVbgWQ\"}"}],"context_management":null},"parent_tool_use_id":null,"session_id":"6a340459-69be-4020-90c2-ca4b9e79756d","uuid":"17986ddf-7e31-4357-845f-231d1d8f4723","error":"unknown"}
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Stop hook feedback:\nCannot stop: Review receipt not written. You must write the receipt to: /home/ubuntu/projects/CaveChef/scripts/ralph/runs/20260122T123130Z-ralph-cavechef@example.com-926025-2900/receipts/impl-fn-20-mwj.5.json\nRun:\nmkdir -p \"$(dirname '/home/ubuntu/projects/CaveChef/scripts/ralph/runs/20260122T123130Z-ralph-cavechef@example.com-926025-2900/receipts/impl-fn-20-mwj.5.json')\"\nts=\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"\ncat > '/home/ubuntu/projects/CaveChef/scripts/ralph/runs/20260122T123130Z-ralph-cavechef@example.com-926025-2900/receipts/impl-fn-20-mwj.5.json' <<EOF\n{\"type\":\"impl_review\",\"id\":\"fn-20-mwj.5\",\"mode\":\"rp\",\"timestamp\":\"$ts\"}\nEOF"}]},"parent_tool_use_id":null,"session_id":"6a340459-69be-4020-90c2-ca4b9e79756d","uuid":"0019701c-fddf-4d1f-8b0f-475d71b3de32","isSynthetic":true}
{"type":"assistant","message":{"id":"4f0a023a-5436-462a-add4-1e0d5e8ede5e","container":null,"model":"<synthetic>","role":"assistant","stop_reason":"stop_sequence","stop_sequence":"","type":"message","usage":{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":null,"cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0}},"content":[{"type":"text","text":"API Error: 500 {\"type\":\"error\",\"error\":{\"type\":\"api_error\",\"message\":\"Internal server error\"},\"request_id\":\"req_011CXPBfroLGGwcGBPSNS3du\"}"}],"context_management":null},"parent_tool_use_id":null,"session_id":"6a340459-69be-4020-90c2-ca4b9e79756d","uuid":"eb6bc096-016d-4f07-8be2-c5cff0db69ae","error":"unknown"}
{"type":"result","subtype":"success","is_error":true,"duration_ms":794,"duration_api_ms":0,"num_turns":2,"result":"API Error: 500 {\"type\":\"error\",\"error\":{\"type\":\"api_error\",\"message\":\"Internal server error\"},\"request_id\":\"req_011CXPBfroLGGwcGBPSNS3du\"}","session_id":"6a340459-69be-4020-90c2-ca4b9e79756d","total_cost_usd":0,"usage":{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0}},"modelUsage":{},"permission_denials":[],"uuid":"72d70eba-dfa5-4851-8b63-84d77e4134ec"}
ralph: missing impl review receipt; forcing retry
ralph: task not done; forcing retry
## Evidence
- Commits:
- Tests:
- PRs:
