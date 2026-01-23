# fn-20-mwj.6 Fix column widths for Length and Depth Out

## Description
Increase minimum column widths for "Length (m)" and "Depth Out" columns to prevent text wrapping.

**Size:** S
**Files:**
- `src/components/SingleSystemView/DataTable.tsx`

## Approach

1. Find columns array (lines 71-112)

2. Update width for Length column (line 95):
   - Current: `width: '80px'`
   - Change to: `width: '100px'` (or appropriate size to fit "Length (m)")

3. Update width for Depth Out column (line 99):
   - Current: `width: '80px'`
   - Change to: `width: '95px'` (or appropriate size to fit "Depth Out")

4. Test with various data to ensure no wrapping

## Key context

Current column definitions at DataTable.tsx:94-99:
```tsx
{ key: 'length', header: 'Length (m)', width: '80px', align: 'right' as const },
// ...
{ key: 'depth_out', header: 'Depth Out', width: '80px', align: 'right' as const },
```
## Acceptance
- [ ] "Length (m)" header fits on single line
- [ ] "Depth Out" header fits on single line
- [ ] Column widths appropriate for typical data values
- [ ] Table layout not broken by width changes
- [ ] Type check passes: `pnpm tsc --noEmit`
## Done summary
Blocked:
Auto-blocked after 5 attempts.
Run: 20260122T123130Z-ralph-cavechef@example.com-926025-2900
Task: fn-20-mwj.6

Last output:
{"type":"system","subtype":"init","cwd":"/home/ubuntu/projects/CaveChef","session_id":"29ae64ea-037a-4aa4-bc4c-e73d3f61d908","tools":["Task","TaskOutput","Bash","Glob","Grep","ExitPlanMode","Read","Edit","Write","NotebookEdit","WebFetch","TodoWrite","WebSearch","KillShell","AskUserQuestion","Skill","EnterPlanMode","ToolSearch"],"mcp_servers":[],"model":"claude-opus-4-5-20251101","permissionMode":"bypassPermissions","slash_commands":["codex","ralph","prd","flow-next:flow-next:impl-review","flow-next:flow-next:sync","flow-next:flow-next:setup","flow-next:flow-next:plan-review","flow-next:flow-next:ralph-init","flow-next:flow-next:uninstall","flow-next:flow-next:plan","flow-next:flow-next:interview","flow-next:flow-next:work","flow-next:flow-next-rp-explorer","flow-next:browser","flow-next:flow-next-export-context","flow-next:flow-next-ralph-init","flow-next:flow-next-plan","flow-next:flow-next-worktree-kit","flow-next:flow-next-work","flow-next:flow-next","flow-next:flow-next-plan-review","flow-next:flow-next-sync","flow-next:flow-next-setup","flow-next:flow-next-interview","flow-next:flow-next-impl-review","compact","context","cost","init","pr-comments","release-notes","review","security-review"],"apiKeySource":"none","claude_code_version":"2.1.17","output_style":"default","agents":["Bash","general-purpose","statusline-setup","Explore","Plan","flow-next:worker","flow-next:epic-scout","flow-next:docs-scout","flow-next:memory-scout","flow-next:repo-scout","flow-next:flow-gap-analyst","flow-next:github-scout","flow-next:docs-gap-scout","flow-next:practice-scout","flow-next:quality-auditor","flow-next:context-scout","flow-next:plan-sync"],"skills":["codex","ralph","prd","flow-next:flow-next-rp-explorer","flow-next:browser","flow-next:flow-next-export-context","flow-next:flow-next-ralph-init","flow-next:flow-next-plan","flow-next:flow-next-worktree-kit","flow-next:flow-next-work","flow-next:flow-next","flow-next:flow-next-plan-review","flow-next:flow-next-sync","flow-next:flow-next-setup","flow-next:flow-next-interview","flow-next:flow-next-impl-review"],"plugins":[{"name":"flow-next","path":"/home/ubuntu/.claude/plugins/cache/gmickel-claude-marketplace/flow-next/0.17.4"}],"uuid":"a05fdb1c-9fe4-4f24-b966-0793c5120199"}
{"type":"assistant","message":{"id":"336c94f1-3dcf-4469-945d-cae6632f1fc4","container":null,"model":"<synthetic>","role":"assistant","stop_reason":"stop_sequence","stop_sequence":"","type":"message","usage":{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":null,"cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0}},"content":[{"type":"text","text":"API Error: 500 {\"type\":\"error\",\"error\":{\"type\":\"api_error\",\"message\":\"Internal server error\"},\"request_id\":\"req_011CXPBhQ82MGK53uwAkhawA\"}"}],"context_management":null},"parent_tool_use_id":null,"session_id":"29ae64ea-037a-4aa4-bc4c-e73d3f61d908","uuid":"a3ef001f-0970-4324-ab9c-0a1071b65b3c","error":"unknown"}
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Stop hook feedback:\nCannot stop: Review receipt not written. You must write the receipt to: /home/ubuntu/projects/CaveChef/scripts/ralph/runs/20260122T123130Z-ralph-cavechef@example.com-926025-2900/receipts/impl-fn-20-mwj.6.json\nRun:\nmkdir -p \"$(dirname '/home/ubuntu/projects/CaveChef/scripts/ralph/runs/20260122T123130Z-ralph-cavechef@example.com-926025-2900/receipts/impl-fn-20-mwj.6.json')\"\nts=\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"\ncat > '/home/ubuntu/projects/CaveChef/scripts/ralph/runs/20260122T123130Z-ralph-cavechef@example.com-926025-2900/receipts/impl-fn-20-mwj.6.json' <<EOF\n{\"type\":\"impl_review\",\"id\":\"fn-20-mwj.6\",\"mode\":\"rp\",\"timestamp\":\"$ts\"}\nEOF"}]},"parent_tool_use_id":null,"session_id":"29ae64ea-037a-4aa4-bc4c-e73d3f61d908","uuid":"eba92888-2bb5-411d-a864-e50073e465a5","isSynthetic":true}
{"type":"assistant","message":{"id":"8527cc51-baab-442f-bbe2-e59c60421d39","container":null,"model":"<synthetic>","role":"assistant","stop_reason":"stop_sequence","stop_sequence":"","type":"message","usage":{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":null,"cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0}},"content":[{"type":"text","text":"API Error: 500 {\"type\":\"error\",\"error\":{\"type\":\"api_error\",\"message\":\"Internal server error\"},\"request_id\":\"req_011CXPBhRNRtiS2HDxHJHo2n\"}"}],"context_management":null},"parent_tool_use_id":null,"session_id":"29ae64ea-037a-4aa4-bc4c-e73d3f61d908","uuid":"33b9eca3-38fc-49ec-ab96-605983adc108","error":"unknown"}
{"type":"result","subtype":"success","is_error":true,"duration_ms":601,"duration_api_ms":0,"num_turns":2,"result":"API Error: 500 {\"type\":\"error\",\"error\":{\"type\":\"api_error\",\"message\":\"Internal server error\"},\"request_id\":\"req_011CXPBhRNRtiS2HDxHJHo2n\"}","session_id":"29ae64ea-037a-4aa4-bc4c-e73d3f61d908","total_cost_usd":0,"usage":{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0}},"modelUsage":{},"permission_denials":[],"uuid":"74cda802-ff18-4632-9d0e-137392d2f12e"}
ralph: missing impl review receipt; forcing retry
ralph: task not done; forcing retry
## Evidence
- Commits:
- Tests:
- PRs:
