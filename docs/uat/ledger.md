# UAT verdict ledger

One line per UAT run - journey suites, release-candidate checklists, and any
other real-app acceptance pass. This file is the durable memory that outlives
agent sessions: append, never rewrite history. Full machine-readable records
live beside it in `runs/` (one JSONL file per run; no fixtures, no personal
names, no verbatim tester feedback - `lint:private-leaks` covers this tree).

How to add a line:

- Journey suite: `pnpm agent:journeys -- --ledger` appends it for you.
- Human checklist: append by hand, linking the checklist and naming the
  platform, e.g. `- 2026-08-12 rc-checklist@<sha> (macos): PASS - all items
  ([checklist](checklists/release-candidate.md))`. Testers stay anonymous
  (user1/user2).

See `docs/plans/2026-08-06_uat-framework.md` (#466) for the framework design.

## Runs

- 2026-08-10 journeys@eb386925 (darwin-arm64): **PASS** - 3 journeys ([record](runs/2026-08-10T1743-eb386925.jsonl))
- 2026-08-10 journeys@32e20ae5 (darwin-arm64): **PASS** - 3 journeys ([record](runs/2026-08-10T205405-32e20ae5.jsonl))
- 2026-08-11 journeys@443f751c (darwin-arm64): **PASS** - 4 journeys ([record](runs/2026-08-11T021516-443f751c.jsonl))
- 2026-08-11 rc-checklist@e84c2eca (macos): **PASS** - v0.5.0-rc4, DMG from the published release opened on a second Mac: dismissible unidentified-developer prompt, not "damaged". Automated prerequisites: journeys 4/4 and scenarios green at the candidate tree; the legacy WDIO specs did NOT run ([checklist](checklists/release-candidate.md))
