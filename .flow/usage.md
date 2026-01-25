# Flow-Next Usage Guide

Task tracking for AI agents. All state lives in `.flow/`.

## CLI

```bash
.flow/bin/flowctl --help              # All commands
.flow/bin/flowctl <cmd> --help        # Command help
```

## File Structure

```
.flow/
├── bin/flowctl         # CLI (this install)
├── epics/fn-N-xxx.json # Epic metadata
├── specs/fn-N-xxx.md   # Epic specifications
├── tasks/fn-N-xxx.M.json # Task metadata
├── tasks/fn-N-xxx.M.md   # Task specifications
├── memory/             # Context memory
└── meta.json           # Project metadata
```

## IDs

- Epics: `fn-N-xxx` (e.g., fn-1-abc, fn-2-z9k) or legacy `fn-N`
- Tasks: `fn-N-xxx.M` (e.g., fn-1-abc.1, fn-1-abc.2) or legacy `fn-N.M`

## Common Commands

```bash
# List
.flow/bin/flowctl list               # All epics + tasks grouped
.flow/bin/flowctl epics              # All epics with progress
.flow/bin/flowctl tasks              # All tasks
.flow/bin/flowctl tasks --epic fn-1  # Tasks for epic
.flow/bin/flowctl tasks --status todo # Filter by status

# View
.flow/bin/flowctl show fn-1          # Epic with all tasks
.flow/bin/flowctl show fn-1.2        # Single task
.flow/bin/flowctl cat fn-1           # Epic spec (markdown)
.flow/bin/flowctl cat fn-1.2         # Task spec (markdown)

# Status
.flow/bin/flowctl ready --epic fn-1  # What's ready to work on
.flow/bin/flowctl validate --all     # Check structure
.flow/bin/flowctl state-path         # Show state directory (for worktrees)

# Create
.flow/bin/flowctl epic create --title "..."
.flow/bin/flowctl task create --epic fn-1 --title "..."

# Work
.flow/bin/flowctl start fn-1.2       # Claim task
.flow/bin/flowctl done fn-1.2 --summary-file s.md --evidence-json e.json

# Dependencies
flowctl dep add fn-1.3 fn-1.2        # This makes fn-1.3 depend on fn-1.2 (fn-1.3 cannot start until fn-1.2 is done).
```

## Workflow

1. `.flow/bin/flowctl epics` - list all epics
2. `.flow/bin/flowctl ready --epic fn-N` - find available tasks
3. `.flow/bin/flowctl start fn-N.M` - claim task
4. Implement the task
5. `.flow/bin/flowctl done fn-N.M --summary-file ... --evidence-json ...` - complete

## Evidence JSON Format

```json
{"commits": ["abc123"], "tests": ["npm test"], "prs": []}
```

## Parallel Worktrees

Runtime state (status, assignee, etc.) is stored in `.git/flow-state/`, shared across worktrees:

```bash
.flow/bin/flowctl state-path              # Show state directory
.flow/bin/flowctl migrate-state           # Migrate existing repo
.flow/bin/flowctl migrate-state --clean   # Migrate + remove runtime from tracked files
```

Migration is optional — existing repos work without changes.

## CRITICAL: Spec Editing Pitfalls

**`task set-spec` APPENDS, not replaces!**

**Always use `--json` for programmatic access:**
```bash
# BAD - may crash or have formatting issues
$FLOWCTL show fn-1

# GOOD - stable output
$FLOWCTL show fn-1 --json
```

**Use stdin heredocs to avoid temp files:**
```bash
# GOOD
$FLOWCTL epic set-plan fn-1 --file - <<'EOF'
# Epic Title
## Overview
...
EOF

# LESS GOOD (works but creates temp files)
cat > /tmp/plan.md << 'EOF'
...
EOF
$FLOWCTL epic set-plan fn-1 --file /tmp/plan.md
```

## More Info

- Human docs: https://github.com/gmickel/gmickel-claude-marketplace/blob/main/plugins/flow-next/docs/flowctl.md
- CLI reference: `.flow/bin/flowctl --help`
