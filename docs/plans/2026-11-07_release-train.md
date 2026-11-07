# Stalagmight release train: design proposal

Status: **draft for the two maintainers to review together.** No code and no workflow YAML.
Conventions: `[path:line]` points at evidence that was read. `ASSUMPTION` marks claims that
could not be verified. "Maintainer A" is the macOS owner. "Maintainer B" owns geometry and
SpeleoDB, travels often and has no Mac.

> **Decision already taken that departs from section 8:** the v0.5.0-rc6 cut (2026-11-07)
> carries Developer ID signing, notarization AND the in-app updater (maintainer A's call), where
> section 8 recommends shipping 0.5.0 without the updater. Open question 14 is therefore about
> whether 0.5.0 final keeps it, not whether rc6 has it.

## 0. Where we are now

- **Tags.** Release candidates rc1 to rc5 were tagged between 2026-07-29 and 2026-08-13; rc6 is
  being cut 2026-11-07.
- **Moving target.** 144 merge commits landed between rc1 and rc5, and 18 more since rc5
  (`git log --merges`). Every candidate is cut from a moving master, so each one carries new
  features and new bugs - the rc treadmill. Nothing in `docs/releasing.md` defines when a
  candidate becomes final.
- **Changelog written at tag time.** The policy is "Update CHANGELOG.md every time a new version
  is tagged" [CLAUDE.md:171], which is why every cut needs an audit. `release-tag.sh` only
  catches entries stranded under `[Unreleased]` [docs/releasing.md:32-43]; it cannot catch
  entries nobody wrote.
- **Version files stay plain on candidates** (`0.5.0`), because the Windows MSI bundler rejects a
  non-numeric pre-release [docs/releasing.md:113-117]. The in-app updater compares against
  `app.package_info().version` [origin/feat/579-in-app-updater:src-tauri/src/commands/app_update.rs:481],
  so an rc install reports 0.5.0 and never sees 0.5.0 stable as newer.
- **Tag pipeline.** A tag runs verify, a 3-platform build, then publish. Verify includes a
  release-profile `cargo check` [.github/workflows/release.yml:64-65]. A suffixed tag publishes as
  a pre-release [release.yml:259-262]; a dispatch rehearsal builds but never publishes
  [release.yml:8,210].
- **Signing (#580).** `build` is gated on `environment: release`; the DMG is notarized and stapled
  with a 30-minute notary timeout; the build job has a 60-minute timeout. Tauri notarizes only the
  `.app`, so the DMG step was added after the first rehearsal showed Gatekeeper rejecting a
  signed-but-unnotarized DMG. The first notarization for the new Apple team took about 25 minutes.
- **The `release` environment** has 1 required reviewer, self-review allowed, no admin bypass and
  no deployment branch policy. GitHub needs only one listed reviewer to approve, so two-person
  approval cannot be enforced there.
- **master is unprotected**, deliberately [ci.yml:12]. CI runs only on pushes and PRs to master
  [ci.yml:14-19], so a `release/*` branch would get no CI today.
- **Release notes.** The install footer used to be static ("None of these builds are notarized",
  [scripts/release-notes.sh:113]); #580 makes it follow the build's signing marker. The same
  pattern should apply to every claim the notes make about the build.
- **The RC checklist is stale.** It still expects the "unidentified developer" prompt on macOS
  [docs/uat/checklists/release-candidate.md:28].
- **The UAT ledger** last records rc4 and has no rc5 line [docs/uat/ledger.md]. The agent harness
  runs on demand and per candidate, never as a merge gate [docs/TESTING.md:35-39,84].
- **File format is one-way.** `.stalx` is at `SCHEMA_VERSION = 18`, and readers refuse files
  written by a newer schema [src-tauri/crates/persistence/src/persistence/sqlite.rs:96-98]. A
  rollback cannot undo a file a user has already saved in a newer format.
- **Rust toolchain is not pinned.** There is no `rust-toolchain.toml`; release.yml installs the
  current stable [release.yml:28].
- **Labels.** P0 to P3 and `release` exist; 0 open P0 and 0 open P1 at the time of reading.
- **Cost.** About 181 billed-minute equivalents per tag, mostly macOS [docs/releasing.md:313-320].
  ASSUMPTION: the repo is public, and standard hosted runners are normally free for public repos.
  Check the real bill before letting cost drive cadence (Q12).

## 1. Goals and non-goals

**Goals**
1. A predictable, time-based train. Releases leave on schedule; features do not hold a train.
2. Every gate is checkable: a command, an API query or a ledger line. No gate is just a judgement.
3. Changelog completeness costs nothing at cut time.
4. Either maintainer can release. Only the macOS-specific manual checks need maintainer A.
5. Updates are safe: no build may ship that strands installs or breaks semver ordering.
6. Cost-aware: one paid 3-platform build per weekly, and no rebuilds just to rename a build.

**Non-goals (for now):** LTS branches, more than one supported stable line, Intel macOS, Windows
code signing, staged percentage rollouts, a server-side kill switch, fully unattended signing.

## 2. Trains, cadence and versions

| Train | Purpose | Who gets it | Cadence | Tag | Version the app reports | Manifest |
|---|---|---|---|---|---|---|
| Weekly | Integration build; it is the candidate | Opt-in weekly track: maintainers and trusted collaborators | Mondays, cron, skipped if master has not moved (#579) | `vX.Y.0-weekly.YYYYMMDD` | Full string including `-weekly.YYYYMMDD` (see D1) | `latest-weekly.json` |
| Stable | A promoted, soaked weekly | Default track | Every 4 weeks (first Monday of the month), or skipped | `vX.Y.0` | `X.Y.0` | `latest-stable.json` |
| Hotfix | Fix a stable without new features | Stable track | On demand | `vX.Y.Z` on `release/X.Y` | `X.Y.Z` | `latest-stable.json` |
| rc | Legacy | Testers downloading by hand | Retired after 0.5.0 | `vX.Y.Z-rcN` | plain base | none (#585) |

**Is rc still needed? No - retire it after 0.5.0.** A weekly is a published, signed, downloadable
pre-release, which is everything an rc was, plus it can update itself. To verify a hotfix before
publishing, use a dispatch rehearsal: it builds and signs (after environment approval) without
publishing [releasing.md:326-344]. Keep `release-tag.sh` accepting `-rcN` for one cycle as an
emergency hatch, then remove it.

**Version numbering: minor promotions, patch hotfixes, weeklies on the next unreleased minor.**
- Stable promotions bump the minor (0.6.0, 0.7.0). Hotfixes bump the patch (0.6.1).
- After X.Y.0 ships, weeklies target the next unreleased minor: `0.7.0-weekly.*`. They sort above
  every 0.6.z and below 0.7.0; when 0.7.0 is promoted the weekly series converges onto it (the
  #579 convergence property).
- Hotfix patch numbers never collide with the weekly base.
- Alternative: #579 bakes the next *patch* [origin/feat/579-updater-manifests:docs/releasing.md:640-654].
  Rejected: every hotfix then consumes the base the weekly series was aiming at, and a 100-PR
  feature train ships as a "patch". Switching is cheap because the weekly workflow (#579 PR C) is
  not written yet.
- `release-tag.sh` will then warn on every hotfix that a higher weekly base exists. That warning
  is expected; reword it rather than remove it.

**D1, a blocker for the weekly track: an installed weekly must report its full pre-release version.**
- If PR C bakes a plain `0.7.0` into `tauri.conf.json` (the rc approach, forced by the MSI limit),
  an installed weekly reports `0.7.0`. Next week's `0.7.0-weekly.<later>` then sorts *below* it,
  and `0.7.0` stable is *equal*: weekly users would never be offered anything again.
- Options:
  - (a) Bake the full semver string and give the MSI a separate numeric version.
    ASSUMPTION: Tauri's `bundle.windows.wix.version` allows this; verify it.
  - (b) A custom updater version comparator fed by a baked full version.
    ASSUMPTION: `tauri-plugin-updater` exposes a comparator hook.
  - (c) Numeric-only weeklies. Rejected: burns version numbers and loses pre-release ordering.
- Recommend (a). Gate: a weekly installed on each OS updates to the next weekly before the track
  is announced.

## 3. Branching

**Recommend trunk plus release branches created only when needed; no stabilization freeze on master.**
- Master stays the only integration branch; weeklies flow from it. Stability comes from choosing
  *which* soaked weekly commit to promote, not from freezing master.
- At promotion, create `release/X.Y` at the promoted commit and tag `vX.Y.0` there. The branch
  exists only to carry hotfixes.
- Hotfix flow: fix on master first (PR, `/pre-pr`, regression test), cherry-pick to `release/X.Y`
  through a PR, tag `vX.Y.Z`. If the code is already gone from master, the fix lands on the branch
  only, with an issue explaining why.
- Weekly users receive the fix in the next weekly; dispatch an extra weekly if urgent.
- Prerequisite: CI must also run on `release/**` pushes and PRs. Today it does not [ci.yml:14-19].
- Alternatives considered: trunk-only (a hotfix would ship a week of unrelated changes);
  long-lived release branches (double the merge work for two people); a freeze before each stable
  (a freeze is how 0.5.0 stalled, because rcs kept absorbing master).

## 4. Stage gates

Each gate names its check. "Ledger" means a line in `docs/uat/ledger.md` naming the commit SHA.

**Cut a weekly (automated except for the approval)**

| # | Gate | Check |
|---|---|---|
| W1 | Something changed | The chosen SHA differs from the last weekly's SHA |
| W2 | Last known good, not HEAD | Newest master SHA where `check`, `smoke`, `leak-scan` and the latest `nightly-e2e` all passed (check-runs API). Master is unprotected, so HEAD may be red |
| W3 | Release verify | The existing `verify` job [release.yml:20-67] plus the updater pubkey gate |
| W4 | macOS signing | `verify-macos-signature.sh` runs `spctl` and `stapler validate` on both the .app and the DMG; the job fails if they do not pass |
| W5 | Update artifacts | `.sig` set present; the manifest generator hard-fails on gaps (#585) |
| W6 | No known P0 at the SHA | `gh issue list -l P0 --state open` is empty, or the approver cancels the run |
| W7 | Approval | Either maintainer approves the `release` environment within 48h; otherwise cancel and skip the week |

Post-publish, not a gate: within 72h a maintainer updates from the previous weekly on at least one
OS and adds a ledger line.

**Promote weekly W to stable vX.Y.0**

| # | Gate | Check |
|---|---|---|
| P1 | Soak | W published at least 7 days ago, and no newer weekly was needed to fix a P0 found in W |
| P2 | Known-bug bar | 0 open P0; 0 open P1 created since the previous stable labelled a regression, or both maintainers record a waiver in the promotion issue. Pre-existing P1s do not block |
| P3 | Real-app acceptance | Ledger lines for W's SHA: `pnpm agent:journeys -- --release --ledger`, `STALAGMIGHT_AGENT_RELEASE=1 pnpm agent:scenarios`, fractal-stress `--release` [checklists/release-candidate.md:14-21]; a Tier 2 macOS run with maintainer A's permission grant |
| P4 | Update path | Ledger shows previous weekly -> W and W -> W+1 on macOS and Linux, plus Windows when a tester exists (Q7) |
| P5 | macOS distribution | Maintainer A opens the published W DMG, downloaded (quarantined), on a Mac that did not build it: no "damaged", no unidentified-developer prompt [releasing.md:346-370] |
| P6 | Persistence | If `SCHEMA_VERSION` changed since the last stable: a migration test from the previous stable's schema passes; a maintainer opens and saves a real previous-stable project; the changelog says older versions cannot open re-saved files. Settings from the previous stable load without reset |
| P7 | Changelog | Fragments folded into `## [X.Y.0]`; the `release-tag.sh vX.Y.0 --dry-run` body is read by the person tagging; the footer comes from build markers, never static text |
| P8 | Same commit | `vX.Y.0` points at W's SHA (`git rev-parse` matches); toolchain drift controlled per Q10 |
| P9 | Two-person acknowledgement | Both maintainers tick the promotion issue (asynchronously); then either one pushes the tag and approves the environment |

**Hotfix vX.Y.Z**

| # | Gate | Check |
|---|---|---|
| H1 | Fix on master first, with a regression test at the lowest tier [TESTING.md:46-54] | PR link in the hotfix issue |
| H2 | Branch CI green | `check` on the `release/X.Y` PR (needs the trigger change) |
| H3 | Verified on built artifacts | Dispatch rehearsal on `release/X.Y`; reporter or maintainer confirms the fix; Tier 1 journeys ledger line |
| H4 | Minimal diff | `git log vX.Y.(Z-1)..release/X.Y` contains only the cherry-picks |
| H5 | Signing | W4 and W5 as automated; P5 only if the signing configuration changed |

One maintainer may ship a hotfix alone; the other is told in the hotfix issue.

## 5. Changelog discipline

**Recommend: one changelog fragment per PR, enforced by a PR check, assembled by tooling.**
- Each user-visible PR adds `changelog.d/<issue-or-PR>.<added|changed|fixed|security|removed>.md`,
  written for users. A PR with nothing user-visible carries a `no-changelog` label instead.
- A small check fails a PR that has neither. It must run in a workflow without `paths-ignore`,
  because `check` skips `**/*.md` [ci.yml:16-19]; `leak-scan.yml` is the model.
- `/pre-pr` writes or checks the fragment, so agents produce it when they understand the change best.
- Weekly notes are rendered from unreleased fragments, with "other changes" filled from PR titles.
  Weeklies never fail on notes.
- Promotion folds the fragments into `## [X.Y.0]` and deletes them; `release-tag.sh` refuses if
  any fragment remains.
- A backstop command lists PRs merged since the last stable with neither a fragment nor the label,
  replacing the manual audit with a one-command check.
- Update CLAUDE.md:171 to match.

**Alternatives considered:** editing `CHANGELOG.md` in each PR (agent PRs would constantly
conflict on the same `[Unreleased]` block); notes generated only from commits or PR titles
(written for developers, not users - kept as the weekly fallback); the status quo with an audit at
cut time (about 40 and about 10 missing entries recovered at rc4 and rc6 - it does not scale).

## 6. Roles, approvals and key custody

| Duty | Maintainer A (macOS owner) | Maintainer B (geometry/SpeleoDB, travels, no Mac) | Agents |
|---|---|---|---|
| Weekly approval | Either one | Either one | none |
| Stable promotion | Captain by default (P3 Tier 2, P5) | Co-signer; captain if A is away and P5 is already done for W | Draft the promotion issue, fold the changelog, run Tier 1, append ledger lines |
| Hotfix | Either one | Either one; B can ship without a Mac | Prepare cherry-pick PRs and rehearsals |
| Rollback repoint | Either one | Either one | Prepare the dispatch inputs |
| Merges and tag pushes | Human | Human | Never |

- **Environment.** Add maintainer B as a second required reviewer on `release`, keeping
  self-review allowed, so whoever pushes the tag can approve while the other travels. Add a
  deployment policy limiting `release` to tags `v*` and the weekly workflow's ref, so an arbitrary
  branch can at most request approval for a rehearsal.
- **Updater minisign key.** Generated once by maintainer A (done 2026-11-07). Kept in three places:
  the environment secret; an encrypted key file in A's password manager; an encrypted copy in B's
  custody, so it survives one person and one location. The password is stored separately from the
  key file. Restore drill each quarter, recorded in the ledger: decrypt the backup, sign a test
  file, verify it against the committed pubkey. Rotation is two steps: ship a build signed with
  the old key that embeds the new pubkey, and keep the old key until that build has been the latest
  stable for 8 weeks. Losing the key strands every install.
- **Apple credentials.** The Developer ID Application certificate (.p12) and the notarization
  credentials belong to maintainer A's (individual) team. Record the certificate expiry date in
  `docs/releasing.md` with a 90-day reminder. Prefer an App Store Connect API key for notarization
  over Apple ID plus app-specific password, so a password reset cannot silently break notarization
  (Q5). ASSUMPTION: Tauri accepts API-key credentials. Give B a team role if the account type
  allows (Q6).
- **Timing.** The first notarization for a new team took about 25 minutes; later runs are expected
  in minutes (ASSUMPTION). If Apple's notary service is degraded, wait rather than raise timeouts.

## 7. Rollback and incident handling

Repointing a manifest only stops further spread. It cannot recall clients that already updated, and
the plugin blocks downgrades [origin/feat/579-updater-manifests:docs/releasing.md:617]. Recovery is
always a roll-forward.

| Incident | Action (target time) | What users experience |
|---|---|---|
| Bad weekly | Repoint `latest-weekly.json` to the previous weekly with the #585 dispatch (24h, either maintainer); warning banner on the release notes; fix on master, dispatch an extra weekly | Weekly users not yet updated see nothing; updated users get the fix on their next launch check |
| Bad stable | Repoint `latest-stable.json` to the previous stable (24h); hotfix `vX.Y.Z+1` from `release/X.Y` | Same, on the stable track. If the bad build bumped the schema, re-saved files stay unreadable by older builds; the hotfix notes must say so |
| Updater broken inside build N | Cannot be fixed remotely. Ship N+1, notify collaborators directly, ask them to reinstall by hand. P4 exists to prevent this | Users stay on N until they download a new build |
| Manifest 404 or corrupt | Re-run the repoint dispatch (#579 accepts brief 404 windows) | Update checks fail quietly; no banner |
| Notarization fails or times out | The build job fails; re-run it. Nothing is published | None |
| Apple cert expired | New builds fail W4. Renew under the same team. Existing notarized builds keep launching (ASSUMPTION: the secure timestamp keeps them valid) | Possibly one keychain re-prompt for the SpeleoDB token [releasing.md:287-296] |
| Apple cert revoked | P0. New certificate, rebuild, ask users to reinstall; the updater cannot help if Gatekeeper blocks the launch | The app will not open until reinstalled |
| Minisign key lost | Rotation becomes impossible. Ship a build with a new pubkey and require every user to reinstall | One forced manual reinstall |
| Minisign key leaked | Rotate secrets, audit repo write access (an attacker also needs repo write to publish a manifest), two-step key rotation | None if caught early |

## 8. Finishing 0.5.0 and migrating to the train

**Recommendation (see the note at the top - rc6 already departs from it):** decouple 0.5.0 from
the updater. Ship 0.5.0 with Developer ID signing and notarization but without the in-app updater;
the first updater-bearing build is then a weekly that soaks before any stable carries it. Waiting
for the updater ties a release overdue since July to a new subsystem's first real-world test.

**Exit criteria for 0.5.0 stable** (all must be met):
1. Create `release/0.5` at the rc6 commit. From then on only blocker fixes are cherry-picked
   there; this ends the rc treadmill. Every later rc is cut from the branch.
2. The final `v0.5.0` points at the same SHA as the last rc.
3. That rc soaks 7 days with no new P0. A cherry-picked fix starts a 3-day re-soak.
4. Ledger lines exist for that rc SHA: journeys, scenarios and fractal-stress with `--release`; the
   macOS P5 check (notarized, so no prompt); Linux AppImage launch; a Windows install and launch.
5. `release-tag.sh v0.5.0 --dry-run` is clean, the `[0.5.0]` date is set, and the footer matches
   the signing marker. This is the last manual changelog audit.
6. Target the final tag within 3 weeks of rc6. If the criteria are not met by then, both
   maintainers decide in writing: ship with a Known Issues section, or set a new date.

**Migration**
1. **0.5.0 final.** Rewrite the RC checklist line about the macOS prompt.
2. **Updater work.** #580, #585, #586, #591 merged; minisign key generated and the restore drill
   run once; the `updater` release provisioned.
3. **Infrastructure.** PR C (weekly workflow) with the D1 fix, base = next minor, last-known-good
   SHA selection; changelog fragments and the PR check; CI trigger for `release/**`; pin the Rust
   toolchain (Q10).
4. **First weekly `0.6.0-weekly.*`.** Collaborators install it by hand once (the bootstrap). Run at
   least 3 weeklies and prove P4 on every OS.
5. **First stable 0.6.0** promoted under section 4. 0.5.0 users upgrade by hand one last time if
   their build has no updater; after that, upgrades flow through the updater.
6. **Remove rc support** from `release-tag.sh` and `docs/releasing.md`.

## 9. Checklists

**Weekly (Monday)**
- [ ] The cron chose a last-known-good SHA (W1, W2), or skipped
- [ ] No open P0 (W6); approve the environment within 48h (W7), otherwise cancel
- [ ] The run is green, including the DMG `spctl`/`stapler` checks and the `.sig` set (W3 to W5)
- [ ] `latest-weekly.json` points at the new tag
- [ ] Within 72h: update from the previous weekly on one OS, and add a ledger line

**Stable promotion (first Monday of the month)**
- [ ] Open the promotion issue (an agent drafts it) naming weekly W and its SHA
- [ ] P1 soak of at least 7 days; P2 bug query attached
- [ ] P3 ledger lines for W's SHA; P4 update-path lines; P5 macOS check by maintainer A
- [ ] P6: schema/config diff since the last stable, plus migration test and manual open if it changed
- [ ] Fold the fragments into `## [X.Y.0]` in a PR merged by a human; read the `release-tag.sh vX.Y.0 --dry-run` body
- [ ] Both maintainers tick the issue (P9)
- [ ] Tag W's SHA, push the tag, approve the environment, create `release/X.Y`
- [ ] Verify `latest-stable.json`; previous stable -> vX.Y.0 updates on one machine and gets a ledger line
- [ ] Confirm the release shows as Latest and the notes footer is correct

**Hotfix**
- [ ] Hotfix issue opened with severity and the affected stable
- [ ] Fix merged on master with a regression test (H1); cherry-pick PR into `release/X.Y` is green (H2)
- [ ] Rehearsal artifacts verified by the reporter or a maintainer; Tier 1 ledger line (H3)
- [ ] `git log` shows only the cherry-picks (H4); fragment folded into `## [X.Y.Z]`
- [ ] Tag, push, approve; check `latest-stable.json`; notify the other maintainer
- [ ] If urgent for weekly users: dispatch an extra weekly

**Rollback (any track)**
- [ ] Dispatch the repoint to the last good tag (confirm the include-darwin input from the release's signing marker or notes)
- [ ] Warning banner on the bad release's notes; incident issue opened
- [ ] Roll-forward fix scheduled (weekly or hotfix); collaborators notified if they must reinstall

## 10. Open questions (each with a recommended default)

1. **Weekly base.** Next minor or next patch (#579)? *Default: next minor.*
2. **D1 mechanism.** How does an installed weekly report its full version: an MSI-only numeric
   version, a custom comparator, or numeric weeklies? *Default: MSI-only numeric version; it blocks
   the weekly launch until proven on Windows.*
3. **Second reviewer.** Add maintainer B to the `release` environment? *Default: yes, with
   self-review allowed.*
4. **Unattended weeklies.** A separate `weekly` environment with no reviewer, restricted to the
   weekly workflow? *Default: no for the first 8 weeklies, then revisit if the approval click is a
   burden.*
5. **Notarization credentials.** Apple ID app-specific password, or App Store Connect API key?
   *Default: API key.*
6. **Apple account access.** The account is individual today; can B hold a role? *Default: document
   the single-person risk and accept it until an organization account exists.*
7. **Windows acceptance owner.** ASSUMPTION: neither maintainer has a Windows machine. *Default: a
   named collaborator with Windows signs P3 to P5 for Windows; until then, CI build plus install
   smoke only, with the Windows gap stated in the notes.*
8. **Soak length.** *Default: 7 days for stable, 3 days for a re-soak after a cherry-pick.*
9. **Stable cadence.** *Default: monthly, skipped if no weekly qualifies; never delayed for a feature.*
10. **Pin Rust.** Add `rust-toolchain.toml` so the stable rebuild matches the soaked weekly?
    *Default: yes, bumped deliberately through a PR.*
11. **Protect master.** *Default: require a PR with no required status checks, avoiding the #122
    paths-ignore deadlock [ci.yml:12]; the weekly's last-known-good SHA selection covers red commits.*
12. **Billing.** Are hosted runners actually billed for this public repo? *Default: check the billing
    page before choosing cron frequency; if free, the constraint is approval effort, not money.*
13. **Fragment tooling.** *Default: an in-repo script, no third-party changelog tool.*
14. **0.5.0 and the updater.** rc6 carries the updater. Should 0.5.0 final keep it, or revert to
    section 8's recommendation? *Default: keep it if rc6 soaks clean and an update from rc6 to a
    later build is proven on macOS before 0.5.0 is tagged.*

## Files this would touch (no changes proposed yet)

`.github/workflows/release.yml`, `.github/workflows/ci.yml`, `scripts/release-tag.sh`,
`scripts/release-notes.sh`, `docs/releasing.md`, `docs/uat/checklists/release-candidate.md`,
`CLAUDE.md` (changelog rule).
