---
description: Run Stalagmight's adversarial, multi-lens pre-PR review gate
agent: build
---
Run the project's pre-PR review on the current Stalagmight change. This is an
ADVERSARIAL review: assume the change is broken until the evidence shows
otherwise. Do not rubber-stamp it.

## Scope

Review `git diff master...HEAD`. If that is empty, review the staged diff, then
the unstaged diff. Read enough surrounding code and documentation to judge the
change and its blast radius. If the diff is too large for complete review, tell
each reviewer to inspect the riskiest files first and report what it did not
reach.

## Fan Out

Launch the ten reviewers below concurrently with the Task tool. Use `general`
subagents for every lens. Do not duplicate their work in the main thread while
they run.

Brief reviewers blind to author intent. Give each reviewer only:

- The diff scope and relevant files to inspect.
- Its assigned lens below.
- The shared review contract.

Do not explain what the author intended, why a design is believed correct, or
which code is supposedly safe. PR descriptions and code comments are claims to
verify, not facts. Neutral pointers are allowed; conclusions are not.

Give every reviewer this shared contract:

> Review ONLY through your assigned lens. Do not defer to or suppress another
> lens. Return findings as `file:line · why · fix-or-test`, ordered by severity.
> Separate VERIFIED findings from ASSUMPTIONS. Never assert a bug you did not
> trace. Apply the same burden of proof to safety: quote the line that proves a
> load-bearing guarantee. An unverified membership, enumeration, configuration,
> or consumer is itself a finding: report `ASSUMPTION (unverified): ... · what
> to check`. Verify consumers, not just producers: grep every changed
> state/flag/field and confirm the intended route reads it. If you find nothing,
> name the riskiest mechanism in your lens, what would break it, and the evidence
> that rules that failure out. Do not edit files.

### Lens 1: State Invalidation And Lifecycle

- Cached external state such as snap markers, ruler data, warning identity,
  clipboard matches, and MapLibre feature-state must be invalidated on every
  relevant mutation, reset, IPC reply, project edit, and view switch.
- Rehydrate mutable objects by stable identity (`shot_id` or UUID), never an
  index captured before insert/delete.
- MapLibre source behavior must match the actual source type. GeoJSON
  `setData()` and vector-tile `setTiles()` have different feature-state
  semantics. Rebuild paths must clear stale IDs and restore current state
  without moving O(N) work into hover handling.

### Lens 2: IPC And Async Correctness

- Frontend IPC responses that paint or mutate must be version-guarded. Capture
  project identity at request time (`created_at`, `modified_at`, file path; see
  `projectIdentityKey` in `src/hooks/useMapTools.ts`) and drop stale replies.
- Geometry readiness is separate from project identity. The adjusted-geometry
  swap may not bump `modified_at`; inspect guards keyed on adjusted stations or
  survey data in `src/components/Map/MapCanvas.tsx`.
- Reset context must invalidate in-flight work. Review TS async paths under
  `src/hooks`, `src/components/Map`, and `src/store`; separately verify Rust
  cache/load-token behavior when the diff touches it.

### Lens 3: Geometry And Multi-Section Integrity

- Make inclusive/exclusive range boundaries explicit and test endpoints.
- UUID/position keys must include `section_id` in every read, write, and delete
  path. Test duplicate UUIDs across sections.
- Section and shot IDs are immutable foreign keys for merges, closures, and
  comments.
- Metadata-only edits still touch the project and create undo entries, but must
  not run geometry reconciliation unless geometry changed.

### Lens 4: Migration And Persistence

- Do not persist transient defaults or newly minted in-memory values before
  they become authoritative.
- Restore with the current project's configuration, not `Config::default()`.
- Inspect legacy, read-only, missing-table, collision, and reopen paths.
- Saves must remain atomic through temporary file plus rename.

### Lens 5: UI And Backend Guard Parity

- Every conditionally disabled action needs a fail-safe backend guard for
  read-only state, database availability, schema state, and destructive impact.
- Destructive actions remain disabled until impact preview resolves, and the
  preview must describe the action actually offered.
- Nullable frontend gates must match the backend condition they represent.

### Lens 6: Project Landmines

- Telemetry uses self-describing JSON+gzip. Event/source vocabulary still must
  be synchronized between `src/utils/telemetry.ts` and
  `src-tauri/src/telemetry/registry.rs`; read `docs/telemetry.md`.
- IPC TypeScript files under `src/types/ipc/` and `src/types/ipc.generated.ts`
  are generated. Flag hand edits; regeneration uses `pnpm gen:ipc-types`.
- Rust formatting, clippy, file-size ratchet, and private-leak gates are CI
  requirements. Read `CLAUDE.md` and `docs/linting.md`.
- Heavy O(N) diagnostics must be debug-gated; hot-path frontend logs use
  `debugLog()`. Read `docs/debug-gates.md` and `docs/performance.md`.
- Check Linux/macOS/Windows behavior, including tile URL forms and the Windows
  test manifest requirement.

### Lens 7: Tests

- Look for adversarial boundary, duplicate-identity, legacy-load, and stale
  async cases rather than happy paths only.
- Flag new `waitForTimeout` usage as a flake risk. Prefer observable polling.
- Verify fixtures and coverage were not silently removed.
- Confirm tests fail without the fix when that can be established safely.

### Lens 8: Security

- Treat imported files, paths, IPC payloads, network responses, and telemetry as
  hostile input.
- Check traversal, validation, unsafe Rust, secrets, credentials, and PII.
- Verify errors and logs do not expose tokens or private paths.

### Lens 9: Goal And Guarantee Trace

- Infer the user-facing guarantees from the diff alone.
- Trace each guarantee end to end: trigger, state written, consumer, effect.
- Confirm the exact route/dialog/state appears in each consumer condition or
  enumeration. Quote the gating line.
- Report every broken or unverifiable link, even if each isolated hunk appears
  correct.

### Lens 10: Holistic Code Review

- Independently review the complete diff for correctness, regressions,
  performance, maintainability, and missing tests.
- Prioritize concrete bugs over style. Trace findings through callers and
  consumers.
- Do not rely on the other nine lenses or their conclusions. This replaces the
  Claude-only bundled `/code-review` voice in the OpenCode workflow.

## Synthesize

Wait for every reviewer. Then:

1. Deduplicate findings with the same `file:line` and mechanism. Keep the most
   concrete version and note every lens that raised it.
2. Re-read disputed code in the main thread. Drop refuted findings. Rank
   VERIFIED findings above ASSUMPTIONS.
3. Do not re-flag known intentional behavior: mid-section shot insertions
   renumber later station positions; Rust formatting-only changes; or
   `#[serde(default)]` tolerance of unknown configuration fields.
4. Do not edit code during this command unless the user explicitly invoked it
   with `$ARGUMENTS` containing `fix`. If `fix` was requested, first present the
   synthesized verdict, then implement verified findings and rerun affected
   checks.

## Output

Use this stable shape:

1. **Verdict**: `Block`, `Needs-work`, or `Approve-with-nits`, followed by the
   single most important issue.
2. **Must-fix**: correctness, security, CI, and contract findings as
   `file:line · why · fix-or-test`.
3. **Should-fix**: non-blocking but material findings in the same format.
4. **Nits**: terse, low-impact items.
5. **Coverage**: list all ten lenses, what each inspected, what it skipped, and
   any assumptions it could not verify.

If no findings survive synthesis, say so explicitly and identify residual
risks or testing gaps.
