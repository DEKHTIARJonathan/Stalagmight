---
name: ralph
description: "Convert existing PRDs to Plane projects and work items for the Ralph autonomous agent system. Use when you have an existing PRD markdown file and need to set up Ralph. Triggers on: convert this prd, turn this into ralph format, set up ralph for this prd, ralph convert."
---

# Ralph PRD to Plane Converter

Converts existing PRD markdown files to Plane projects and work items for autonomous execution by Ralph.

**Prerequisites:** Plane MCP must be configured. See https://github.com/makeplane/plane-mcp-server

---

## The Job

1. Read the PRD markdown file provided by the user
2. Parse user stories and requirements
3. Create a Plane project with PRD content
4. Create Plane work items for each user story
5. Save `.ralph-project` configuration

---

## Step 1: Parse the PRD

Read the PRD file and extract:
- **Title/Name** from `# PRD: [Name]` or first heading
- **Description/Overview** from Introduction section
- **Goals** from Goals section
- **User Stories** from User Stories section (parse US-XXX format)
- **Non-Goals** from Non-Goals section
- **Technical Considerations** from that section

---

## Step 2: Create Plane Project

Use `mcp__plane__create_project`:

```json
{
  "name": "<PRD Title>",
  "description": "Branch: ralph/<feature-kebab-case>\n\n<Full PRD content as markdown>"
}
```

**Critical:** The first line of the description MUST be `Branch: ralph/<feature-name>` for Ralph to identify the correct git branch.

---

## Step 3: Create Work Items from User Stories

For each `### US-XXX:` section in the PRD:

1. Extract title (text after `US-XXX:`)
2. Extract description (the "As a..." line)
3. Extract acceptance criteria (the `- [ ]` items)
4. Map position to priority (1st=urgent, 2nd=high, etc.)

Create work item using `mcp__plane__create_work_item`:

```json
{
  "name": "US-001: <Title>",
  "project_id": "<project-uuid>",
  "description_html": "<p><As a... description></p><h2>Acceptance Criteria</h2><ul><li>Criterion 1</li><li>Criterion 2</li></ul>",
  "priority": "urgent"
}
```

### Priority Mapping

| PRD Story Position | Plane Priority |
|--------------------|----------------|
| 1 (first)          | `"urgent"`     |
| 2                  | `"high"`       |
| 3                  | `"medium"`     |
| 4+                 | `"low"`        |

---

## Step 4: Save Configuration

Create `.ralph-project` in the Ralph directory:

```json
{
  "planeProjectId": "<project-id>",
  "branchName": "ralph/<feature-name>"
}
```

---

## Story Size: The Number One Rule

**Each story must be completable in ONE Ralph iteration (one context window).**

Ralph spawns a fresh Claude Code instance per iteration with no memory of previous work. If a story is too big, the LLM runs out of context before finishing and produces broken code.

### Right-sized stories:
- Add a database column and migration
- Add a UI component to an existing page
- Update a server action with new logic
- Add a filter dropdown to a list

### Too big (split these):
- "Build the entire dashboard" - Split into: schema, queries, UI components, filters
- "Add authentication" - Split into: schema, middleware, login UI, session handling
- "Refactor the API" - Split into one story per endpoint or pattern

**Rule of thumb:** If you cannot describe the change in 2-3 sentences, it is too big.

---

## Story Ordering: Dependencies First

Stories execute in priority order. Earlier stories must not depend on later ones.

**Correct order:**
1. Schema/database changes (migrations)
2. Server actions / backend logic
3. UI components that use the backend
4. Dashboard/summary views that aggregate data

**Wrong order:**
1. UI component (depends on schema that does not exist yet)
2. Schema change

---

## Acceptance Criteria: Must Be Verifiable

Each criterion must be something Ralph can CHECK, not something vague.

### Good criteria (verifiable):
- "Add `status` column to tasks table with default 'pending'"
- "Filter dropdown has options: All, Active, Completed"
- "Clicking delete shows confirmation dialog"
- "Typecheck passes"
- "Tests pass"

### Bad criteria (vague):
- "Works correctly"
- "User can do X easily"
- "Good UX"
- "Handles edge cases"

### Always include as final criterion:
```
"Typecheck passes"
```

For stories with testable logic, also include:
```
"Tests pass"
```

### For stories with testable business logic (optional):
```
"Tests written first (TDD)"
```
Use this when the story involves complex logic, algorithms, or API contracts that benefit from test-first development.

### For stories that change UI, also include:
```
"Verify in browser"
```
(The agent will auto-select Playwright MCP or dev-browser based on availability)

---

## Validation Before Creating

Before creating in Plane, verify:

- [ ] Each story is completable in one iteration (small enough)
- [ ] Stories are ordered by dependency (schema → backend → UI)
- [ ] Every story has "Typecheck passes" as criterion
- [ ] UI stories have "Verify in browser"
- [ ] Stories with complex logic considered for "Tests written first (TDD)"
- [ ] Acceptance criteria are verifiable (not vague)
- [ ] No story depends on a later story

If stories are too big, split them before creating work items.

---

## Output Summary

After creating everything, show the user:

```
Converted PRD to Plane:

Project: <Project Name>
ID: <uuid>
Branch: ralph/<feature-name>

Work Items Created:
- US-001: <Title> (Urgent)
- US-002: <Title> (High)
- US-003: <Title> (Medium)
- US-004: <Title> (Low)

Saved .ralph-project configuration.

To start Ralph:
  ./ralph.sh [max_iterations]
```

---

## Example

**Input:** `tasks/prd-task-status.md`

**Creates:**
1. **Plane Project:** "Task Status Feature"
   - Description contains full PRD with `Branch: ralph/task-status` on first line

2. **Plane Work Items:**
   - US-001: Add status field to tasks table (Urgent)
   - US-002: Display status badge on task cards (High)
   - US-003: Add status toggle to task list rows (Medium)
   - US-004: Filter tasks by status (Low)

3. **Local file:** `.ralph-project` with project ID and branch name

---

## Splitting Large PRDs

If a PRD has big features, split them:

**Original:**
> "Add user notification system"

**Split into:**
1. US-001: Add notifications table to database
2. US-002: Create notification service for sending notifications
3. US-003: Add notification bell icon to header
4. US-004: Create notification dropdown panel
5. US-005: Add mark-as-read functionality
6. US-006: Add notification preferences page

Each is one focused change that can be completed and verified independently.

---

## Checklist

Before finishing:

- [ ] Parsed PRD file successfully
- [ ] Created Plane project with PRD in description
- [ ] Project description starts with `Branch: ralph/<feature-name>`
- [ ] Created work items for all user stories
- [ ] Work items have correct priority (urgent/high/medium/low based on order)
- [ ] All stories include "Typecheck passes" criterion
- [ ] UI stories include "Verify in browser" criterion
- [ ] Stories are small enough for one iteration
- [ ] Stories are ordered by dependencies
- [ ] Saved `.ralph-project` configuration
