---
name: pre-pr
description: Run Stalagmight's required adversarial pre-PR review across ten independent review lenses, then synthesize one evidence-backed verdict. Use before creating, push-opening, or marking a PR ready, when the user invokes $pre-pr, or when project guidance requires the pre-PR gate.
---

# Pre-PR Review

Run a read-only, adversarial review of the current Stalagmight change. Assume the
change is broken until the code proves otherwise. Do not edit files, commit, push,
or open a PR while running this skill.

## 1. Establish the review scope

1. Read `AGENTS.md` and `references/lenses.md` completely.
2. Inspect `git status --short` and the current branch.
3. Prefer `git diff master...HEAD` as the review diff.
4. If that diff is empty, review `git diff --cached`. If that is also empty,
   review `git diff`.
5. Note relevant untracked files from `git status --short`; inspect them when they
   are part of the intended change.
6. Read enough surrounding code and consumers to judge the diff and its blast
   radius. For a large diff, prioritize the riskiest files and record what was not
   reached.

Treat PR descriptions, commit messages, and in-code rationale as claims to verify,
not facts. Do not pass author intent or the main agent's conclusions to reviewers.

## 2. Fan out independent reviewers

Use Codex collaboration subagents. Spawn one distinct, read-only agent for each of
the ten lenses in `references/lenses.md`, using `fork_turns="none"` so reviewers do
not inherit author framing. Run agents in waves that respect the available
concurrency slots. Do not combine lenses merely to reduce agent calls.

Give each agent only:

- The repository path.
- The chosen diff command and fallback scope.
- An instruction to read `AGENTS.md` before reviewing.
- Its numbered lens from `references/lenses.md`.
- The shared contract below.
- Neutral file pointers when orientation is necessary.

Do not tell an agent what the change is trying to do, why it is correct, or which
parts are believed safe.

Use this shared contract verbatim:

> Review only through your assigned lens. Do not edit files. Return findings as
> `file:line | why | fix-or-test`. Separate VERIFIED facts traced in code from
> ASSUMED claims. Never assert a bug you did not trace. Apply the same burden of
> proof to safety: quote the line that proves a load-bearing safety claim. Report
> an unverified load-bearing membership, enumeration, configuration, or consumer
> as `ASSUMPTION (unverified): ... | what to check`. Verify consumers, not just
> producers: for every changed state, flag, or field, grep its consumers and quote
> the gating line that delivers the intended effect for the specific route or
> state. If there are no findings, name the riskiest mechanism you checked, what
> would break it, and the evidence that rules that out. Put highest-signal
> findings first and state what you did not reach.

For lens 10, task the agent with an independent general code review. This is the
Codex replacement for Claude's bundled `/code-review` voice. It must use the same
scope and contract, prioritize correctness, security, regressions, and missing
tests, and remain blind to the other lens results.

If subagents are unavailable, execute the lenses sequentially in the main thread
and disclose that reduced independence in the Coverage section.

## 3. Verify and synthesize

Wait for every lens. Then:

1. Deduplicate findings with the same file, line, and mechanism. Keep the most
   concrete version and name every lens that raised it.
2. Re-open the cited code and verify each must-fix and should-fix claim yourself.
3. Drop refuted findings. Rank VERIFIED findings above ASSUMED findings.
4. Try to resolve load-bearing assumptions with read-only inspection. Keep any
   unresolved assumption explicit rather than converting it into a claimed bug.
5. Do not re-flag the known-by-design cases listed in `references/lenses.md`.
6. Do not make fixes during this review. The user can request fixes after seeing
   the verdict.

## 4. Report one comparable verdict

Present findings first, ordered by severity:

1. **Verdict**: `Block`, `Needs-work`, or `Approve-with-nits`, plus the single most
   important issue or the strongest reason approval is justified.
2. **Must-fix**: correctness, security, CI, persistence, or contract failures as
   `file:line | why | fix-or-test`.
3. **Should-fix**: material risks that do not block the PR, in the same format.
4. **Nits**: terse, low-risk observations.
5. **Coverage**: list all ten lenses, what each reviewed, skipped, or could not
   verify, and each lens verdict. State any files or mechanisms not reached.

If there are no findings, say so explicitly and include residual risks and testing
gaps. Never rubber-stamp based only on passing tests.
