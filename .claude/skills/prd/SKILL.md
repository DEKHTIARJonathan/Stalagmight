---
name: prd
description: "Generate a Product Requirements Document (PRD) as a Plane project with work items. Use when planning a feature, starting a new project, or when asked to create a PRD. Triggers on: create a prd, write prd for, plan this feature, requirements for, spec out."
---

# PRD Generator (Plane MCP Integration)

Create Product Requirements Documents directly in Plane as a project with work items. This enables seamless integration with Ralph for autonomous implementation.

**Prerequisites:** Plane MCP must be configured. See https://github.com/makeplane/plane-mcp-server

---

## The Job

1. Receive a feature description from the user
2. Ask 3-5 essential clarifying questions (with lettered options)
3. Create a Plane project with the PRD as description
4. Create Plane work items for each user story
5. Save local `.ralph-project` configuration

**Important:** Do NOT start implementing. Just create the PRD in Plane.

---

## Step 1: Clarifying Questions

Ask only critical questions where the initial prompt is ambiguous. Focus on:

- **Problem/Goal:** What problem does this solve?
- **Core Functionality:** What are the key actions?
- **Scope/Boundaries:** What should it NOT do?
- **Success Criteria:** How do we know it's done?

### Format Questions Like This:

```
1. What is the primary goal of this feature?
   A. Improve user onboarding experience
   B. Increase user retention
   C. Reduce support burden
   D. Other: [please specify]

2. Who is the target user?
   A. New users only
   B. Existing users only
   C. All users
   D. Admin users only

3. What is the scope?
   A. Minimal viable version
   B. Full-featured implementation
   C. Just the backend/API
   D. Just the UI
```

This lets users respond with "1A, 2C, 3B" for quick iteration.

---

## Step 2: Create Plane Project

Use `mcp__plane__create_project` with the PRD content:

```json
{
  "name": "<Feature Name>",
  "description": "Branch: ralph/<feature-name-kebab-case>\n\n# <Feature Name>\n\n## Overview\n<Brief description>\n\n## Goals\n- Goal 1\n- Goal 2\n\n## Functional Requirements\n- FR-1: ...\n- FR-2: ...\n\n## Non-Goals\n- Non-goal 1\n\n## Technical Considerations\n- Notes...\n\n## Success Metrics\n- Metric 1"
}
```

**Critical:** The first line of the description MUST be `Branch: ralph/<feature-name>` for Ralph to identify the correct git branch.

---

## Step 3: Create Plane Work Items

For each user story, use `mcp__plane__create_work_item`:

```json
{
  "name": "US-001: <Story Title>",
  "project_id": "<project-uuid>",
  "description_html": "<p>As a <user>, I want <feature> so that <benefit>.</p><h2>Acceptance Criteria</h2><ul><li>Criterion 1</li><li>Criterion 2</li><li>Typecheck passes</li></ul>",
  "priority": "urgent"
}
```

### Priority Mapping

Create work items in dependency order. Map story position to Plane priority:

| Story Position | Plane Priority |
|----------------|----------------|
| 1st (first)    | `"urgent"`     |
| 2nd            | `"high"`       |
| 3rd            | `"medium"`     |
| 4th and later  | `"low"`        |

### Work Item Ordering Rules

Stories should be ordered by dependencies:
1. Database/Schema changes first
2. Backend/API logic second
3. UI components that use the backend third
4. Dashboards/aggregations last

---

## Step 4: Save Local Configuration

Create `.ralph-project` in the Ralph directory:

```json
{
  "planeProjectId": "<project-id-from-step-2>",
  "branchName": "ralph/<feature-name>"
}
```

Use the Write tool to save this file.

---

## User Story Format

Each story needs:
- **Title:** Short descriptive name
- **Description:** "As a [user], I want [feature] so that [benefit]"
- **Acceptance Criteria:** Verifiable checklist of what "done" means

**Important:**
- Acceptance criteria must be verifiable, not vague. "Works correctly" is bad. "Button shows confirmation dialog before deleting" is good.
- **For any story with UI changes:** Always include "Verify in browser" as acceptance criteria. (The agent will auto-select Playwright MCP or dev-browser based on availability)
- **For stories with testable logic (optional):** Consider adding "Tests written first (TDD)" as acceptance criteria when the story involves complex business logic, algorithms, or API contracts.
- **ALL stories:** Must include "Typecheck passes" as final criterion.

---

## Story Size Guidelines

Each story must be completable in ONE Ralph iteration (one context window). Right-sized stories:

**Good (single iteration):**
- Add a database column and migration
- Add a UI component to an existing page
- Update a server action with new logic
- Add a filter dropdown to a list

**Too large (split these):**
- "Build the entire dashboard"
- "Add authentication"
- "Refactor the API"

**Rule of thumb:** If you can't describe the change in 2-3 sentences, it's too big.

---

## Writing for Junior Developers

The PRD reader may be a junior developer or AI agent. Therefore:

- Be explicit and unambiguous
- Avoid jargon or explain it
- Provide enough detail to understand purpose and core logic
- Number requirements for easy reference
- Use concrete examples where helpful

---

## Output Summary

After creating everything, show the user:

```
Created Plane Project: <Project Name>
Project ID: <uuid>
Branch: ralph/<feature-name>

Created Work Items:
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

**User request:** "Create a PRD for adding task priority to our todo app"

**After clarifying questions, creates:**

1. **Plane Project:** "Task Priority System"
   - Description contains full PRD with `Branch: ralph/task-priority` on first line

2. **Plane Work Items:**
   - US-001: Add priority field to database (Urgent)
   - US-002: Display priority indicator on task cards (High)
   - US-003: Add priority selector to task edit (Medium)
   - US-004: Filter tasks by priority (Low)

3. **Local file:** `.ralph-project` with project ID and branch name

---

## Checklist

Before finishing:

- [ ] Asked clarifying questions with lettered options
- [ ] Created Plane project with PRD in description
- [ ] Project description starts with `Branch: ralph/<feature-name>`
- [ ] Created work items for all user stories
- [ ] Work items have correct priority (urgent/high/medium/low based on order)
- [ ] All stories include "Typecheck passes" criterion
- [ ] UI stories include "Verify in browser" criterion
- [ ] Stories with complex logic considered for "Tests written first (TDD)" criterion
- [ ] Stories are small enough for one iteration
- [ ] Stories are ordered by dependencies
- [ ] Saved `.ralph-project` configuration
