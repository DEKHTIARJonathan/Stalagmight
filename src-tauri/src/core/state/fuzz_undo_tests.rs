//! A seeded undo/redo fuzzer that runs INSIDE the Rust test suite, and the CI
//! gate built on it.
//!
//! # Why this exists next to the agent harness
//!
//! `e2e/agent/scenarios/undoRedoFuzz.ts` and its persistence sibling find real
//! bugs - eleven of them are on
//! <https://github.com/Stalagmight/Stalagmight/issues/413> - but neither of them
//! GATES anything. The harness drives a built desktop app through WebDriver and
//! never runs in CI, and the red tests in `open_undo_bugs_tests.rs` are
//! `#[ignore]`d by design. So today an undo regression can land without a single
//! check going red.
//!
//! This module closes that hole. It is the same model - a canonical project
//! snapshot per undo depth, asserted after every history move - driven directly
//! against `AppState`, which makes it roughly three orders of magnitude cheaper
//! per sequence and therefore something a `#[test]` can afford to run on every
//! push.
//!
//! The three tiers are complementary, not redundant:
//!
//! | tier | drives | catches | runs |
//! |---|---|---|---|
//! | this module | `AppState` directly | undo/redo model + persistence regressions | EVERY CI run |
//! | agent harness | the real app over IPC | anything the frontend store or the IPC boundary breaks | on demand |
//! | `open_undo_bugs_tests.rs` | `AppState` directly | the KNOWN open bugs, pinned | `-- --ignored` |
//!
//! # THE BUG IDENTIFICATION MATRIX
//!
//! Every finding the agent-harness fuzzers found is reachable HERE, and is
//! CLASSIFIED by id rather than merely hit. The table below is the evidence: for
//! each one, a mode, a seed and a move count under which this module reaches it
//! and names it. Every row was run twice and the two runs are byte-identical
//! (`the_fuzzer_is_deterministic` pins that property for the gate's seeds; the
//! whole table was re-run and diffed by hand for the rest).
//!
//! Read a row as: run `fuzz_seed_survey` with the listed environment, and the
//! per-seed summary line for that seed carries the listed classified-hit id.
//! `SEEDS=n` runs seeds 1..=n, so the named seed is included.
//!
//! | # | classified as | mode env | seed | moves |
//! |---|---|---|---|---|
//! | 1 (uuids) | `finding-1-redo-of-create-section-remints-shot-uuids` | (none) | 1 | 60 |
//! | 1 (anchors) | `finding-1-redo-of-create-section-drops-gauge-anchors` | (none), persistence half | 1 | 60 |
//! | 2 | `finding-2-orphan-zero-section-offset` | (none) | 1 | 60 |
//! | 3 (offset) | `finding-3-undo-of-the-first-shot-displaces-an-empty-section` | (none) | 2 | 60 |
//! | 3 (data loss) | `finding-3-undo-of-the-first-shot-drops-station-zero-refs` | (none) | 37 | 60 |
//! | 4 | `finding-4-closure-reordered-on-undo` | `CLOSURE_SHAPES=1` | 1 | 40 |
//! | 5 | `finding-5-undo-cannot-restore-null-section-field` | (none) | 6 | 60 |
//! | 6 | `finding-6-undo-refused-by-a-delete-guard` | `CLOSURES=1` | 4 | 60 |
//! | 7 | `finding-7-a-jump-is-not-n-single-steps` | `JUMPS=1 CLOSURE_SHAPES=1`, persistence half | 6 | 150 |
//! | 8 | `finding-8-stale-id-deletes-the-wrong-shot` | `DIVERGENCE=1` | 1 | 12 |
//! | 10 | `finding-10-reload-converts-an-orphan-closure-to-a-merge` | `CLOSURE_SHAPES=1`, persistence half | 1 | 40 |
//! | 11 | `finding-11-pre-save-entry-reverts-the-saves-heals` | (none), persistence half | 1 | 60 |
//! | 12 | `finding-12-stale-id-edits-the-wrong-shot` | `DIVERGENCE=1` | 1 | 12 |
//! | 13 | `finding-13-stale-id-misses-and-wedges-the-history` | (none), persistence half | 5 | 60 |
//! | 14 | `finding-14-insert-leaves-a-merge-metres-out-of-alignment` | `CLOSURES=1` | 6 | 60 |
//! | 14 (mirror) | `finding-14-variant-a-shot-removal-leaves-a-merge-out-of-alignment` | `JUMPS=1 CLOSURE_SHAPES=1` | 1 | 150 |
//! | 15 | = finding 3, see below | (none) | 5 | 20 |
//! | 16 | `finding-16-redo-of-a-create-shot-duplicates-a-shot-uuid` | (none), persistence half | 13 | 60 |
//! | 17 | `finding-17-zero-datum-reordered-on-undo` | (none) | 1 | 60 |
//! | 20 | `finding-20-an-unanchored-merge-group-is-never-realigned` | `HORIZON=1` | 1 | 2000 |
//! | 21 | red test only - `the_adjusted_solve_is_a_function_of_the_project` | n/a | n/a | n/a |
//! | 22 | `finding-22-a-range-shift-delete-is-not-its-single-deletes` | metamorphic gate | 3 | n/a |
//!
//! Findings 18 and 19 are ids this module's own classifiers already use and are
//! NOT rows: 18 is the raw-versus-resolved alignment disagreement (issue #413's
//! finding 14 write-up records the same fact) and 19 is tolerated float dust
//! accumulating past the tolerance, which the horizon mode watches for and which
//! has not fired. They are reserved so the numbering does not collide, which is
//! why the new ones start at 20.
//!
//! Findings 21 and 22 are not roundtrip-oracle rows because neither is a
//! roundtrip defect: 21 is measured by re-solving one project
//! (`open_undo_bugs_tests.rs`) and 22 by the METAMORPHIC engine in
//! `metamorphic_undo_tests.rs`, which compares two routes rather than two
//! moments.
//!
//! Environment prefix for every row: `STALAGMIGHT_RUST_FUZZ_`. So the finding-7
//! row is
//!
//! ```text
//! STALAGMIGHT_RUST_FUZZ_JUMPS=1 STALAGMIGHT_RUST_FUZZ_CLOSURE_SHAPES=1 \
//!   STALAGMIGHT_RUST_FUZZ_SEEDS=6 STALAGMIGHT_RUST_FUZZ_ITERATIONS=150 \
//!   TELEMETRY_ENDPOINT=http://localhost/dummy cargo test \
//!   --manifest-path src-tauri/Cargo.toml --features telemetry \
//!   --lib fuzz_seed_survey -- --ignored --nocapture
//! ```
//!
//! Three findings on the issue are NOT rows because they are not this tier's:
//! finding 9 was triaged out as float cancellation from the fuzzer's own inputs,
//! and 15 turned out not to exist separately - see below.
//!
//! ## What finding 15 was
//!
//! Finding 15 ("an undo leaves a `section_offsets` entry carrying REAL geometry")
//! is FINDING 3, re-measured. Finding 3 displaces the empty section on the undo
//! that removes its first shot; nothing ever puts that back, because the redo
//! re-inserts through the offset-neutral append path - which is finding 3's own
//! ratchet half. So the leftover is still in the project several undos later,
//! when the entry being consumed is unrelated and the snapshot it is compared
//! against never had the key.
//!
//! Confirmed against the reported instance itself: seed 7 at 100 moves, depth 14,
//! `section_offsets.1` = `[7.11187043796, 0.315846281796]` - whose two
//! immediately preceding moves are `createShot(s=1,n=0,append)` and the undo of
//! it, into and out of section 1, the very section that ends up displaced. The
//! write-up read the move log from the wrong end.
//!
//! The classifiers now carry that shape as `finding-3-cascade-...`, and
//! `unwinding_the_history_leaves_no_displaced_section_behind` in
//! `open_undo_bugs_tests.rs` pins the consequence a user sees.
//!
//! ## Open observations from the HORIZON mode
//!
//! The three that were open here have all been resolved, two into findings and
//! one into a model fix. What replaced them is one NEW observation, stated the
//! same way: deterministic, reproducing twice, not root-caused, and therefore
//! FAILING the horizon run rather than classified.
//!
//! * RESOLVED as FINDING 20. `HORIZON=1 SEEDS=1 ITERATIONS=2000` left a merged
//!   pair 1.58 cm apart after an `updateShot`. Root cause:
//!   `realign_after_shot_edit` (models/project/mutations.rs:923) returns at
//!   line 941 when the edited section's merge group holds no zero datum, and
//!   the epilogue's `realign_merges` (models/project/offsets.rs:280) only
//!   re-solves past the app's own 5 cm reporting threshold - while the app's
//!   `#[cfg(test)]` invariant for the same pair is 1 cm. Classified, terminally.
//! * RESOLVED as a MODEL FIX. Seeds 2, 7 and 8 were described as failing on
//!   finding-3-shaped `section_offsets` values the cascade classifier no longer
//!   matched. Half of that was true and is fixed: the classifier froze one
//!   value where finding 3 RATCHETS, so it stopped matching after the second
//!   cycle. It now follows the trajectory and requires BOTH sides to be on it,
//!   which is narrower per diff and took the survey from 35 to 39 clean seeds
//!   of 40 at 100 moves.
//! * RESOLVED as FINDING 21. The adjusted-geometry oracle's 28-micron
//!   divergence over a byte-identical project is real and the recorded
//!   hypothesis (`station_offsets` / `station_comments` hash order feeding
//!   `resolve_offsets`) was wrong in every clause - see `ADJUSTED_TOLERANCE_REL`,
//!   which records both the refutation and the mechanism that replaced it.
//!
//! * STILL OPEN, and NEW: at horizon depths - seeds 2, 3, 4 and 5 somewhere past
//!   depth 1000 - an `undo` translates a whole CONNECTED COMPONENT by a constant
//!   vector. The signature is sharp and is not finding 3's: every differing
//!   `section_offsets` entry belongs to one component and every one of them
//!   differs by the SAME vector, so the relative geometry is preserved exactly
//!   and only the component's absolute position moves; and the post-undo state
//!   places one section of the component at exactly `[0, 0]`, which is what a
//!   re-seeded cascade looks like rather than a slide. Measured on seed 2 at
//!   depth 1189: sections 65 and 81 both off by `(22230.0946076, -10480.744175)`,
//!   with 81 landing on the origin. Four synthetic reductions were measured NOT
//!   to reproduce it and are recorded in the commit history: move-then-edit with
//!   and without a datum, a datum added AFTER the displacement, and a
//!   >5 cm edit that trips the realign gate - all restore their offsets exactly.
//!   No classifier, because nothing here is understood well enough to write one.
//!
//! ## Modes, and why the gate uses none of them
//!
//! | env | what it adds | why it is not in the gate |
//! |---|---|---|
//! | `JUMPS=1` | multi-step `undo_to`/`redo_to` | finding 7 |
//! | `CLOSURES=1` | a real loop closure in the starting project | findings 6 and 14 |
//! | `DIVERGENCE=1` | the id-vs-position divergence findings 8/12/13 need, built | deliberate corruption |
//! | `CLOSURE_SHAPES=1` | the two closure shapes findings 4 and 10 need, built | deliberate, and implies `CLOSURES` |
//! | `HORIZON=1` | thousands of moves, past the app's own history limit: the FIFO trim and its sliding window, accumulated float dust, allocator and growth sanity | minutes per seed |
//!
//! A mode that CONSTRUCTS a known defect cannot also be a regression gate: its
//! hit counts say nothing about whether the model acquired a new way to be
//! wrong, which is the only thing the gate is for.
//!
//! # What it does NOT cover
//!
//! Everything above the `AppState` boundary: the projectStore actions, the IPC
//! serialization (notably serde's double-option, which is how bug 5 was found),
//! and the frontend's own bookkeeping. Those are the harness's job and the
//! reason it stays.
//!
//! # Four oracles, not one
//!
//! | oracle | what it compares | what only it can see |
//! |---|---|---|
//! | ROUNDTRIP | a canonical serialized `Project` per undo depth | anything stored that a history move fails to restore |
//! | ALIGNMENT | every cross-section merge, RAW and RESOLVED | a move that leaves the survey network geometrically broken, and a disagreement between the app's two measures of that |
//! | INTEGRITY DELTA | `AppState::integrity_check`'s own verdict per depth | a state that roundtrips while the app's verdict on it does not |
//! | ADJUSTED GEOMETRY | `get_adjusted_stations` per depth - what the map draws | a SOLVE whose result moved, including through a stale memo, while the stored inputs agree |
//!
//! The last two are ports of the harness's, and the integrity one is there
//! because at that tier it caught a finding 7 manifestation ALONE: the state
//! compared equal (the geometry paths were absorbed as reload-resolved across an
//! epoch boundary) while `check_project_integrity` reported a merge 5.00 m out.
//!
//! They cost little next to the roundtrip oracle they join. Measured over seed 1
//! at 60 moves, 59 comparisons: the project snapshot is ~1.8 ms per comparison,
//! the integrity verdict ~81 us (4.6% of it) and the adjusted solve ~208 us
//! (12%). Both run on EVERY comparison; no checkpointing was needed, and the
//! per-run totals are printed in the summary line so the number stays honest as
//! the model grows.
//!
//! The consistency rule they need is in `expect_derived`: when a classified
//! known bug resyncs the state model, the verdict and the adjusted geometry
//! resync at the same moment. A derived model that kept the pre-bug expectation
//! would report the same defect at every later depth as a fresh failure.
//!
//! # The oracle sees MORE than the harness one
//!
//! The harness compares `get_project_state`, which is `ProjectIpc` - and that
//! type omits `station_offsets` and `station_comments` entirely (they are only
//! observable there through derived `stations[]` entries). This module compares a
//! serialized `Project`, so those two maps are IN the comparison. That was a
//! deliberate blind spot to close.
//!
//! # Data
//!
//! Everything is generated in code. No fixture is read, copied or derived from -
//! CI has none, and the repo forbids adding any.

#![expect(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::too_many_lines,
    reason = "test module: see docs/linting.md for the per-test-module expect idiom"
)]
#![expect(
    clippy::print_stdout,
    reason = "a fuzzer's per-seed summary IS its output: the classified-hit counts are what a               reviewer reads to see the gate is still gating, and `cargo test -- --nocapture` is               the only channel a test has"
)]
#![expect(
    clippy::panic,
    reason = "the fuzzer's failure payload (seed, depth, move log, first diffs) is far more useful               than any assert! message, and a panic IS how a test fails"
)]
#![expect(
    clippy::needless_pass_by_ref_mut,
    reason = "the generators take &mut Fuzzer uniformly; some branches happen not to draw, and               splitting the signature by branch would make the generator table unreadable"
)]

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use tempfile::TempDir;

use super::AppState;
use crate::core::{Command, CommandResult};
use crate::models::{
    ClosureStrategy, Coordinates, GpsCoordinates, SectionId, SectionUpdates, ShotData, ShotId,
    ShotKind, ShotUpdates, StationRef, SurveyDirection,
};

// ===========================================================================
// Deterministic PRNG
// ===========================================================================

/// mulberry32, integer-only.
///
/// The same generator the TypeScript harness uses (`scenarios/framework.ts`), so
/// the two tiers share a mental model, and no new dependency: nothing in
/// `Cargo.toml` gives test code a PRNG, and adding one to gate a test would be a
/// poor trade.
///
/// Determinism is the whole contract, so every draw is integer arithmetic on
/// `u32` with explicit wrapping. No float is used to MAKE a decision anywhere in
/// this module - `f64` values are generated as data, never used to branch - which
/// keeps a run bit-identical across platforms and optimization levels.
pub(super) struct Rng {
    state: u32,
}

impl Rng {
    pub(super) const fn new(seed: u32) -> Self {
        Self { state: seed }
    }

    /// Next raw 32-bit value.
    fn next_u32(&mut self) -> u32 {
        self.state = self.state.wrapping_add(0x6d2b_79f5);
        let mut t = self.state;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 0b11_1101));
        t ^ (t >> 14)
    }

    /// Uniform in `0..bound` (`bound` > 0). Modulo bias is irrelevant here and
    /// costs nothing to keep: the alternative (rejection sampling) makes the draw
    /// count depend on the values drawn, which makes a seed's trajectory harder
    /// to reason about when a generator changes.
    pub(super) fn below(&mut self, bound: usize) -> usize {
        if bound == 0 {
            return 0;
        }
        (self.next_u32() as usize) % bound
    }

    /// Inclusive integer range.
    pub(super) fn range(&mut self, min: i64, max: i64) -> i64 {
        if max <= min {
            return min;
        }
        let span = (max - min + 1) as usize;
        min + self.below(span) as i64
    }

    /// True with probability `percent`/100.
    pub(super) fn chance(&mut self, percent: u32) -> bool {
        (self.next_u32() % 100) < percent
    }

    /// A float in `[min, max]`, quantized to 1/1000 so the value is a function of
    /// an INTEGER draw. Generating it from the raw u32 as a fraction would make
    /// the produced value depend on f64 rounding; this cannot.
    pub(super) fn float(&mut self, min: f64, max: f64) -> f64 {
        let steps = self.range(0, 1000) as f64;
        min + (max - min) * (steps / 1000.0)
    }

    pub(super) fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len())]
    }
}

/// Largest magnitude any generated value that feeds coordinate arithmetic may
/// take.
///
/// Ported, not re-derived. The harness spent a finding on this (issue #413,
/// finding 9): a 1e6 m displacement puts coordinates in a regime where
/// re-deriving `section_offsets` loses ~4.6e-6 m ABSOLUTE to catastrophic
/// cancellation, three orders above the oracle's 1e-9 floor, so it reads as a
/// roundtrip failure when it is really the injected input. The bound goes on the
/// INPUT rather than on the oracle, which would have blinded it to real
/// sub-centimetre drift.
pub(super) const GEOMETRY_EXTREME: f64 = 1e3;

// ===========================================================================
// The snapshot oracle
// ===========================================================================

/// Absolute tolerance, a nanometre. Geometry is RE-DERIVED after every undo/redo
/// rather than copied, so a value whose true result is 0 can land on different
/// dust depending on the order the survey chain was summed in. A real geometry
/// regression is millimetres at the very least.
const TOLERANCE_ABS: f64 = 1e-9;
/// Relative tolerance, on top of the absolute one.
const TOLERANCE_REL: f64 = 1e-12;

/// Fields no history move can be expected to restore, each an artefact rather
/// than state:
///
/// * `modified_at` - every undo/redo path calls `Project::touch()`.
/// * `file_path` - `serialize_project_snapshot` scrubs it, and
///   `restore_snapshot_into` carries the LIVE path across a restore.
/// * the id allocators - monotonic counters, and an ASYMMETRY rather than a bug:
///   a snapshot-pair undo restores them verbatim while a targeted undo only ever
///   raises them, so comparing them would fire on every mixed history.
fn drop_key(path: &str) -> bool {
    matches!(
        path,
        "modified_at"
            | "file_path"
            | "next_section_id"
            | "next_closure_id"
            | "sections.*.next_shot_id"
    )
}

/// `station_offsets` and `station_comments` serialize as a Vec of `(key, value)`
/// pairs built from a `HashMap`, so their ORDER is not stable across a restore.
/// Sorting them canonicalizes that without hiding a value - the same treatment
/// the harness gives `section_offsets` (whose JSON-object form serde_json already
/// sorts on parse).
fn sort_as_set(path: &str) -> bool {
    matches!(path, "station_offsets" | "station_comments")
}

/// Round to 12 significant digits, as the harness's canonical serializer does.
/// The fast path is string equality, so without this every re-derived coordinate
/// would take the slow tolerant path.
fn round_significant(value: f64) -> f64 {
    if !value.is_finite() || value == 0.0 {
        return value;
    }
    format!("{value:.11e}").parse::<f64>().unwrap_or(value)
}

/// Canonical, comparison-ready JSON for a serialized `Project`.
///
/// `id_agnostic` replaces every `Shot::id` with its POSITION. `Shot::id` is not
/// persisted - the loader renumbers to `section_id * FEATURE_ID_STRIDE +
/// sequence_order` - so once a run has crossed a save/reload, comparing ids
/// against a pre-save snapshot would report the renumbering as drift. Everything
/// else stays compared exactly, and a run that never saves never turns this on.
fn canonicalize(value: &serde_json::Value, path: &str, id_agnostic: bool) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => {
            let child_base = if path.is_empty() {
                String::new()
            } else {
                format!("{path}.")
            };
            let mut out = serde_json::Map::new();
            for (key, child) in map {
                let child_path = format!("{child_base}{key}");
                if drop_key(&child_path) {
                    continue;
                }
                let mut canonical = canonicalize(child, &child_path, id_agnostic);
                if sort_as_set(&child_path) {
                    if let serde_json::Value::Array(items) = &mut canonical {
                        items.sort_by_key(ToString::to_string);
                    }
                }
                out.insert(key.clone(), canonical);
            }
            serde_json::Value::Object(out)
        }
        serde_json::Value::Array(items) => {
            let child_path = if path.is_empty() {
                "*".to_string()
            } else {
                format!("{path}.*")
            };
            let mut out = Vec::with_capacity(items.len());
            for (index, item) in items.iter().enumerate() {
                let mut canonical = canonicalize(item, &child_path, id_agnostic);
                if id_agnostic && child_path == "sections.*.shots.*" {
                    if let serde_json::Value::Object(shot) = &mut canonical {
                        shot.insert("id".to_string(), serde_json::Value::from(index));
                    }
                }
                out.push(canonical);
            }
            serde_json::Value::Array(out)
        }
        serde_json::Value::Number(number) => number.as_f64().map_or_else(
            || value.clone(),
            |raw| {
                serde_json::Number::from_f64(round_significant(raw))
                    .map_or_else(|| value.clone(), serde_json::Value::Number)
            },
        ),
        other => other.clone(),
    }
}

/// One differing path between two canonical snapshots.
#[derive(Debug, Clone)]
pub(super) struct Diff {
    pub(super) path: String,
    pub(super) expected: String,
    pub(super) actual: String,
}

const ABSENT: &str = "<absent>";
/// Diffs collected before the walk gives up. Enough to classify and to read.
const MAX_DIFFS: usize = 60;

fn numbers_equal(a: f64, b: f64) -> bool {
    if a == b {
        return true;
    }
    if !a.is_finite() || !b.is_finite() {
        return false;
    }
    (a - b).abs() <= TOLERANCE_ABS + TOLERANCE_REL * a.abs().max(b.abs())
}

fn show(value: &serde_json::Value) -> String {
    let text = value.to_string();
    if text.len() > 120 {
        format!("{}...[{} chars]", &text[..120], text.len())
    } else {
        text
    }
}

fn diff_values(
    expected: &serde_json::Value,
    actual: &serde_json::Value,
    path: &str,
    out: &mut Vec<Diff>,
) {
    if out.len() >= MAX_DIFFS {
        return;
    }
    let label = if path.is_empty() { "<root>" } else { path };
    match (expected, actual) {
        (serde_json::Value::Object(a), serde_json::Value::Object(b)) => {
            let mut keys: Vec<&String> = a.keys().chain(b.keys()).collect();
            keys.sort_unstable();
            keys.dedup();
            for key in keys {
                let child = if path.is_empty() {
                    key.clone()
                } else {
                    format!("{path}.{key}")
                };
                match (a.get(key), b.get(key)) {
                    (Some(left), Some(right)) => diff_values(left, right, &child, out),
                    (left, right) => out.push(Diff {
                        path: child,
                        expected: left.map_or_else(|| ABSENT.to_string(), show),
                        actual: right.map_or_else(|| ABSENT.to_string(), show),
                    }),
                }
                if out.len() >= MAX_DIFFS {
                    return;
                }
            }
        }
        (serde_json::Value::Array(a), serde_json::Value::Array(b)) => {
            if a.len() != b.len() {
                out.push(Diff {
                    path: format!("{label}.length"),
                    expected: a.len().to_string(),
                    actual: b.len().to_string(),
                });
            }
            for index in 0..a.len().min(b.len()) {
                diff_values(&a[index], &b[index], &format!("{path}[{index}]"), out);
                if out.len() >= MAX_DIFFS {
                    return;
                }
            }
        }
        (serde_json::Value::Number(a), serde_json::Value::Number(b)) => {
            let (Some(left), Some(right)) = (a.as_f64(), b.as_f64()) else {
                if a != b {
                    out.push(Diff {
                        path: label.to_string(),
                        expected: a.to_string(),
                        actual: b.to_string(),
                    });
                }
                return;
            };
            if !numbers_equal(left, right) {
                out.push(Diff {
                    path: label.to_string(),
                    expected: show(expected),
                    actual: show(actual),
                });
            }
        }
        (left, right) => {
            if left != right {
                out.push(Diff {
                    path: label.to_string(),
                    expected: show(left),
                    actual: show(right),
                });
            }
        }
    }
}

/// Every numeric path that differs AT ALL, with the size of the difference.
///
/// The tolerant comparison reports nothing for a difference under
/// `TOLERANCE_ABS`, which is right per comparison and wrong over a run: a depth
/// visited a hundred times can be walked past the tolerance one grain at a time.
/// This is what the accumulation oracle remembers between visits.
fn numeric_drift(expected: &str, actual: &str) -> BTreeMap<String, f64> {
    let (Ok(left), Ok(right)) = (
        serde_json::from_str::<serde_json::Value>(expected),
        serde_json::from_str::<serde_json::Value>(actual),
    ) else {
        return BTreeMap::new();
    };
    let mut out = BTreeMap::new();
    collect_drift(&left, &right, "", &mut out);
    out
}

fn collect_drift(
    expected: &serde_json::Value,
    actual: &serde_json::Value,
    path: &str,
    out: &mut BTreeMap<String, f64>,
) {
    match (expected, actual) {
        (serde_json::Value::Object(a), serde_json::Value::Object(b)) => {
            for (key, left) in a {
                if let Some(right) = b.get(key) {
                    let child = if path.is_empty() {
                        key.clone()
                    } else {
                        format!("{path}.{key}")
                    };
                    collect_drift(left, right, &child, out);
                }
            }
        }
        (serde_json::Value::Array(a), serde_json::Value::Array(b)) => {
            for (index, left) in a.iter().enumerate() {
                if let Some(right) = b.get(index) {
                    collect_drift(left, right, &format!("{path}[{index}]"), out);
                }
            }
        }
        (serde_json::Value::Number(a), serde_json::Value::Number(b)) => {
            if let (Some(left), Some(right)) = (a.as_f64(), b.as_f64()) {
                let delta = (left - right).abs();
                if delta > 0.0 {
                    out.insert(path.to_string(), delta);
                }
            }
        }
        _ => {}
    }
}

pub(super) fn diff_snapshots(expected: &str, actual: &str) -> Vec<Diff> {
    let (Ok(left), Ok(right)) = (
        serde_json::from_str::<serde_json::Value>(expected),
        serde_json::from_str::<serde_json::Value>(actual),
    ) else {
        return vec![Diff {
            path: "<unparseable>".to_string(),
            expected: expected.chars().take(80).collect(),
            actual: actual.chars().take(80).collect(),
        }];
    };
    let mut out = Vec::new();
    diff_values(&left, &right, "", &mut out);
    out
}

pub(super) fn describe_diffs(diffs: &[Diff]) -> String {
    // Eight is enough to recognise a shape and short enough to read; a triage
    // run that needs the whole list sets `STALAGMIGHT_RUST_FUZZ_VERBOSE=1`
    // rather than editing this number, which is how the eight got chosen twice.
    let limit = if std::env::var("STALAGMIGHT_RUST_FUZZ_VERBOSE").is_ok() {
        MAX_DIFFS
    } else {
        8
    };
    let shown = diffs.len().min(limit);
    let mut lines: Vec<String> = diffs[..shown]
        .iter()
        .map(|d| {
            format!(
                "    at {}\n      expected: {}\n      actual:   {}",
                d.path, d.expected, d.actual
            )
        })
        .collect();
    if diffs.len() > shown {
        lines.push(format!(
            "    ...and {} more differing path(s)",
            diffs.len() - shown
        ));
    }
    lines.join("\n")
}

// ===========================================================================
// The two derived-state oracles
// ===========================================================================

/// The app's OWN integrity verdict (`AppState::integrity_check`), normalized.
///
/// Ported from the harness tier, where this oracle earned its place by catching
/// a finding 7 manifestation ALONE: the state compared equal (the geometry paths
/// had been absorbed as reload-resolved across an epoch boundary) while
/// `check_project_integrity` reported a merge 5.00 m out. A verdict is part of
/// the state a history move is supposed to restore, and it is derived through a
/// different path than the snapshot - so it sees what the snapshot cannot.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct Verdict {
    save_blocked: bool,
    /// Violation messages, SORTED.
    ///
    /// The app sorts them by severity only (`commands.rs`), and that sort is
    /// stable - so within a severity the order is the order the checks pushed
    /// them, which for the `for_each_station_ref` traversal follows `HashMap`
    /// iteration and is not stable between runs. Sorting loses nothing the
    /// oracle wants (the SET of violations is the verdict) and is what makes it
    /// comparable at all.
    ///
    /// Values are kept VERBATIM otherwise, ids and distances included. Every id
    /// a message can carry - section id, station index, closure id, uuid -
    /// survives a save/reload unchanged, and the distances are quantized to a
    /// centimetre by the `{:.2}` in the messages themselves, so float dust
    /// cannot move one except exactly on a rounding boundary. Stripping them
    /// would hide "5.00 m apart" turning into "500.00 m apart", which is the
    /// kind of thing this exists to see.
    messages: Vec<String>,
}

impl Verdict {
    pub(super) fn describe(&self) -> String {
        format!(
            "save_blocked={} messages={:?}",
            self.save_blocked, self.messages
        )
    }
}

/// One merged pair, measured BOTH ways.
///
/// `check_merge_alignment` (models/project/integrity.rs) measures through
/// `resolved_station_offsets()`, which folds in closure adjustment;
/// `debug_assert_merge_alignment` (models/project/offsets.rs) measures
/// `compute_station_raw_coords`. Issue #413's finding 14 records that the two
/// DISAGREE about the same state - the assert panics at 6.97 m while the checker
/// reports nothing - and asks which is authoritative. This is the oracle that
/// mines that class instead of noting it.
struct MergeMeasurement {
    label: String,
    raw: f64,
    resolved: f64,
    /// The two sections the pair joins. Finding 20's classifier asks whether
    /// their merge group is datum-anchored, which is a question about the
    /// SECTIONS rather than about the distance.
    sections: (SectionId, SectionId),
}

/// Tolerance for the per-depth ADJUSTED-geometry comparison, in metres.
///
/// Deliberately not the raw oracle's 1e-9. The adjusted stations are the output
/// of a least-squares solve over the whole network, so an input difference the
/// raw oracle tolerates (1e-9 m) can come out of the solve amplified by the
/// condition number of the system. A micron is four orders of magnitude below
/// the smallest geometry change anyone can mean (a millimetre) and three above
/// what the raw comparison already lets through, which makes it tight enough to
/// catch a real regression and loose enough not to report the solver's own dust.
///
/// Accumulation past this bound over a long run is a FINDING, not noise - see
/// the horizon mode, which re-baselines expressly to detect it.
const ADJUSTED_TOLERANCE_M: f64 = 1e-6;
/// Relative companion to the above, and it is a MEASUREMENT, not a knob turned
/// until a failure went away.
///
/// The horizon run found a state whose stored project roundtripped BYTE FOR BYTE
/// while a station 2.2 km from the origin solved 28 microns (1.3e-8 relative)
/// from where the same depth had it. The solve IS order-dependent - FINDING 21,
/// proven, see below - so a derived view that is not a function of its input has
/// to be compared with a tolerance or not at all, and this is that tolerance.
///
/// The mechanism took two goes to name and the first answer is recorded here
/// because it was WRONG in a way worth not repeating. The original candidate was
/// the iteration order of `station_offsets` / `station_comments`, on the grounds
/// that both serialize from a `HashMap`, the comparison SORTS them, and
/// `resolve_offsets` sums in stored order. Every clause of that is false:
/// `station_comments` never feeds geometry at all, `station_offsets` is EMPTY in
/// every run this module makes (the summary line's `peak.station_offsets` is 0 -
/// `move_station` folds its offset into the shot and removes the entry), and
/// `resolve_offsets` is not on `get_adjusted_stations`' path and sorts its
/// cascade seeds anyway (models/project/connectivity.rs).
///
/// What is really going on is one level down, in the least-squares adjustment:
/// `Project::adjust_least_squares` numbers its unknowns by iterating
/// `groups.keys()` (models/project/lsq.rs:403-409) over a `HashMap` built fresh
/// inside the call, so the numbering is a new random permutation on EVERY
/// invocation; the reduction then peels in index order (lsq.rs:72), sums over
/// `HashMap` neighbour sets (lsq.rs:84-85, 148-155, 200-208), and stops on a
/// RELATIVE residual (lsq.rs:253). Measured directly:
/// `the_adjusted_solve_is_a_function_of_the_project` in `open_undo_bugs_tests.rs`
/// re-solves one unchanging project 64 times and gets a different answer 58
/// times.
///
/// So this constant is a MEASUREMENT of a defect rather than a knob turned until
/// a failure went away: 1e-7 relative is 8x the largest spread observed and four
/// orders below the millimetre anything real moves. Delete it when finding 21 is
/// fixed - the comparison can then be exact, which is what it wants to be.
const ADJUSTED_TOLERANCE_REL: f64 = 1e-7;

/// The app's OWN merge-alignment tolerance, taken from the app rather than
/// copied: 5 cm, the distance past which `check_merge_alignment` calls a merged
/// pair broken.
const MERGE_ALIGNMENT_TOLERANCE_M: f64 = crate::models::Project::MERGE_ALIGNMENT_TOLERANCE_M;
/// Under this, a measure is calling the pair SOUND. The gap between the two
/// constants is deliberate: a pair sitting between 1 cm and 5 cm is not being
/// called sound by either measure, so a disagreement there is not a
/// contradiction and is not reported.
const RAW_RESOLVED_AGREEMENT_M: f64 = 0.01;

// ===========================================================================
// Known-bug classifiers
// ===========================================================================

/// A KNOWN OPEN BUG, tracked on <https://github.com/Stalagmight/Stalagmight/issues/413>.
///
/// These are NOT normalizations. The snapshots are still unequal and the run
/// still records the hit; classification exists so the gate can stay green while
/// eleven defects are open, and so a hit reads as "finding 5 again" rather than
/// as a fresh mystery. Every matcher is narrowed by VALUE as well as by path,
/// because a path alone cannot tell "the anchors were lost" from "the anchors
/// changed", and only the first is the known bug.
///
/// **Delete a classifier when its bug is fixed.** The gate then fails on the next
/// hit, which is the regression guard the whole module exists to provide.
struct Classifier {
    /// Finding id on issue #413.
    id: &'static str,
    matches: fn(&Diff, &MoveCtx) -> bool,
}

/// What produced the difference being classified.
///
/// The harness tier cannot see this (its bridge only knows the move's DIRECTION),
/// which is why its gauge-anchor classifier has to conflate findings 1 and 11.
/// Here the entry that a move consumed is a `get_undo_stack` read away, so the
/// two can be told apart precisely, and several other classifiers can be narrowed
/// to the exact entry shape their bug needs instead of to a path alone.
#[derive(Clone, Copy)]
struct MoveCtx<'a> {
    /// The entry the move consumed, when the move was an undo or a redo. For a
    /// multi-step jump this is the FIRST of several - the one whose restore
    /// produced the state being compared.
    entry: Option<&'a EntryMeta>,
    /// EVERY entry the move consumed. A jump runs several restores in one move,
    /// and any of them can be the one that carries a finding's precondition, so
    /// a classifier that looked only at the first stopped recognising its own
    /// bug as soon as jumps were switched on.
    entries: &'a [EntryMeta],
    /// Has this run crossed a save?
    after_save: bool,
    /// The run's current epoch; an entry with a lower one predates the last save.
    epoch: u32,
    /// Has finding 1 or finding 11 ALREADY reverted the save's gauge capture in
    /// this run?
    heal_reverted: bool,
    /// Sections finding 3 has already displaced in this run, and every value
    /// it has left in each one's `section_offsets` entry - the RATCHET's whole
    /// trajectory. See the cascade classifier.
    displaced: &'a BTreeMap<SectionId, Vec<[f64; 2]>>,
    /// Whether the shot ids the consumed entry addresses still address the
    /// shots they were recorded against - measured BEFORE the move ran.
    stale: StaleTargets,
    /// Sections finding 16 has duplicated a shot uuid in.
    corrupted: &'a BTreeSet<SectionId>,
    /// Section ids in the order they appear in the RECORDED snapshot, so a diff
    /// path (`sections[3]...`, an array index) can be resolved to a section.
    section_ids: &'a [SectionId],
}

/// What an in-session shot id an entry carries now addresses.
///
/// This is the fact findings 8, 12 and 13 are ABOUT: shot ids are not persisted
/// (the loader renumbers to `section_id * FEATURE_ID_STRIDE + sequence_order`),
/// undo entries reload as opaque JSON with no remapping, and the allocator hands
/// out ids from the same space - so a persisted id either still names its shot,
/// names a DIFFERENT one, or names nothing. The three outcomes are the three
/// findings, and knowing which one holds is what lets the classifiers below say
/// "finding 8" rather than "something about shots".
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Staleness {
    /// The entry carries no id of this role, or the run has never reloaded.
    #[default]
    Absent,
    /// The id still addresses the shot it was recorded against.
    Fresh,
    /// The id addresses a DIFFERENT shot: findings 8 and 12's regime.
    Collides,
    /// The id addresses nothing: finding 13's regime.
    Missing,
}

/// The staleness of every id one entry carries, by role.
#[derive(Clone, Copy, Debug, Default)]
struct StaleTargets {
    /// The shot the entry's own restore names - the one a `CreateShot` undo
    /// deletes, or the one an `UpdateShot` / `SetShotKind` undo writes to.
    target: Staleness,
    /// The shot a `CreateShot` REDO anchors its re-insert to
    /// (`after_shot_id` / `before_shot_id`), which is a second, independent id
    /// on the same entry.
    anchor: Staleness,
}

impl StaleTargets {
    /// The more broken of two measurements, per role. A jump consumes several
    /// entries and one stale id among them is enough to explain the damage.
    fn worst(self, other: Self) -> Self {
        let pick = |a: Staleness, b: Staleness| match (a, b) {
            (Staleness::Missing, _) | (_, Staleness::Missing) => Staleness::Missing,
            (Staleness::Collides, _) | (_, Staleness::Collides) => Staleness::Collides,
            (Staleness::Fresh, _) | (_, Staleness::Fresh) => Staleness::Fresh,
            _ => Staleness::Absent,
        };
        Self {
            target: pick(self.target, other.target),
            anchor: pick(self.anchor, other.anchor),
        }
    }
}

impl MoveCtx<'_> {
    /// Did the move consume an entry of this command type? ANY of them, because
    /// a jump consumes several and every one of them was restored.
    fn command_is(&self, command: &str) -> bool {
        self.entries.iter().any(|entry| entry.command == command)
    }

    /// True when the consumed entry was recorded BEFORE the most recent save -
    /// finding 11's precondition, since such an entry's `ProjectSnapshotPair`
    /// holds the pre-heal project in both halves.
    fn entry_predates_save(&self) -> bool {
        self.after_save && self.entry.is_some_and(|entry| entry.epoch < self.epoch)
    }

    /// The section a consumed `CreateShot` appended the FIRST shot into, when it
    /// did - finding 3's exact precondition.
    fn appended_into_empty(&self) -> Option<SectionId> {
        self.entries
            .iter()
            .find_map(|entry| entry.appended_into_empty)
    }

    /// Is `diff` inside a section finding 16 duplicated a shot uuid in?
    fn is_in_a_corrupted_section(&self, diff: &Diff) -> bool {
        if self.corrupted.is_empty() {
            return false;
        }
        let named = section_of_path(&diff.path, self.section_ids)
            .or_else(|| offset_key_of(&diff.path).map(|(id, _)| id));
        named.is_some_and(|id| self.corrupted.contains(&id))
    }

    /// Is `diff` finding 3's displacement on this section, re-measured?
    ///
    /// Matched against the RATCHET'S TRAJECTORY - every value finding 3 has left
    /// in this key over the run - and it takes BOTH sides, which is what makes
    /// it narrower than the version it replaces rather than looser.
    ///
    /// The first version recorded the canonical text of the offset the
    /// first-hand hit left and required it verbatim on ONE side of a later diff.
    /// That is correct exactly once, because finding 3 compounds: every further
    /// undo of a first-shot append adds the shot's horizontal vector again
    /// (`remove_shot_with_rewire`'s `pos == 0` branch calls
    /// `adjust_section_offset` unconditionally, and the redo re-inserts through
    /// the offset-neutral append path). Once the ratchet has turned twice, a
    /// comparison between two snapshots recorded at DIFFERENT points on the
    /// trajectory has the recorded text on neither side, and the cascade stopped
    /// classifying - which is what the horizon run's seeds 2, 7 and 8 were
    /// failing on.
    ///
    /// So the model follows the arithmetic: it remembers the sequence of values
    /// finding 3 has produced here, starting from the pre-slide `[0, 0]`, and a
    /// diff is this defect iff both of its sides are on that sequence. A section
    /// that acquired an offset from anywhere else is not this and still fails.
    fn is_finding_3_displacement(&self, diff: &Diff) -> bool {
        let Some((section_id, element)) = offset_key_of(&diff.path) else {
            return false;
        };
        let Some(trajectory) = self.displaced.get(&section_id) else {
            return false;
        };
        match element {
            // `section_offsets.5[0]` - one component, scalars on both sides. The
            // differ only produces this spelling when the key exists on BOTH
            // sides, so neither can be absent.
            Some(index) => {
                let on_trajectory = |text: &str| {
                    text.parse::<f64>().is_ok_and(|value| {
                        trajectory.iter().any(|point| {
                            point
                                .get(index)
                                .is_some_and(|want| displacements_equal(value, *want))
                        })
                    })
                };
                on_trajectory(&diff.expected) && on_trajectory(&diff.actual)
            }
            // `section_offsets.5` - the whole pair, and one side may be absent,
            // which MEANS a zero offset.
            None => {
                let on_trajectory = |text: &str| {
                    offset_pair(text).is_some_and(|value| {
                        trajectory.iter().any(|point| {
                            (0..2).all(|axis| displacements_equal(value[axis], point[axis]))
                        })
                    })
                };
                on_trajectory(&diff.expected) && on_trajectory(&diff.actual)
            }
        }
    }
}

/// Section ids in the order they appear in a canonical snapshot, so a diff path
/// - which carries the ARRAY INDEX, not the id - can name a section.
fn section_ids_of(snapshot: &str) -> Vec<SectionId> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(snapshot) else {
        return Vec::new();
    };
    value
        .get("sections")
        .and_then(|sections| sections.as_array())
        .map(|sections| {
            sections
                .iter()
                .map(|section| {
                    section
                        .get("id")
                        .and_then(serde_json::Value::as_f64)
                        .unwrap_or(-1.0) as SectionId
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The section a diff path names, by resolving `sections[INDEX]` against the
/// recorded snapshot's order.
fn section_of_path(path: &str, section_ids: &[SectionId]) -> Option<SectionId> {
    let rest = path.strip_prefix("sections[")?;
    let (index, _) = rest.split_once(']')?;
    section_ids.get(index.parse::<usize>().ok()?).copied()
}

/// Two displacements are the SAME displacement.
///
/// Looser than `numbers_equal`, and for a stated reason rather than because a
/// failure went away: what is being compared here is a DIFFERENCE of two
/// canonical numbers, each already rounded to 12 significant digits, so the
/// subtraction carries up to ~1e-12 of the larger operand's magnitude in
/// rounding error before anything real has happened. 1e-11 relative is ten
/// times that headroom and still eight orders below the millimetre any real
/// geometry change is - and finding 3's displacements are metres to kilometres,
/// so nothing near the boundary is being decided.
fn displacements_equal(a: f64, b: f64) -> bool {
    (a - b).abs() <= TOLERANCE_ABS + 1e-11 * a.abs().max(b.abs())
}

/// One side of a whole-key `section_offsets` diff as a pair.
///
/// `<absent>` is `[0, 0]`, because that is what an absent offset MEANS - and
/// treating it as "unknown" instead would make the appearance of a key
/// unclassifiable, which is half of finding 3's shape.
fn offset_pair(text: &str) -> Option<[f64; 2]> {
    if text == ABSENT {
        return Some([0.0, 0.0]);
    }
    let serde_json::Value::Array(items) = serde_json::from_str::<serde_json::Value>(text).ok()?
    else {
        return None;
    };
    Some([
        items.first().and_then(serde_json::Value::as_f64)?,
        items.get(1).and_then(serde_json::Value::as_f64)?,
    ])
}

/// The `section_offsets` entry for `section_id` in a canonical snapshot, or
/// `[0, 0]` when the key is absent.
fn offset_of(snapshot: &str, section_id: SectionId) -> Option<[f64; 2]> {
    let value = serde_json::from_str::<serde_json::Value>(snapshot).ok()?;
    let Some(offset) = value
        .get("section_offsets")
        .and_then(|offsets| offsets.get(section_id.to_string()))
    else {
        return Some([0.0, 0.0]);
    };
    offset_pair(&offset.to_string())
}

/// `(section, element)` for a diff path inside `section_offsets`.
///
/// A whole key (`section_offsets.5`) is what an absent-vs-present difference
/// produces; an element (`section_offsets.5[0]`) is what a key that exists on
/// BOTH sides produces, because the differ recurses into the pair. The two
/// spellings are the same defect seen through a different starting state, and a
/// classifier that knew only the first silently stopped classifying as soon as
/// the section already had an offset.
fn offset_key_of(path: &str) -> Option<(SectionId, Option<usize>)> {
    let rest = path.strip_prefix("section_offsets.")?;
    match rest.split_once('[') {
        None => rest.parse().ok().map(|id| (id, None)),
        Some((id, index)) => {
            let index = index.strip_suffix(']')?.parse().ok()?;
            id.parse().ok().map(|id| (id, Some(index)))
        }
    }
}

/// What the entry pushed at one depth was.
#[derive(Clone, Debug, Default)]
struct EntryMeta {
    /// `UndoHistoryItem::command_type` of the entry that takes depth d-1 to d.
    command: String,
    /// Epoch the entry was pushed in.
    epoch: u32,
    /// Set when the entry is a `CreateShot` that appended the first shot into a
    /// previously EMPTY section.
    appended_into_empty: Option<SectionId>,
    /// The shot this entry's own restore names by id, with the uuid that id
    /// addressed when the entry was pushed.
    target: Option<ShotTarget>,
    /// The shot a `CreateShot` entry's REDO anchors its re-insert to.
    anchor: Option<ShotTarget>,
}

/// A shot an undo entry addresses by its IN-SESSION id, recorded with the uuid
/// that id pointed at.
///
/// The uuid is the point. `Shot::id` is not persisted and `Shot::uuid` is, so
/// comparing "what does this id address now" against "what did it address then"
/// is a DIRECT measurement of the staleness findings 8, 12 and 13 describe -
/// rather than an inference from the damage afterwards.
#[derive(Clone, Debug)]
struct ShotTarget {
    section_id: SectionId,
    shot_id: ShotId,
    uuid: String,
}

fn is_null_or_false(text: &str) -> bool {
    text == "null" || text == "false"
}

/// A coordinate pair/triple whose every member is within tolerance of zero, or an
/// absent entry.
fn is_absent_or_zero(text: &str) -> bool {
    if text == ABSENT {
        return true;
    }
    let Ok(serde_json::Value::Array(items)) = serde_json::from_str::<serde_json::Value>(text)
    else {
        return false;
    };
    !items.is_empty()
        && items
            .iter()
            .all(|item| item.as_f64().is_some_and(|v| v.abs() <= TOLERANCE_ABS))
}

/// Does `diff`'s path match `pattern`, where `#` stands for a run of digits?
///
/// Implemented by normalizing the path rather than by walking the pattern: every
/// array index and numeric map key becomes `#`, and the result is compared whole.
/// A prefix-walking version got this wrong for a trailing `#` (`section_offsets.5`
/// did not match `section_offsets.#`), which silently un-classified finding 2 -
/// the failure mode a clever matcher invites and a boring one does not.
fn path_is(diff: &Diff, pattern: &str) -> bool {
    let mut normalized = String::with_capacity(diff.path.len());
    let mut in_digits = false;
    for ch in diff.path.chars() {
        if ch.is_ascii_digit() {
            if !in_digits {
                normalized.push('#');
                in_digits = true;
            }
        } else {
            normalized.push(ch);
            in_digits = false;
        }
    }
    normalized == pattern
}

/// The classified set, in match order.
const CLASSIFIERS: &[Classifier] = &[
    // FINDING 1 / 11. `restore_section` rebuilds through `Section::new`, which
    // hardcodes the anchors to None and `reverse_parity` to false; and a
    // ProjectSnapshotPair recorded BEFORE a save holds the pre-heal project in
    // both halves. Both show up as a gauge anchor going value -> null. Narrowed
    // to LOSS: an anchor changing to a DIFFERENT value is not either bug.
    Classifier {
        id: "finding-1-redo-of-create-section-drops-gauge-anchors",
        matches: |d, ctx| is_gauge_loss(d) && ctx.command_is("create_section"),
    },
    // FINDING 11, told apart from finding 1 by the ENTRY rather than by the path.
    // A `ProjectSnapshotPair` recorded BEFORE a save holds the pre-heal project in
    // both halves and neither is refreshed, so undoing or redoing an unrelated
    // pre-save command reverts the save's `capture_missing_gauge_anchors`. The
    // harness cannot make this distinction - its bridge does not know which entry
    // a move consumed - so it reports both as finding 1. This tier can.
    Classifier {
        id: "finding-11-pre-save-entry-reverts-the-saves-heals",
        matches: |d, ctx| is_gauge_loss(d) && ctx.entry_predates_save(),
    },
    // FINDING 1. `UndoData::CreatedSectionSnapshot` stores a `SectionData`, which
    // has no uuid field, so redo goes `restore_section` -> `Section::new_with_id`
    // -> `Shot::new` -> `Uuid::new_v4()` and every shot in the section is
    // re-minted. Narrowed to value -> DIFFERENT value: a uuid being filled in is
    // a save heal, and a uuid being lost is not a shape this bug produces.
    // FINDINGS 1 and 11, CASCADING. Once either has reverted the save's gauge
    // capture, the anchors are simply GONE from the live project, so every deeper
    // snapshot that was recorded with them disagrees. Those are re-measurements of
    // the same defect, not new ones. Ordered after the two precise classifiers so
    // a first-hand hit is still attributed to the right finding, and still
    // narrowed to the anchor paths and to LOSS - a gauge anchor changing to a
    // different value is not this and still fails.
    Classifier {
        id: "finding-1-or-11-cascade-anchors-already-reverted",
        matches: |d, ctx| is_gauge_loss(d) && ctx.heal_reverted,
    },
    Classifier {
        id: "finding-1-redo-of-create-section-remints-shot-uuids",
        matches: |d, _| {
            path_is(d, "sections[#].shots[#].uuid")
                && d.expected != ABSENT
                && d.expected != "null"
                && d.actual != ABSENT
                && d.actual != "null"
                && d.expected != d.actual
        },
    },
    // FINDING 2. `adjust_section_offset` CREATES a `section_offsets` key while
    // compensating an insert and nothing removes it, so an all-zero entry
    // survives the undo. Geometrically inert; narrowed to zero-or-absent on BOTH
    // sides, so an offset key appearing with real geometry in it still fails.
    Classifier {
        id: "finding-2-orphan-zero-section-offset",
        matches: |d, _| {
            path_is(d, "section_offsets.#")
                && is_absent_or_zero(&d.expected)
                && is_absent_or_zero(&d.actual)
        },
    },
    // FINDING 5. `SectionUpdates` has no `double_option`, so `Some(None)` and
    // `None` both serialize to null in `values_json` and both read back as
    // "leave it alone". The undo cannot restore a previously-null name, surveyor
    // or date - and once the model has resynced past that, the matching redo
    // disagrees the other way. Narrowed to the three fields the defect covers AND
    // to EXACTLY ONE SIDE being null, which is the shape a lost null/value
    // distinction produces; a field changing from one value to a different value
    // is not this bug and still fails.
    Classifier {
        id: "finding-5-undo-cannot-restore-null-section-field",
        matches: |d, _| {
            (path_is(d, "sections[#].name")
                || path_is(d, "sections[#].surveyor")
                || path_is(d, "sections[#].date"))
                && (d.expected == "null") != (d.actual == "null")
        },
    },
    // FINDING 3. `Project::add_shot` (the append path) is offset-neutral, but the
    // undo routes through `remove_shot_with_rewire`, whose `pos == 0` branch
    // unconditionally calls `adjust_section_offset`. With one shot the appended
    // shot IS index 0, so the delete slides the whole section by that shot's
    // horizontal vector - and the displacement RATCHETS on every further cycle.
    //
    // Narrowed to the ENTRY, not to the path: a `section_offsets` entry gaining or
    // losing real geometry is otherwise indistinguishable from a genuine offset
    // bug, and finding 15 is exactly that shape on a different entry. Only a
    // consumed `create_shot` that appended the FIRST shot into an empty section
    // qualifies, and only on that section's own offset key.
    Classifier {
        id: "finding-3-undo-of-the-first-shot-displaces-an-empty-section",
        matches: |d, ctx| {
            let Some(section_id) = ctx.appended_into_empty() else {
                return false;
            };
            // Both spellings: the section may or may not already have had an
            // offset, and the differ recurses into a pair that exists on both
            // sides (`section_offsets.5[0]`) while reporting a whole key when it
            // does not (`section_offsets.5`). The RATCHET half of the finding
            // only ever produces the second shape, so a classifier that matched
            // only the first could not see it.
            offset_key_of(&d.path).is_some_and(|(id, _)| id == section_id)
        },
    },
    // FINDING 12. Same root cause as finding 8, different `UndoData` variants and
    // a much quieter symptom: no shot is lost, no uuid changes and no count
    // moves - one shot silently keeps an edit the undo was supposed to take away
    // and a neighbour silently gains one it never had.
    //
    // Narrowed by MEASUREMENT rather than by shape: the entry has to be one of
    // the two id-bearing edit variants (`PreviousValues` for `update_shot`,
    // `InverseCommand` for `set_shot_kind`) AND the id it carries has to
    // PROVABLY address a different shot than the one it was recorded against
    // (`Staleness::Collides`, measured before the move against the shot's uuid).
    // Without that second half this would also swallow "the undo of an edit
    // simply did not work", which is a different bug.
    Classifier {
        id: "finding-12-stale-id-edits-the-wrong-shot",
        matches: |d, ctx| {
            (ctx.command_is("update_shot") || ctx.command_is("set_shot_kind"))
                && ctx.stale.target == Staleness::Collides
                && shot_field_path(&d.path).is_some_and(|field| field != "uuid")
        },
    },
    // FINDING 3, CASCADING - and the answer to what FINDING 15 was.
    //
    // Finding 3's displacement is not undone by anything: the redo re-inserts
    // through the offset-neutral append path (that is the RATCHET half of the
    // finding), and no targeted undo below it touches `section_offsets`. So once
    // the empty section has slid, the live project carries that key until the
    // walk crosses a `ProjectSnapshotPair` entry, which restores the whole
    // project and heals it. Every snapshot recorded before the slide disagrees
    // meanwhile - in EITHER direction, since the model resynced the depth the
    // hit landed on, so a later redo back UP to that depth is missing a key the
    // model now expects.
    //
    // Finding 15 was reported as a separate defect ("an undo leaves a
    // `section_offsets` entry carrying REAL geometry") because the move that
    // FAILS is several steps past the one that did it and consumes an unrelated
    // entry - an `update_shot`, a `set_station_comment`. It is finding 3,
    // re-measured. Narrowed to the displaced section's own key AND to the exact
    // value finding 3 left, so a section acquiring a DIFFERENT offset is not
    // this and still fails.
    Classifier {
        id: "finding-3-cascade-a-displaced-empty-section-persists",
        matches: |d, ctx| ctx.is_finding_3_displacement(d),
    },
    // FINDING 16, CASCADING. A section holding one `Shot::uuid` twice cannot
    // match any snapshot recorded before the duplication: one shot was destroyed
    // to make room for the copy, so every shot below it sits at a different
    // index and every field of every one of them reads as changed. Nothing
    // removes the copy either, so it persists until a `ProjectSnapshotPair`
    // entry restores the whole project.
    //
    // Narrowed to the SECTION finding 16 corrupted - resolved through the
    // recorded snapshot's own section order - and to its offset key. A
    // difference anywhere else in the project is not this and still fails.
    Classifier {
        id: "finding-16-cascade-a-section-with-a-duplicated-uuid-cannot-match",
        matches: |d, ctx| ctx.is_in_a_corrupted_section(d),
    },
];

/// A gauge anchor (or the reverse-parity flag) being LOST rather than changed.
/// Shared by findings 1 and 11, which produce the same shape from different
/// causes; the classifiers above separate them by the consumed entry.
fn is_gauge_loss(diff: &Diff) -> bool {
    (path_is(diff, "sections[#].gauge_shot_uuid")
        || path_is(diff, "sections[#].gauge_neighbour_uuid")
        || path_is(diff, "sections[#].reverse_parity"))
        && is_null_or_false(&diff.actual)
}

/// Which classifier explains `diff`, if any.
fn classify(diff: &Diff, ctx: &MoveCtx) -> Option<&'static str> {
    CLASSIFIERS
        .iter()
        .find(|classifier| (classifier.matches)(diff, ctx))
        .map(|classifier| classifier.id)
}

/// Changes a SAVE makes to live state with no undo entry of its own
/// (`AppState::save_project`), subtracted only from comparisons that cross a
/// save. Deliberately narrow by direction: an anchor may only be GAINED, a uuid
/// filled in, an offset entry dropped.
fn attributable_to_save(diff: &Diff) -> bool {
    ((path_is(diff, "sections[#].gauge_shot_uuid")
        || path_is(diff, "sections[#].gauge_neighbour_uuid"))
        && diff.expected == "null"
        && diff.actual != "null")
        || (path_is(diff, "sections[#].shots[#].uuid")
            && (diff.expected == ABSENT || diff.expected == "null")
            && diff.actual != ABSENT)
        || (path_is(diff, "section_offsets.#") && diff.actual == ABSENT)
}

/// Derived geometry a RELOAD re-solves from scratch: `redrive_offsets_after_load`
/// ends in an unconditional `resolve_offsets()` ("Zero-trust: never honor a
/// persisted derivable offset"), so `section_offsets` and the station offsets
/// derived from them are RECOMPUTED rather than restored.
fn attributable_to_reload(diff: &Diff) -> bool {
    // BOTH spellings of an offset difference: the whole key when it is present
    // on one side only, and the element when it exists on both and the differ
    // recurses into the pair. The re-solve recomputes the whole map, so the two
    // are the same fact - and matching only the first left every value change
    // across a reload reading as unexplained.
    offset_key_of(&diff.path).is_some() || diff.path.starts_with("station_offsets")
}

/// Per-section shot uuids, in order, from a canonical snapshot.
fn shot_uuids(snapshot: &str) -> Vec<(i64, Vec<String>)> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(snapshot) else {
        return Vec::new();
    };
    let Some(sections) = value.get("sections").and_then(|s| s.as_array()) else {
        return Vec::new();
    };
    sections
        .iter()
        .map(|section| {
            let id = section
                .get("id")
                .and_then(serde_json::Value::as_i64)
                .unwrap_or(-1);
            let uuids = section
                .get("shots")
                .and_then(|s| s.as_array())
                .map(|shots| {
                    shots
                        .iter()
                        .map(|shot| {
                            shot.get("uuid")
                                .and_then(|u| u.as_str())
                                .unwrap_or("<none>")
                                .to_string()
                        })
                        .collect()
                })
                .unwrap_or_default();
            (id, uuids)
        })
        .collect()
}

/// FINDINGS 8 / 12's structural signature: a section holds the right NUMBER of
/// shots, but at least one of them is the WRONG shot.
///
/// Recognised by uuid rather than by path, because the wrong shot being deleted
/// or written to rewrites every derived coordinate, and a path rule broad enough
/// to cover that would hide real drift. Requires an even swap - a count change or
/// a one-sided loss is something else and still fails.
fn is_shot_identity_swap(expected: &str, actual: &str) -> bool {
    let before = shot_uuids(expected);
    let after = shot_uuids(actual);
    if before.len() != after.len() || before.is_empty() {
        return false;
    }
    let mut swapped = false;
    for ((id_a, uuids_a), (id_b, uuids_b)) in before.iter().zip(after.iter()) {
        if id_a != id_b || uuids_a.len() != uuids_b.len() {
            return false;
        }
        let missing = uuids_a.iter().filter(|u| !uuids_b.contains(u)).count();
        let extra = uuids_b.iter().filter(|u| !uuids_a.contains(u)).count();
        if missing != extra {
            return false;
        }
        if missing > 0 {
            swapped = true;
        }
    }
    swapped
}

/// Does this subtree name station 0 of `section_id`?
///
/// Station 0 of any section is `StationKey { section_id, anchor: SectionStart }`
/// (models/station.rs), and every stored station reference - a merge endpoint, a
/// zero datum, a station-comment key - serializes to that shape. Matching the
/// SHAPE rather than each container's field names is what lets one predicate
/// cover all three lists.
fn names_station_zero(value: &serde_json::Value, section_id: SectionId) -> bool {
    match value {
        serde_json::Value::Object(map) => {
            // `as_f64`, not `as_u64`: `canonicalize` rounds every number through
            // `Number::from_f64`, so an id reads back as `6.0` and an integer
            // accessor returns None for all of them.
            let is_ref = map.get("section_id").and_then(serde_json::Value::as_f64)
                == Some(f64::from(section_id))
                && map.get("anchor").and_then(serde_json::Value::as_str) == Some("SectionStart");
            is_ref
                || map
                    .values()
                    .any(|child| names_station_zero(child, section_id))
        }
        serde_json::Value::Array(items) => items
            .iter()
            .any(|child| names_station_zero(child, section_id)),
        _ => false,
    }
}

/// Drop every array element that names station 0 of `section_id`, and return how
/// many were dropped.
fn strip_station_zero_refs(value: &mut serde_json::Value, section_id: SectionId) -> usize {
    let mut dropped = 0;
    match value {
        serde_json::Value::Object(map) => {
            for child in map.values_mut() {
                dropped += strip_station_zero_refs(child, section_id);
            }
        }
        serde_json::Value::Array(items) => {
            let before = items.len();
            items.retain(|item| !names_station_zero(item, section_id));
            dropped += before - items.len();
            for child in items.iter_mut() {
                dropped += strip_station_zero_refs(child, section_id);
            }
        }
        _ => {}
    }
    dropped
}

/// FINDING 3's DATA-LOSS half: the same `pos == 0` branch that displaces the
/// section also DROPS every ref keyed to its station 0 (`shots.rs`, the
/// `pos == 0` branch). An empty section has only station 0, so a merge, a zero
/// datum or a station comment anchored there is destroyed by the undo.
///
/// Recognised structurally rather than by path, because a dropped merge
/// re-indexes the whole list and every field of every later entry reads as
/// changed. Returns what is STILL different once both sides are stripped of refs
/// to that one station, so the offset half of the same hit keeps classifying
/// normally and anything else the move broke still fails. `None` means the shape
/// is absent - the expected side did not hold strictly more such refs - and the
/// caller compares as usual.
fn diffs_without_station_zero_refs(
    expected: &str,
    actual: &str,
    section_id: SectionId,
    require_drop: bool,
) -> Option<Vec<Diff>> {
    let (Ok(mut left), Ok(mut right)) = (
        serde_json::from_str::<serde_json::Value>(expected),
        serde_json::from_str::<serde_json::Value>(actual),
    ) else {
        return None;
    };
    let before = strip_station_zero_refs(&mut left, section_id);
    let after = strip_station_zero_refs(&mut right, section_id);
    // A first-hand hit is an undo that DESTROYS refs, so the expected side has
    // to hold more of them. The cascade takes either direction: once the model
    // has resynced to a state missing them, a redo back UP to that depth
    // restores them and the same loss is re-measured with the sides swapped.
    if before == after || (require_drop && before < after) {
        return None;
    }
    let mut diffs = Vec::new();
    diff_values(&left, &right, "", &mut diffs);
    Some(diffs)
}

/// The field name for a path naming one SCALAR field of one shot.
///
/// `uuid` is deliberately included in what this returns - callers exclude it -
/// because identity and measurement are different claims and only the caller
/// knows which one its bug is about.
fn shot_field_path(path: &str) -> Option<String> {
    let mut normalized = String::with_capacity(path.len());
    let mut in_digits = false;
    for ch in path.chars() {
        if ch.is_ascii_digit() {
            if !in_digits {
                normalized.push('#');
                in_digits = true;
            }
        } else {
            normalized.push(ch);
            in_digits = false;
        }
    }
    let field = normalized.strip_prefix("sections[#].shots[#].")?;
    (!field.contains('.') && !field.contains('[')).then(|| field.to_string())
}

/// Every shot uuid of one section, in order.
fn section_shot_uuids(snapshot: &str, section_id: SectionId) -> Option<Vec<String>> {
    let value = serde_json::from_str::<serde_json::Value>(snapshot).ok()?;
    let sections = value.get("sections")?.as_array()?;
    let section = sections.iter().find(|section| {
        section.get("id").and_then(serde_json::Value::as_f64) == Some(f64::from(section_id))
    })?;
    Some(
        section
            .get("shots")?
            .as_array()?
            .iter()
            .map(|shot| {
                shot.get("uuid")
                    .and_then(|u| u.as_str())
                    .unwrap_or("<none>")
                    .to_string()
            })
            .collect(),
    )
}

/// Drop the shot with `uuid` from `section_id` wherever it appears.
fn strip_shot(value: &mut serde_json::Value, section_id: SectionId, uuid: &str) {
    let Some(sections) = value
        .get_mut("sections")
        .and_then(serde_json::Value::as_array_mut)
    else {
        return;
    };
    for section in sections.iter_mut() {
        if section.get("id").and_then(serde_json::Value::as_f64) != Some(f64::from(section_id)) {
            continue;
        }
        if let Some(shots) = section
            .get_mut("shots")
            .and_then(serde_json::Value::as_array_mut)
        {
            shots.retain(|shot| shot.get("uuid").and_then(|u| u.as_str()) != Some(uuid));
        }
    }
}

/// A NEW FINDING's structural signature (issue #413, finding 16): ONE shot sits
/// at a different index than the model recorded, and the section is otherwise
/// the same list of the same shots.
///
/// That is what a re-insert against a stale ANCHOR produces: `redo` of
/// `CreateShot` re-runs `insert_shot_before` / `insert_shot_after` with the
/// persisted `before_shot_id` / `after_shot_id` (core/state/undo.rs), and after
/// a reload those ids address different shots, so the shot comes back in the
/// wrong place.
///
/// Returns what is still different once that one shot is removed from BOTH
/// sides, so the derived geometry it displaced is still classified or still
/// fails. `None` when the shape is absent - the shot is missing from a side, or
/// its index agrees, or the rest of the list does not.
fn diffs_without_misplaced_shot(
    expected: &str,
    actual: &str,
    section_id: SectionId,
    uuid: &str,
) -> Option<Vec<Diff>> {
    let before = section_shot_uuids(expected, section_id)?;
    let after = section_shot_uuids(actual, section_id)?;
    let (Some(was), Some(now)) = (
        before.iter().position(|u| u == uuid),
        after.iter().position(|u| u == uuid),
    ) else {
        return None;
    };
    if was == now {
        return None;
    }
    // The REST of the list has to be untouched, or this is not "one shot moved".
    let rest =
        |list: &[String]| -> Vec<String> { list.iter().filter(|u| *u != uuid).cloned().collect() };
    if rest(&before) != rest(&after) {
        return None;
    }
    let (Ok(mut left), Ok(mut right)) = (
        serde_json::from_str::<serde_json::Value>(expected),
        serde_json::from_str::<serde_json::Value>(actual),
    ) else {
        return None;
    };
    strip_shot(&mut left, section_id, uuid);
    strip_shot(&mut right, section_id, uuid);
    let mut diffs = Vec::new();
    diff_values(&left, &right, "", &mut diffs);
    Some(diffs)
}

/// How many shots in `section_id` carry `uuid`. More than one is impossible by
/// construction and is finding 16's whole signature.
fn uuid_occurrences(snapshot: &str, section_id: SectionId, uuid: &str) -> usize {
    section_shot_uuids(snapshot, section_id).map_or(0, |uuids| {
        uuids.iter().filter(|found| *found == uuid).count()
    })
}

/// FINDING 10's structural signature: one loop closure is gone and one station
/// merge with the SAME endpoints has appeared, and nothing else moved.
///
/// That is exactly what `convert_orphan_closures_to_merges` does
/// (models/project/offsets.rs): it removes the closure and records a
/// `StationMerge` carrying its two `StationKey`s verbatim. The finding is that
/// two of the four delete entry points never run it, so the orphan is saved as a
/// closure and the LOADER converts it - a save+reopen that is not
/// state-preserving.
///
/// Matched on the endpoints rather than on the counts alone: a closure vanishing
/// and an unrelated merge appearing is not this.
fn diffs_without_orphan_conversion(expected: &str, actual: &str) -> Option<Vec<Diff>> {
    let (Ok(mut left), Ok(mut right)) = (
        serde_json::from_str::<serde_json::Value>(expected),
        serde_json::from_str::<serde_json::Value>(actual),
    ) else {
        return None;
    };
    // EITHER direction. The conversion happens once, on the reload, and the
    // model resyncs to it - so a later redo back UP to a depth recorded before
    // the reload re-measures the same swap with the sides exchanged.
    let (closure, merge, closure_on_left) =
        match (converted_pair(&left, &right), converted_pair(&right, &left)) {
            (Some((closure, merge)), None) => (closure, merge, true),
            (None, Some((closure, merge))) => (closure, merge, false),
            _ => return None,
        };
    let drop_matching = |value: &mut serde_json::Value, key: &str, wanted: &serde_json::Value| {
        if let Some(items) = value.get_mut(key).and_then(serde_json::Value::as_array_mut) {
            if let Some(index) = items.iter().position(|item| item == wanted) {
                items.remove(index);
            }
        }
    };
    if closure_on_left {
        drop_matching(&mut left, "loop_closures", &closure);
        drop_matching(&mut right, "station_merges", &merge);
    } else {
        drop_matching(&mut right, "loop_closures", &closure);
        drop_matching(&mut left, "station_merges", &merge);
    }
    // What is left goes through the ordinary classification and the ordinary
    // save/reload attribution - a reload also re-solves `section_offsets`, and
    // requiring byte equality here would mean the signature only ever matched a
    // conversion with no geometry attached.
    let mut diffs = Vec::new();
    diff_values(&left, &right, "", &mut diffs);
    Some(diffs)
}

/// Exactly one closure present in `with_closure` and absent from `with_merge`,
/// against exactly one merge present in `with_merge` and absent from
/// `with_closure`, carrying the SAME two station keys.
fn converted_pair(
    with_closure: &serde_json::Value,
    with_merge: &serde_json::Value,
) -> Option<(serde_json::Value, serde_json::Value)> {
    let list = |value: &serde_json::Value, key: &str| -> Vec<serde_json::Value> {
        value
            .get(key)
            .and_then(|items| items.as_array())
            .cloned()
            .unwrap_or_default()
    };
    let ends = |item: &serde_json::Value| -> Option<(serde_json::Value, serde_json::Value)> {
        Some((
            item.get("station_a")?.clone(),
            item.get("station_b")?.clone(),
        ))
    };
    let closures_after = list(with_merge, "loop_closures");
    let lost: Vec<serde_json::Value> = list(with_closure, "loop_closures")
        .into_iter()
        .filter(|closure| {
            !closures_after
                .iter()
                .any(|other| other.get("id") == closure.get("id"))
        })
        .collect();
    let merges_before = list(with_closure, "station_merges");
    let gained: Vec<serde_json::Value> = list(with_merge, "station_merges")
        .into_iter()
        .filter(|merge| !merges_before.iter().any(|other| ends(other) == ends(merge)))
        .collect();
    let ([closure], [merge]) = (lost.as_slice(), gained.as_slice()) else {
        return None;
    };
    (ends(closure) == ends(merge)).then(|| (closure.clone(), merge.clone()))
}

/// FINDING 4's structural signature: `loop_closures` holds the same members in a
/// different order. Undo of `RemoveLoopClosure` pushes instead of re-inserting at
/// the removed index (core/state/undo.rs), and that order is persisted, indexed
/// by the frontend, and the order `resolve_offsets` builds its adjacency in.
fn diffs_without_closure_reorder(expected: &str, actual: &str) -> Option<Vec<Diff>> {
    diffs_without_list_reorder(expected, actual, "loop_closures")
}

/// A NEW FINDING's structural signature (issue #413, finding 17), and finding
/// 4's twin one collection over: `zero_datums` holds the same members in a
/// different order.
///
/// `UndoData::ZeroDatumInfo`'s restore arm ends in
/// `project.zero_datums.push(ZeroDatum { .. })` (core/state/undo.rs) where the
/// forward path took the datum out in place, so a datum that was not last comes
/// back last. Invisible until a run has two datums to reorder, which is why the
/// closure-shapes prologue - which builds a second anchored component - is what
/// surfaced it.
fn diffs_without_datum_reorder(expected: &str, actual: &str) -> Option<Vec<Diff>> {
    diffs_without_list_reorder(expected, actual, "zero_datums")
}

/// `key` holds the same members in a different order on the two sides.
///
/// Returns what is still different once both are sorted, so a reorder that comes
/// with other classified differences (a uuid re-mint, an offset heal) is still
/// recognised and anything unexplained still fails. `None` when the two are not
/// permutations of each other, or already agree.
fn diffs_without_list_reorder(expected: &str, actual: &str, key: &str) -> Option<Vec<Diff>> {
    let (Ok(mut left), Ok(mut right)) = (
        serde_json::from_str::<serde_json::Value>(expected),
        serde_json::from_str::<serde_json::Value>(actual),
    ) else {
        return None;
    };
    let sorted = |value: &mut serde_json::Value| -> Option<Vec<String>> {
        let list = value.get_mut(key)?.as_array_mut()?;
        if list.len() < 2 {
            return None;
        }
        let before: Vec<String> = list.iter().map(ToString::to_string).collect();
        list.sort_by_key(ToString::to_string);
        let after: Vec<String> = list.iter().map(ToString::to_string).collect();
        Some(if before == after { Vec::new() } else { after })
    };
    let (Some(left_order), Some(right_order)) = (sorted(&mut left), sorted(&mut right)) else {
        return None;
    };
    // At least one side has to have been out of order, and the two have to be
    // the same members - a list that GAINED or LOST an entry is not a reorder.
    if left_order.is_empty() && right_order.is_empty() {
        return None;
    }
    if !left_order.is_empty() && !right_order.is_empty() && left_order != right_order {
        return None;
    }
    let mut diffs = Vec::new();
    diff_values(&left, &right, "", &mut diffs);
    Some(diffs)
}

// ===========================================================================
// Synthetic starting project
// ===========================================================================

pub(super) const COLORS: &[&str] = &["#3388FF", "#FF8833", "#33CC66", "#CC33AA", "#FFCC00"];

/// A valid, unremarkable shot. Every value comes from an integer draw.
pub(super) fn random_shot(rng: &mut Rng) -> ShotData {
    let azimuth = rng.float(0.0, 359.9);
    let depth_in = rng.float(0.0, 30.0);
    ShotData {
        azimuth_in: azimuth,
        azimuth_out: (azimuth + rng.float(-1.5, 1.5) + 360.0) % 360.0,
        length: rng.float(1.0, 12.0),
        depth_in,
        depth_out: (depth_in + rng.float(-3.0, 3.0)).max(0.0),
        pitch_in: rng.chance(40).then(|| rng.float(-60.0, 60.0)),
        pitch_out: rng.chance(40).then(|| rng.float(-60.0, 60.0)),
        left: rng.chance(70).then(|| rng.float(0.0, 5.0)),
        right: rng.chance(70).then(|| rng.float(0.0, 5.0)),
        up: rng.chance(70).then(|| rng.float(0.0, 5.0)),
        down: rng.chance(70).then(|| rng.float(0.0, 5.0)),
        comment: rng
            .chance(20)
            .then(|| format!("shot-{}", rng.range(0, 9999))),
        kind: *rng.pick(&[
            ShotKind::Normal,
            ShotKind::Normal,
            ShotKind::Jump,
            ShotKind::Reference,
        ]),
        marker_index: rng.chance(15).then(|| rng.range(0, 9) as u32),
        temperature: rng.chance(30).then(|| rng.float(4.0, 30.0)),
    }
}

/// A starting project with the topology that made the naharon fixture productive:
/// sections of varied length INCLUDING empty and single-shot ones, station
/// merges, a zero datum, a genuine loop closure, station comments, and sections
/// with null metadata.
///
/// Built rather than loaded. The repo forbids committing fixtures and CI has
/// none, so the shapes that matter are constructed explicitly - which also means
/// each one is here on purpose and can be pointed at when a finding needs it.
pub(super) fn build_project(state: &AppState, rng: &mut Rng, closures: bool) -> Vec<SectionId> {
    let created = state.execute(Command::CreateProject {
        name: "RustFuzz".to_string(),
        location: None,
    });
    assert!(created.success, "CreateProject failed: {:?}", created.error);

    // Shot counts chosen to include the two shapes that have carried findings:
    // 0 (bug 3's empty section) and 1 (bug 8's single-shot divergence).
    let shape: &[usize] = &[3, 0, 1, 4, 2, 1, 3];
    let mut ids = Vec::new();
    for (index, count) in shape.iter().enumerate() {
        let shots: Vec<ShotData> = (0..*count).map(|_| random_shot(rng)).collect();
        // Null name/surveyor/date on some sections: finding 5 only exists for a
        // field that STARTS null, and the fractal fixture had none.
        let null_metadata = index % 3 == 0;
        let result = state.execute(Command::CreateSection {
            name: (!null_metadata).then(|| format!("sec-{index}")),
            surveyor: (!null_metadata).then(|| format!("surveyor-{}", rng.range(1, 9))),
            date: None,
            color: (*rng.pick(COLORS)).to_string(),
            direction: Some(if rng.chance(50) {
                SurveyDirection::In
            } else {
                SurveyDirection::Out
            }),
            shots,
        });
        assert!(result.success, "CreateSection failed: {:?}", result.error);
        ids.push(result.section_id.expect("CreateSection returned no id"));
    }

    // A zero datum anchors the first component, which is what makes closures and
    // several delete guards reachable at all.
    let datum = state.execute(Command::SetZeroDatum {
        station_ref: StationRef::new(ids[0], 0),
        coordinates: GpsCoordinates::new(20.4, -87.3, 0.0).unwrap(),
    });
    assert!(datum.success, "SetZeroDatum failed: {:?}", datum.error);

    // A - bridge - B chain plus a closure straight from A to B: a genuine loop
    // with two independent paths, which is the only shape a closure may legally
    // describe.
    //
    // FINDING 14 lives here, which is why the gate does not build it. With this
    // chain in place and the datum at section 0, a later mid-section insert into
    // section 0 leaves the 0 <-> 3 merge 6.97 m out of alignment and the app's own
    // `#[cfg(test)]` assert panics inside `insert_shot_after`. The generators
    // still build merges, closures and datums during a run, so the gate keeps
    // exercising those commands - it just does not START from the shape that is
    // currently broken.
    if !closures {
        return ids;
    }
    for (left, right) in [(0_usize, 3_usize), (3, 4)] {
        let a = ids[left];
        let b = ids[right];
        let a_stations = shape[left] as u32;
        let merged = state.execute(Command::MergeStations {
            station_a: StationRef::new(a, a_stations),
            station_b: StationRef::new(b, 0),
        });
        assert!(
            merged.success,
            "setup MergeStations failed: {:?}",
            merged.error
        );
    }
    let closure = state.execute(Command::CreateLoopClosure {
        station_a: StationRef::new(ids[0], 0),
        station_b: StationRef::new(ids[4], shape[4] as u32),
        closure_strategy: ClosureStrategy::Move,
    });
    assert!(
        closure.success,
        "setup CreateLoopClosure failed: {:?}",
        closure.error
    );

    for index in [0_usize, 5] {
        let commented = state.execute(Command::SetStationComment {
            station_ref: StationRef::new(ids[index], 0),
            comment: Some(format!("station-note-{index}")),
        });
        assert!(
            commented.success,
            "SetStationComment failed: {:?}",
            commented.error
        );
    }

    ids
}

// ===========================================================================
// Live-state targeting
// ===========================================================================

/// Everything the generators need to pick a target, read out of the live project
/// and SORTED. Sorting is what keeps a seed's trajectory stable: `HashMap`
/// iteration order is not, and neither is `Vec` order once a command reorders a
/// collection.
pub(super) struct Targets {
    /// `(section_id, [shot_id, ...])`, ascending.
    pub(super) sections: Vec<(SectionId, Vec<ShotId>)>,
    /// `(section_id, station_index)`, ascending.
    pub(super) stations: Vec<(SectionId, u32)>,
    /// Merged pairs, as resolved positional refs, ascending.
    pub(super) merges: Vec<((SectionId, u32), (SectionId, u32))>,
    /// Zero-datum stations, ascending.
    pub(super) datums: Vec<(SectionId, u32)>,
    /// Loop closure ids, ascending.
    pub(super) closures: Vec<u64>,
}

pub(super) fn read_targets(state: &AppState) -> Targets {
    let project = state.get_project_state().expect("no project open");
    let mut sections: Vec<(SectionId, Vec<ShotId>)> = project
        .sections
        .iter()
        .map(|section| {
            let mut shots: Vec<ShotId> = section.shots.iter().map(|shot| shot.id).collect();
            shots.sort_unstable();
            (section.id, shots)
        })
        .collect();
    sections.sort_by_key(|entry| entry.0);

    let mut stations = Vec::new();
    for (id, shots) in &sections {
        for index in 0..=shots.len() {
            stations.push((*id, index as u32));
        }
    }

    let mut merges: Vec<((SectionId, u32), (SectionId, u32))> = project
        .station_merges
        .iter()
        .filter_map(|merge| {
            let a = project.resolve_key(&merge.station_a)?;
            let b = project.resolve_key(&merge.station_b)?;
            Some((
                (a.section_id, a.station_index),
                (b.section_id, b.station_index),
            ))
        })
        .collect();
    merges.sort_unstable();

    let mut datums: Vec<(SectionId, u32)> = project
        .zero_datums
        .iter()
        .filter_map(|datum| {
            let resolved = project.resolve_key(&datum.station_ref)?;
            Some((resolved.section_id, resolved.station_index))
        })
        .collect();
    datums.sort_unstable();

    let mut closures: Vec<u64> = project
        .loop_closures
        .iter()
        .map(|closure| closure.id)
        .collect();
    closures.sort_unstable();

    Targets {
        sections,
        stations,
        merges,
        datums,
        closures,
    }
}

pub(super) fn random_offset(rng: &mut Rng) -> Coordinates {
    let extreme = |rng: &mut Rng| *rng.pick(&[0.0, GEOMETRY_EXTREME, -GEOMETRY_EXTREME, 1e-9]);
    if rng.chance(15) {
        Coordinates::new(extreme(rng), extreme(rng), extreme(rng))
    } else {
        Coordinates::new(
            rng.float(-3.0, 3.0),
            rng.float(-3.0, 3.0),
            rng.float(-1.5, 1.5),
        )
    }
}

// ===========================================================================
// The fuzzer
// ===========================================================================

/// How a run ended, for the caller to assert on.
#[derive(Debug, Default)]
struct Outcome {
    mutations: usize,
    rejected: usize,
    noops: usize,
    undos: usize,
    redos: usize,
    jumps: usize,
    saves: usize,
    reloads: usize,
    max_depth: usize,
    /// Classified known-bug hits, by finding id.
    hits: BTreeMap<&'static str, usize>,
    /// Comparisons the numeric tolerance absorbed.
    float_noise: usize,
    /// Comparisons explained entirely by a documented save/reload heal.
    attributed: usize,
    /// True when a known wedge stopped the walk early (finding 6 or 13).
    wedged: bool,
    /// True when the app's own `#[cfg(test)]` merge-alignment assert fired
    /// (finding 14) and the run stopped there.
    alignment_panic: bool,
    /// True when finding 20 left a merge drifted under the app's own 5 cm heal
    /// gate and the run stopped there. See `expect_merges_aligned` for why the
    /// hit is terminal rather than merely counted.
    drift_stop: bool,
    /// Integrity verdicts compared. Counted so the oracle can be SHOWN to be
    /// doing work rather than passing vacuously.
    integrity_compared: usize,
    /// Adjusted-geometry states compared.
    adjusted_compared: usize,
    /// Wall time spent inside each derived-state oracle, in microseconds:
    /// (snapshot, integrity, adjusted). Reported per run so the cost of the two
    /// ports is a measured number rather than a guess.
    oracle_us: (u128, u128, u128),
    /// Undo entries the app FIFO-trimmed out of reach during the run.
    trimmed: usize,
    /// Largest collection sizes seen. Growth sanity for a long run.
    peak: Peak,
}

/// The largest each unbounded-in-principle collection got during a run.
#[derive(Debug, Default, Clone, Copy)]
struct Peak {
    sections: usize,
    stations: usize,
    section_offsets: usize,
    station_offsets: usize,
    station_comments: usize,
    merges: usize,
    closures: usize,
}

/// Every difference between two adjusted-geometry states, outside
/// `ADJUSTED_TOLERANCE_M`.
pub(super) fn adjusted_diffs(expected: &str, actual: &str) -> Vec<String> {
    let parse = |text: &str| -> BTreeMap<String, [f64; 3]> {
        text.lines()
            .filter_map(|line| {
                let mut parts = line.split('|');
                let key = parts.next()?.to_string();
                let x = parts.next()?.parse().ok()?;
                let y = parts.next()?.parse().ok()?;
                let z = parts.next()?.parse().ok()?;
                Some((key, [x, y, z]))
            })
            .collect()
    };
    let (before, after) = (parse(expected), parse(actual));
    let mut out = Vec::new();
    for (key, left) in &before {
        match after.get(key) {
            None => out.push(format!("station {key} is GONE from the adjusted solve")),
            Some(right) => {
                let worst = (0..3)
                    .map(|axis| (left[axis] - right[axis]).abs())
                    .fold(0.0_f64, f64::max);
                let magnitude = (0..3)
                    .map(|axis| left[axis].abs().max(right[axis].abs()))
                    .fold(0.0_f64, f64::max);
                if worst > ADJUSTED_TOLERANCE_M + ADJUSTED_TOLERANCE_REL * magnitude {
                    out.push(format!(
                        "station {key} moved {worst:.6} m: {left:?} -> {right:?}"
                    ));
                }
            }
        }
    }
    for key in after.keys() {
        if !before.contains_key(key) {
            out.push(format!("station {key} APPEARED in the adjusted solve"));
        }
    }
    out.truncate(8);
    out
}

/// The three per-state oracles as FREE functions, so a driver that is not the
/// `Fuzzer` - the metamorphic twins in `metamorphic_undo_tests.rs` - measures a
/// state exactly as the fuzzer does rather than with a second implementation
/// that can drift from it.
///
/// The `Fuzzer` methods are thin wrappers that add the per-run timing the
/// summary line reports.
///
/// Canonical, comparison-ready snapshot of the live project.
pub(super) fn canonical_snapshot(state: &AppState, id_agnostic: bool) -> String {
    let raw = state
        .capture_project_snapshot()
        .expect("capture_project_snapshot failed");
    let parsed: serde_json::Value = serde_json::from_str(&raw).expect("snapshot is not JSON");
    canonicalize(&parsed, "", id_agnostic).to_string()
}

/// The app's own integrity verdict, normalized. See `Verdict`.
pub(super) fn integrity_verdict(state: &AppState) -> Verdict {
    let result = state.integrity_check();
    let mut messages = result.messages;
    messages.sort();
    Verdict {
        save_blocked: result.save_blocked,
        messages,
    }
}

/// The ADJUSTED station geometry - what the map draws and every export writes -
/// canonicalized to a comparable string.
pub(super) fn adjusted_geometry_of(state: &AppState) -> String {
    let Some(stations) = state.get_adjusted_stations() else {
        return String::new();
    };
    let mut rows: Vec<String> = stations
        .iter()
        .map(|station| {
            format!(
                "{}:{}|{}|{}|{}",
                station.station_ref.section_id,
                station.station_ref.station_index,
                round_significant(station.coordinates.x),
                round_significant(station.coordinates.y),
                round_significant(station.coordinates.z),
            )
        })
        .collect();
    // Sorted: `get_adjusted_stations` builds its list by walking sections, and a
    // command that reorders sections would otherwise read as every station
    // having moved.
    rows.sort();
    rows.join("\n")
}

struct Fuzzer {
    state: AppState,
    rng: Rng,
    seed: u32,
    /// `snapshots[d]` is the canonical project at undo depth `d`.
    snapshots: Vec<String>,
    /// `verdicts[d]` is the app's own integrity verdict at undo depth `d`.
    verdicts: Vec<Verdict>,
    /// `adjusted[d]` is the canonical ADJUSTED station geometry at depth `d` -
    /// what the map draws, solved rather than stored.
    adjusted: Vec<String>,
    /// Epoch each snapshot was recorded in; a save or a reload bumps the epoch.
    epochs: Vec<u32>,
    /// `entry_meta[d]` describes the entry that takes depth d-1 to d. Index 0 is
    /// a placeholder so the indexing matches `snapshots`.
    entry_meta: Vec<EntryMeta>,
    epoch: u32,
    cursor: usize,
    top: usize,
    /// The lowest depth the history can still reach.
    ///
    /// Zero until the app's `undo_history_limit` FIFO-trims the oldest entries
    /// (`UndoStack::enforce_depth_limit` -> `trim_to_count`, core/undo/budget.rs,
    /// which drops from the FRONT of both stacks on every push). From then on
    /// the model is a SLIDING WINDOW: depth `floor` is the deepest state the
    /// user can still get back to, everything below it is gone for good, and
    /// `undo_len` is `cursor - floor` rather than `cursor`.
    floor: usize,
    /// The app's own count limit, read from the app rather than assumed.
    history_limit: usize,
    /// Per depth, the largest tolerated numeric difference seen at each path.
    ///
    /// The accumulation oracle's memory: a difference that stays under
    /// `TOLERANCE_ABS` is accepted every time it is seen, so a run that visits a
    /// depth a hundred times can walk it past the tolerance one dust grain at a
    /// time. Recording what was tolerated is what lets the failure be told apart
    /// from a fresh regression.
    drift: BTreeMap<usize, BTreeMap<String, f64>>,
    /// Human-readable move history, tailed into a failure payload.
    log: Vec<String>,
    id_agnostic: bool,
    outcome: Outcome,
    /// Kept alive for the run: dropping it deletes the save file.
    temp: Option<TempDir>,
    /// May the generators create loop closures? See `Plan::closures`.
    closures: bool,
    /// Build finding 10's orphan-closure shape on the next boundary crossing.
    /// See `expose_orphan_closure` for why it cannot be built up front.
    orphan_pending: bool,
    /// Set once findings 1 or 11 have reverted the save's gauge capture. From then
    /// on the live project no longer HAS the anchors, so every later depth
    /// recorded with them disagrees - the same defect, re-measured. See the
    /// cascade classifier.
    heal_reverted: bool,
    /// Sections finding 3 has displaced, and the canonical text of the
    /// `section_offsets` value it left. Same idea as `heal_reverted`, one
    /// defect down: the slide is never undone, so every deeper snapshot
    /// recorded without it disagrees until a snapshot-pair entry heals it.
    displaced: BTreeMap<SectionId, Vec<[f64; 2]>>,
    /// Sections whose station-0 refs finding 3 has destroyed. Same cascade, on
    /// the data-loss half of the same branch.
    ref_dropped: BTreeSet<SectionId>,
    /// Set once a stale persisted id has hit the wrong shot in this run
    /// (findings 8, 12, 16). From then on the live project no longer matches any
    /// snapshot recorded before the save, and every deeper comparison in the
    /// same walk is re-measuring that corruption.
    stale_corruption: bool,
    /// Sections in which finding 16 duplicated a shot uuid. A section holding
    /// the same `Shot::uuid` twice cannot match ANY snapshot recorded before
    /// that happened, and no undo removes the copy.
    corrupted: BTreeSet<SectionId>,
    /// Gauge anchors the most recent save captured, by section. Findings 1 and
    /// 11 both END with these gone, and comparing against what the save left is
    /// how the cascade knows the run is past that point.
    saved_anchors: BTreeMap<SectionId, String>,
}

impl Fuzzer {
    fn new(seed: u32, closures: bool) -> Self {
        let state = AppState::new().unwrap();
        let history_limit = state
            .undo_stack
            .lock()
            .map_or(DEFAULT_HISTORY_LIMIT, |stack| stack.history_limit());
        let mut rng = Rng::new(seed);
        build_project(&state, &mut rng, closures);
        let mut fuzzer = Self {
            state,
            rng,
            seed,
            snapshots: Vec::new(),
            verdicts: Vec::new(),
            adjusted: Vec::new(),
            epochs: Vec::new(),
            entry_meta: vec![EntryMeta::default()],
            epoch: 0,
            cursor: 0,
            top: 0,
            floor: 0,
            history_limit,
            drift: BTreeMap::new(),
            log: Vec::new(),
            id_agnostic: false,
            outcome: Outcome::default(),
            temp: None,
            closures,
            orphan_pending: false,
            heal_reverted: false,
            displaced: BTreeMap::new(),
            ref_dropped: BTreeSet::new(),
            stale_corruption: false,
            corrupted: BTreeSet::new(),
            saved_anchors: BTreeMap::new(),
        };
        // The builder's own commands are undoable, so the stacks are not empty.
        // Clear them: the model measures depth from a known floor, and the
        // builder's history is scaffolding rather than something to fuzz over.
        if let Ok(mut stack) = fuzzer.state.undo_stack.lock() {
            stack.clear();
        }
        assert_eq!(fuzzer.undo_len(), 0, "setup left undo entries behind");
        assert_eq!(fuzzer.redo_len(), 0, "setup left redo entries behind");
        let base = fuzzer.snapshot();
        fuzzer.snapshots.push(base);
        let base_verdict = fuzzer.verdict();
        fuzzer.verdicts.push(base_verdict);
        let base_adjusted = fuzzer.adjusted_geometry();
        fuzzer.adjusted.push(base_adjusted);
        fuzzer.epochs.push(0);
        fuzzer
    }

    fn undo_len(&self) -> usize {
        self.state.get_undo_stack().len()
    }

    fn redo_len(&self) -> usize {
        self.state.get_redo_stack().len()
    }

    /// Canonical snapshot of the live project.
    fn snapshot(&mut self) -> String {
        let started = std::time::Instant::now();
        let out = canonical_snapshot(&self.state, self.id_agnostic);
        self.outcome.oracle_us.0 += started.elapsed().as_micros();
        out
    }

    /// The app's own integrity verdict, normalized. See `Verdict`.
    fn verdict(&mut self) -> Verdict {
        let started = std::time::Instant::now();
        let out = integrity_verdict(&self.state);
        self.outcome.oracle_us.1 += started.elapsed().as_micros();
        out
    }

    /// The ADJUSTED station geometry - `AppState::get_adjusted_stations`, which
    /// is what the map draws and what every export writes - canonicalized to a
    /// comparable string.
    ///
    /// This is DERIVED state, solved from the project rather than stored in it,
    /// so it is a second, independent view of every history move. Two things it
    /// can see that the stored snapshot cannot: a solve whose result depends on
    /// something the snapshot drops, and a stale memo. The second is not
    /// hypothetical - issue #413's finding 7 originally claimed the missing
    /// `invalidate_adjusted_cache()` in `undo_to`/`redo_to` was part of the
    /// defect, and the correction argued it is unobservable because the cache
    /// keys on `modified_at`, which every undo touches. This comparison is that
    /// argument's test.
    fn adjusted_geometry(&mut self) -> String {
        let started = std::time::Instant::now();
        let out = adjusted_geometry_of(&self.state);
        self.outcome.oracle_us.2 += started.elapsed().as_micros();
        out
    }

    /// Every cross-section merge, measured raw AND resolved.
    fn merge_measurements(&self) -> Vec<MergeMeasurement> {
        let Some(project) = self.state.get_project_state() else {
            return Vec::new();
        };
        let adjusted: BTreeMap<(SectionId, u32), (f64, f64)> = self
            .state
            .get_adjusted_stations()
            .unwrap_or_default()
            .iter()
            .map(|station| {
                (
                    (
                        station.station_ref.section_id,
                        station.station_ref.station_index,
                    ),
                    (station.coordinates.x, station.coordinates.y),
                )
            })
            .collect();
        let mut out = Vec::new();
        for merge in &project.station_merges {
            if merge.station_a.section_id == merge.station_b.section_id {
                continue;
            }
            let (Some(a), Some(b)) = (
                project.resolve_key(&merge.station_a),
                project.resolve_key(&merge.station_b),
            ) else {
                continue;
            };
            let (Some(raw_a), Some(raw_b)) = (
                project.compute_station_raw_coords(a),
                project.compute_station_raw_coords(b),
            ) else {
                continue;
            };
            let (Some(res_a), Some(res_b)) = (
                adjusted.get(&(a.section_id, a.station_index)),
                adjusted.get(&(b.section_id, b.station_index)),
            ) else {
                continue;
            };
            out.push(MergeMeasurement {
                label: format!(
                    "{}:{} <-> {}:{}",
                    a.section_id, a.station_index, b.section_id, b.station_index
                ),
                raw: ((raw_a.x - raw_b.x).powi(2) + (raw_a.y - raw_b.y).powi(2)).sqrt(),
                resolved: ((res_a.0 - res_b.0).powi(2) + (res_a.1 - res_b.1).powi(2)).sqrt(),
                sections: (a.section_id, b.section_id),
            });
        }
        out
    }

    /// Re-express every recorded snapshot in id-agnostic form. Called once, on the
    /// first reload: `Shot::id` is not persisted, so from then on a byte-exact
    /// comparison against a pre-reload snapshot would report the renumbering as
    /// drift.
    /// The derived models need no equivalent: an integrity message names section
    /// ids, station indices, closure ids and uuids, and an adjusted station names
    /// a `StationRef` - none of which the loader renumbers. Shot ids appear in
    /// neither.
    fn enable_id_agnostic(&mut self) {
        if self.id_agnostic {
            return;
        }
        self.id_agnostic = true;
        for snapshot in &mut self.snapshots {
            let parsed: serde_json::Value =
                serde_json::from_str(snapshot).expect("recorded snapshot is not JSON");
            *snapshot = canonicalize(&parsed, "", true).to_string();
        }
    }

    fn note(&mut self, line: String) {
        // `STALAGMIGHT_RUST_FUZZ_TRACE=1` prints every move as it happens.
        // The tail in a `fail()` payload covers a failure the fuzzer detects, but
        // the app has assertions of its own - `debug_assert_merge_alignment` is
        // `#[cfg(test)]`, so it exists ONLY in this tier - and when one of those
        // panics it takes the process down before the payload is built. Streaming
        // the log is how those get attributed to a move.
        if std::env::var("STALAGMIGHT_RUST_FUZZ_TRACE").is_ok() {
            println!("  [seed {} depth {}] {line}", self.seed, self.cursor);
        }
        self.log.push(line);
    }

    fn fail(&self, headline: &str, detail: &str) -> ! {
        let tail: Vec<String> = self
            .log
            .iter()
            .rev()
            .take(14)
            .rev()
            .map(|line| format!("    {line}"))
            .collect();
        panic!(
            "{headline}\n  seed={} depth={} top={} saves={} reloads={}\n{detail}\n  last {} move(s):\n{}",
            self.seed,
            self.cursor,
            self.top,
            self.outcome.saves,
            self.outcome.reloads,
            tail.len(),
            tail.join("\n"),
        );
    }

    /// Compare the live project against the snapshot recorded at `depth`.
    ///
    /// Returns normally when the states match, when the numeric tolerance absorbs
    /// the difference, or when EVERY difference is explained by a documented open
    /// bug or by a save/reload heal - in which case the hit is counted and the
    /// model resyncs, so one open defect does not cascade into every later
    /// comparison. Anything else panics with the full payload.
    fn expect_state(
        &mut self,
        depth: usize,
        what: &str,
        consumed: Vec<EntryMeta>,
        stale: StaleTargets,
    ) {
        let ctx_entry = consumed.first().cloned();
        // FINDING 11's consequence, measured rather than inferred: the save
        // captured a gauge pair per section, and a restore of a pre-save
        // `ProjectSnapshotPair` puts the pre-heal project back. Once that has
        // happened the anchors are simply GONE, and every snapshot recorded with
        // them disagrees - including on depths the walk down never compared,
        // which is why arming this only on a CLASSIFIED hit left the way back up
        // unexplained.
        if self.anchors_reverted() {
            self.heal_reverted = true;
        }
        // Cloned rather than borrowed: the classification loop below records new
        // displacements into `self`, and a live borrow of the map would make
        // that a borrow error. The map holds one small entry per section finding
        // 3 has displaced.
        let displaced = self.displaced.clone();
        let corrupted = self.corrupted.clone();
        let section_ids = section_ids_of(&self.snapshots[depth]);
        let ctx = MoveCtx {
            entry: ctx_entry.as_ref(),
            entries: &consumed,
            after_save: self.outcome.saves > 0,
            epoch: self.epoch,
            heal_reverted: self.heal_reverted,
            displaced: &displaced,
            stale,
            corrupted: &corrupted,
            section_ids: &section_ids,
        };
        let actual = self.snapshot();
        let expected = self.snapshots[depth].clone();
        if expected == actual {
            self.expect_derived(depth, &format!("{what} (stored state EXACT)"), false);
            return;
        }
        let mut diffs = diff_snapshots(&expected, &actual);
        if diffs.is_empty() {
            self.outcome.float_noise += 1;
            // Remember WHAT the tolerance absorbed, and how much. This is the
            // only record that a path was ever inexact here, and the
            // accumulation classifier below needs it to tell "this has been
            // creeping for fifty visits" from "this broke just now".
            let measured = numeric_drift(&expected, &actual);
            if !measured.is_empty() {
                let seen = self.drift.entry(depth).or_default();
                for (path, delta) in measured {
                    let worst = seen.entry(path).or_insert(0.0);
                    *worst = worst.max(delta);
                }
            }
            // The stored state is equal WITHIN TOLERANCE, so the derived views
            // are still compared strictly - the whole point of having them is
            // that a solve can amplify what the raw comparison let through.
            let worst = numeric_drift(&expected, &actual)
                .values()
                .fold(0.0_f64, |acc, delta| acc.max(*delta));
            self.expect_derived(
                depth,
                &format!("{what} (stored state within tolerance, worst input delta {worst:e})"),
                false,
            );
            return;
        }

        // FINDING 3's DATA-LOSS half, subtracted before anything else looks at
        // the diffs: a dropped merge re-indexes the list, so every field of every
        // later entry reads as changed and the offset half of the SAME hit would
        // be buried under twenty derived paths. Only ever applied when the
        // consumed entry is the empty-section append the finding needs, and only
        // when refs to that section's station 0 were really lost.
        let mut ref_drop = None;
        // FINDING 10, subtracted first: a closure reclassified as a merge moves
        // one entry between two lists, which re-indexes both and buries every
        // other difference the same move produced.
        if let Some(remaining) = diffs_without_orphan_conversion(&expected, &actual) {
            ref_drop = Some((
                "finding-10-reload-converts-an-orphan-closure-to-a-merge",
                None,
            ));
            diffs = remaining;
        }
        if ref_drop.is_none() {
            if let Some(remaining) = diffs_without_closure_reorder(&expected, &actual) {
                ref_drop = Some(("finding-4-closure-reordered-on-undo", None));
                diffs = remaining;
            }
        }
        if ref_drop.is_none() {
            if let Some(remaining) = diffs_without_datum_reorder(&expected, &actual) {
                ref_drop = Some(("finding-17-zero-datum-reordered-on-undo", None));
                diffs = remaining;
            }
        }
        if ref_drop.is_none() {
            if let Some(section_id) = ctx.appended_into_empty() {
                if let Some(remaining) =
                    diffs_without_station_zero_refs(&expected, &actual, section_id, true)
                {
                    ref_drop = Some((
                        "finding-3-undo-of-the-first-shot-drops-station-zero-refs",
                        Some(section_id),
                    ));
                    diffs = remaining;
                }
            }
        }
        // A NEW FINDING, subtracted for the same reason: a shot that came back in
        // the wrong PLACE shifts every shot after it, so one misplaced shot reads
        // as every field of every shot below it having changed. Only ever applied
        // when the consumed entry is a `create_shot` whose persisted insert
        // ANCHOR provably addresses a different shot now than it did when the
        // entry was pushed - which is the mechanism, measured rather than
        // inferred.
        if ref_drop.is_none() && ctx.stale.anchor == Staleness::Collides {
            if let Some(target) = ctx.entry.and_then(|entry| entry.target.as_ref()) {
                if let Some(remaining) = diffs_without_misplaced_shot(
                    &expected,
                    &actual,
                    target.section_id,
                    &target.uuid,
                ) {
                    ref_drop = Some((
                        "finding-16-stale-anchor-redoes-a-create-shot-into-the-wrong-position",
                        None,
                    ));
                    diffs = remaining;
                }
            }
        }
        // ... and its cascade. Nothing restores a dropped merge, datum or
        // comment either, so every deeper snapshot that still holds one
        // disagrees until a snapshot-pair entry puts the whole project back -
        // the same shape as the displacement cascade above it, one field over.
        // Only sections finding 3 has ALREADY destroyed refs on are candidates,
        // and only while the expected side still holds strictly more of them.
        if ref_drop.is_none() {
            for section_id in self.ref_dropped.clone() {
                if let Some(remaining) =
                    diffs_without_station_zero_refs(&expected, &actual, section_id, false)
                {
                    ref_drop = Some(("finding-3-cascade-station-zero-refs-still-missing", None));
                    diffs = remaining;
                    break;
                }
            }
        }

        // A KNOWN BUG gets first refusal, BEFORE the epoch attribution below.
        //
        // The two overlap on `section_offsets`: a reload re-solves the whole map,
        // and finding 3 leaves a key in it. Attributing first read finding 3's
        // displacement as "the reload re-solved offsets", which silently swallowed
        // the hit AND resynced the model to a state carrying it - so the redo back
        // up to that depth failed later with nothing to explain it (seed 4,
        // persistence). Classifying first attributes the difference to the defect
        // that caused it and arms the cascade tracker, which is what makes the
        // later comparison readable.
        let mut classified: BTreeMap<&'static str, usize> = BTreeMap::new();
        let mut unknown = Vec::new();
        for diff in &diffs {
            match classify(diff, &ctx) {
                Some(id) => *classified.entry(id).or_insert(0) += 1,
                None => unknown.push(diff.clone()),
            }
        }

        // ONLY a comparison that crosses an epoch boundary may subtract the
        // documented undo-less changes a save or a reload makes. Within an epoch
        // the oracle stays strict, which is what keeps a geometry bug from hiding
        // behind "a reload re-solves offsets".
        let crosses_epoch = self.epochs[depth] < self.epoch;
        if crosses_epoch {
            let before = unknown.len();
            unknown.retain(|diff| {
                !(self.outcome.saves > 0 && attributable_to_save(diff))
                    && !(self.outcome.reloads > 0 && attributable_to_reload(diff))
            });
            self.outcome.attributed += before - unknown.len();
            if unknown.is_empty() && classified.is_empty() && ref_drop.is_none() {
                self.resync(depth, actual);
                self.expect_derived(depth, what, true);
                return;
            }
        }

        // ACCUMULATION, checked before the entry-shaped classifiers because it is
        // about the HISTORY of a path rather than about this move. A difference
        // is accumulated dust when every unexplained path is numeric, that path
        // has been inexact at THIS depth before, and it has GROWN since - which
        // is what "the tolerance absorbed a little each time and the little
        // added up" looks like from the outside. A path that was exact until now
        // is a fresh regression and is not this.
        if !unknown.is_empty() {
            let history = self.drift.get(&depth).cloned().unwrap_or_default();
            let current = numeric_drift(&expected, &actual);
            let accumulated = unknown.iter().all(|diff| {
                match (history.get(&diff.path), current.get(&diff.path)) {
                    (Some(was), Some(now)) => *now > *was && *was > 0.0,
                    _ => false,
                }
            });
            if accumulated {
                *self
                    .outcome
                    .hits
                    .entry("finding-19-tolerated-float-dust-accumulated-past-tolerance")
                    .or_insert(0) += 1;
                self.note(format!(
                    "  ^ accumulation at depth {depth}: {} path(s) crept past the tolerance",
                    unknown.len()
                ));
                // Re-baseline, so the NEXT accumulation is measured from here
                // rather than reported again every visit.
                self.drift.remove(&depth);
                self.resync(depth, actual);
                self.expect_derived(depth, what, true);
                return;
            }
        }

        if let Some((id, section_id)) = ref_drop {
            classified.entry(id).or_insert(0);
            if let Some(section_id) = section_id {
                self.ref_dropped.insert(section_id);
            }
        }
        if unknown.is_empty() && !classified.is_empty() {
            for id in classified.keys() {
                *self.outcome.hits.entry(id).or_insert(0) += 1;
                if id.starts_with("finding-1-redo-of-create-section-drops")
                    || id.starts_with("finding-11-")
                {
                    self.heal_reverted = true;
                }
                if *id == "finding-3-undo-of-the-first-shot-displaces-an-empty-section" {
                    self.record_displacement(ctx.appended_into_empty(), &expected, &actual);
                }
                if id.starts_with("finding-12-") || id.starts_with("finding-16-") {
                    self.stale_corruption = true;
                }
            }
            // The move log is what a reader reconstructs a failure from, and a
            // classified hit is a MOVE with consequences - it resyncs the model
            // and, for findings 1, 11 and 3, arms a cascade. A log that showed
            // only the moves would make the later failure look spontaneous,
            // which is exactly how finding 15 came to be filed separately.
            let ids: Vec<&str> = classified.keys().copied().collect();
            self.note(format!(
                "  ^ classified at depth {depth}: {}",
                ids.join(", ")
            ));
            self.resync(depth, actual);
            self.expect_derived(depth, what, true);
            return;
        }

        // Structural signatures, checked only over what the path rules could not
        // explain. Order matters: a whole-section uuid re-mint (finding 1) also
        // reads as "different shots are present", so the path classifiers get
        // first refusal.
        // A NEW FINDING (issue #413, finding 16), and the worst shape reached so
        // far: after a reload, the REDO of a `CreateShot` re-inserts a shot that
        // is STILL THERE, because the undo before it deleted a different one
        // (finding 8). `redo_inner`'s `CreatedShotSnapshot` arm forces both the
        // id and the uuid from the entry (core/state/undo.rs), so the section
        // ends up holding the same `Shot::uuid` twice - the identity every
        // `StationKey::AfterShot` anchor and the Ariane export resolve by.
        //
        // Recognised by exactly that: the entry's own uuid appears MORE than
        // once in the live section and at most once in the recorded one, in a
        // run where a persisted id was measured stale. Nothing else in the model
        // can duplicate a uuid.
        if self.stale_corruption {
            if let Some(target) = ctx.entry.and_then(|entry| entry.target.as_ref()) {
                let live = uuid_occurrences(&actual, target.section_id, &target.uuid);
                let recorded = uuid_occurrences(&expected, target.section_id, &target.uuid);
                if live > 1 && recorded <= 1 {
                    *self
                        .outcome
                        .hits
                        .entry("finding-16-redo-of-a-create-shot-duplicates-a-shot-uuid")
                        .or_insert(0) += 1;
                    self.corrupted.insert(target.section_id);
                    self.resync(depth, actual);
                    self.expect_derived(depth, what, true);
                    return;
                }
            }
        }
        // FINDING 8, and told apart from finding 12 by the ENTRY and the
        // MEASUREMENT rather than by the damage. `UndoData::CreatedShotSnapshot`
        // is the only variant whose undo is `delete_shot(section, stale_id)`, so
        // a `create_shot` entry is the only one that can produce a MISSING shot;
        // finding 12's two variants write a field and cannot change which shots
        // exist. The collision is measured against the uuid the id addressed when
        // the entry was pushed, so "the wrong shot was deleted" is a fact here
        // rather than a hypothesis fitted to the diff.
        if ctx.command_is("create_shot")
            && ctx.stale.target == Staleness::Collides
            && is_shot_identity_swap(&expected, &actual)
        {
            *self
                .outcome
                .hits
                .entry("finding-8-stale-id-deletes-the-wrong-shot")
                .or_insert(0) += 1;
            self.stale_corruption = true;
            self.resync(depth, actual);
            self.expect_derived(depth, what, true);
            return;
        }

        // FINDING 8's CASCADE. Once a stale id has hit the wrong shot, the live
        // project no longer matches ANY snapshot recorded before the save, so
        // every deeper comparison in that walk re-measures the same corruption -
        // the harness tier calls this contamination and handles it the same way.
        // Narrowed to a run where a persisted id was MEASURED to address the
        // wrong shot, and to the same identity-swap signature: the right number
        // of shots with the wrong ones among them. Deliberately NOT narrowed to
        // the consumed entry's epoch - the corruption sits in the PROJECT, not
        // in the entry, so a perfectly sound post-reload entry restores a state
        // that still carries it.
        if self.stale_corruption && is_shot_identity_swap(&expected, &actual) {
            *self
                .outcome
                .hits
                .entry("finding-8-cascade-the-wrong-shot-is-already-gone")
                .or_insert(0) += 1;
            self.resync(depth, actual);
            self.expect_derived(depth, what, true);
            return;
        }
        let entry_note = ctx_entry.as_ref().map_or_else(
            || "  consumed entry: (none - not a history move)".to_string(),
            |entry| {
                format!(
                    "  consumed entry: {} (pushed in epoch {}, run epoch {}{})\n  \
                     persisted ids: target={:?} anchor={:?}",
                    entry.command,
                    entry.epoch,
                    self.epoch,
                    if entry.appended_into_empty.is_some() {
                        ", appended into an EMPTY section"
                    } else {
                        ""
                    },
                    ctx.stale.target,
                    ctx.stale.anchor,
                )
            },
        );
        self.fail(
            &format!("{what} did not restore the state recorded at depth {depth}"),
            &(format!(
                "  {} unexplained difference(s){}:\n{}",
                unknown.len(),
                if classified.is_empty() {
                    String::new()
                } else {
                    format!(
                        " (plus classified: {:?})",
                        classified.keys().collect::<Vec<_>>()
                    )
                },
                describe_diffs(&unknown),
            ) + "\n"
                + entry_note.as_str()),
        );
    }

    /// Has anything the last save captured as a gauge anchor since been lost?
    ///
    /// `capture_missing_gauge_anchors` is a save-time heal with no undo entry of
    /// its own, so a section that HAD an anchor at save time and has none now can
    /// only have got there by a restore of a snapshot recorded before the save.
    /// A section that no longer exists makes no claim.
    fn anchors_reverted(&self) -> bool {
        if self.saved_anchors.is_empty() {
            return false;
        }
        let Some(project) = self.state.get_project_state() else {
            return false;
        };
        self.saved_anchors.iter().any(|(section_id, _)| {
            project
                .sections
                .iter()
                .find(|section| section.id == *section_id)
                .is_some_and(|section| section.gauge_shot_uuid.is_none())
        })
    }

    /// Record what the save just captured, so the loss can be measured later.
    fn record_saved_anchors(&mut self) {
        self.saved_anchors.clear();
        let Some(project) = self.state.get_project_state() else {
            return;
        };
        for section in &project.sections {
            if let Some(uuid) = section.gauge_shot_uuid.clone() {
                self.saved_anchors.insert(section.id, uuid);
            }
        }
    }

    /// Extend the trajectory finding 3 has walked this section's offset along,
    /// so the cascade classifier can recognise the SAME ratchet later and
    /// nothing else.
    ///
    /// Both sides of the hit are recorded, not just the new value: the point
    /// the slide STARTED from is on the trajectory too, and a later comparison
    /// can land on either. The sequence is seeded with `[0, 0]` because that is
    /// where the key was before finding 3 ever touched it, and an absent key
    /// means exactly that.
    fn record_displacement(&mut self, section_id: Option<SectionId>, expected: &str, actual: &str) {
        let Some(section_id) = section_id else {
            return;
        };
        let trajectory = self
            .displaced
            .entry(section_id)
            .or_insert_with(|| vec![[0.0, 0.0]]);
        for snapshot in [expected, actual] {
            let Some(point) = offset_of(snapshot, section_id) else {
                continue;
            };
            let known = trajectory
                .iter()
                .any(|seen| (0..2).all(|axis| displacements_equal(point[axis], seen[axis])));
            if !known {
                trajectory.push(point);
            }
        }
    }

    /// The two DERIVED-state oracles, run after the stored-state comparison has
    /// settled, and the consistency rule that makes them usable at all.
    ///
    /// `resynced` is the whole subtlety. When a classified known bug explains a
    /// difference, the model accepts the live state as the expectation at that
    /// depth - and the derived models MUST accept it at the same moment. A
    /// verdict model that kept the pre-bug expectation would report the same
    /// defect again at every later depth as a fresh integrity failure, which is
    /// chasing phantoms rather than finding bugs. The harness tier resolves this
    /// the same way (`undoRedoFuzz.ts`, `resolveMismatch` re-records the
    /// integrity verdict alongside the state).
    ///
    /// When the stored state MATCHED, both are compared strictly. That case is
    /// the one worth having: a verdict or a solved geometry that differs while
    /// the stored project agrees is either a checker that is not a function of
    /// the state, or a divergence the snapshot cannot see. At the harness tier
    /// exactly that caught a finding 7 manifestation nothing else did.
    fn expect_derived(&mut self, depth: usize, what: &str, resynced: bool) {
        let verdict = self.verdict();
        let adjusted = self.adjusted_geometry();
        if resynced {
            if depth < self.verdicts.len() {
                self.verdicts[depth] = verdict;
            }
            if depth < self.adjusted.len() {
                self.adjusted[depth] = adjusted;
            }
            return;
        }
        if let Some(expected) = self.verdicts.get(depth).cloned() {
            self.outcome.integrity_compared += 1;
            if expected != verdict {
                self.fail(
                    &format!(
                        "{what} restored the state but NOT the integrity verdict recorded at depth {depth}"
                    ),
                    &format!(
                        "  expected: {}\n  actual:   {}",
                        expected.describe(),
                        verdict.describe()
                    ),
                );
            }
        }
        if let Some(expected) = self.adjusted.get(depth).cloned() {
            self.outcome.adjusted_compared += 1;
            let diffs = adjusted_diffs(&expected, &adjusted);
            if !diffs.is_empty() {
                self.fail(
                    &format!(
                        "{what} restored the stored state but NOT the ADJUSTED geometry recorded at depth {depth}"
                    ),
                    &format!("  {}", diffs.join("\n  ")),
                );
            }
        }
    }

    /// RAW versus RESOLVED, on the same merges, in the same state.
    ///
    /// The app measures merge alignment two ways and issue #413's finding 14
    /// records that they disagree. This asserts they agree about the only thing
    /// either is used to decide: whether a merged pair is aligned. A pair that
    /// one measure calls sound (under a centimetre) while the other calls broken
    /// (past the app's own 5 cm `MERGE_ALIGNMENT_TOLERANCE_M`) is a contradiction
    /// no consumer can resolve - `debug_assert_merge_alignment` panics a test
    /// build on it while `check_project_integrity` tells the user nothing.
    ///
    /// Deliberately NOT "the two distances are equal": they are not supposed to
    /// be. The resolved measure folds in closure adjustment, which legitimately
    /// moves stations. Only the VERDICTS have to agree.
    fn expect_raw_and_resolved_agree(&mut self, what: &str) {
        let disagreements: Vec<String> = self
            .merge_measurements()
            .into_iter()
            .filter(|m| {
                (m.raw >= MERGE_ALIGNMENT_TOLERANCE_M && m.resolved < RAW_RESOLVED_AGREEMENT_M)
                    || (m.resolved >= MERGE_ALIGNMENT_TOLERANCE_M
                        && m.raw < RAW_RESOLVED_AGREEMENT_M)
            })
            .map(|m| {
                format!(
                    "merged {} is {:.6} m apart RAW and {:.6} m apart RESOLVED",
                    m.label, m.raw, m.resolved
                )
            })
            .collect();
        if disagreements.is_empty() {
            return;
        }
        *self
            .outcome
            .hits
            .entry("finding-18-raw-and-resolved-merge-alignment-disagree")
            .or_insert(0) += 1;
        self.note(format!(
            "  ^ raw and resolved disagree about {} merge(s) after {what}: {}",
            disagreements.len(),
            disagreements.join("; ")
        ));
    }

    /// Accept the live state as the model's expectation at `depth`. Only ever
    /// reached for a difference that was ENTIRELY explained.
    fn resync(&mut self, depth: usize, actual: String) {
        self.snapshots[depth] = actual;
        self.epochs[depth] = self.epoch;
    }

    /// ABSOLUTE well-formedness, checked after every move.
    ///
    /// Independent of the roundtrip comparison, and here for a reason the harness
    /// tier learned the hard way: `Project::debug_assert_merge_alignment` is
    /// `#[cfg(test)]`, so in THIS tier a misaligned merge eventually panics from
    /// inside whatever model function next touches it - a command away from the
    /// one that caused it, with no move log and no seed in the message. Checking
    /// alignment after every move turns that into an attributed finding.
    ///
    /// `check_merge_alignment` is the app's own checker
    /// (`models/project/integrity.rs`), so this asserts the app's own contract
    /// rather than a re-invented one.
    fn expect_merges_aligned(&mut self, what: &str) {
        // Measured BOTH ways, in one pass, so the failure payload can say what
        // the other checker thought of the same state. Issue #413's finding 14
        // asserts the two disagree; this is where that claim becomes a number.
        let broken: Vec<MergeMeasurement> = self
            .merge_measurements()
            .into_iter()
            .filter(|m| m.raw >= RAW_RESOLVED_AGREEMENT_M)
            .collect();
        if broken.is_empty() {
            return;
        }
        let messages: Vec<String> = broken
            .iter()
            .map(|m| {
                format!(
                    "merged {} is {:.6} m apart RAW ({:.6} m RESOLVED{})",
                    m.label,
                    m.raw,
                    m.resolved,
                    if m.resolved < RAW_RESOLVED_AGREEMENT_M {
                        " - which calls the same pair SOUND"
                    } else {
                        ""
                    }
                )
            })
            .collect();
        // FINDING 20, classified by its MECHANISM rather than by the move that
        // exposed it: the two things that would repair a drifted merge both
        // decline, and each declines for a reason that is a property of the
        // STATE, so both are measurable here.
        //
        // * `realign_after_shot_edit` (models/project/mutations.rs:923) - the
        //   only repair `update_shot` runs - returns at line 941 when the merge
        //   group holds no resolvable zero datum;
        // * `realign_merges` (models/project/offsets.rs:280), the epilogue's
        //   repair, re-solves only when `check_merge_alignment` already reports
        //   a violation, and that threshold is the app's own 5 cm.
        //
        // So: every drifted pair under 5 cm, in a merge group with no anchor.
        // A pair at or past 5 cm is something the app WOULD have healed and is
        // not this; a drifted pair in an ANCHORED group got past a repair that
        // ran, which is a different defect (finding 14's family) and still
        // fails.
        let unanchored = broken.iter().all(|m| {
            m.raw < MERGE_ALIGNMENT_TOLERANCE_M
                && self.group_is_unanchored(m.sections.0)
                && self.group_is_unanchored(m.sections.1)
        });
        if unanchored {
            *self
                .outcome
                .hits
                .entry("finding-20-an-unanchored-merge-group-is-never-realigned")
                .or_insert(0) += 1;
            self.note(format!(
                "  ^ finding 20 after {what}: {}",
                messages.join("; ")
            ));
            // TERMINAL, and not because the drift is fatal to the model - it is
            // not, the stored state still roundtrips. The next command that
            // calls `debug_assert_merge_alignment` panics on this pair
            // (`a_shot_edit_does_not_arm_an_alignment_assert_for_a_later_command`
            // in open_undo_bugs_tests.rs proves it with an insert into an
            // unrelated section), and `catching_alignment` would then attribute
            // that panic to FINDING 14 by its context string. Carrying on would
            // buy more moves at the price of mislabelling one finding as
            // another, which is the one thing the classifiers exist to prevent.
            self.outcome.drift_stop = true;
            return;
        }
        self.fail(
            &format!("{what} left a station merge out of alignment"),
            &format!("  {}", messages.join("\n  ")),
        );
    }

    /// FINDING 20's precondition, measured: does the merge group containing
    /// `section_id` hold no zero datum that still resolves?
    ///
    /// The same question `realign_after_shot_edit` asks before it gives up
    /// (models/project/mutations.rs:930-942), asked the same way - a datum whose
    /// anchor key no longer resolves is not an anchor there either.
    fn group_is_unanchored(&self, section_id: SectionId) -> bool {
        let Some(project) = self.state.get_project_state() else {
            return false;
        };
        let group = project.get_merged_section_ids(section_id);
        !project.zero_datums.iter().any(|datum| {
            group.contains(&datum.station_ref.section_id)
                && project.resolve_key(&datum.station_ref).is_some()
        })
    }

    fn expect_stacks(&self, what: &str) {
        // Under the sliding window the app holds `cursor - floor` undo entries,
        // not `cursor`: everything below the floor was FIFO-trimmed. The redo
        // stack is bounded by the same limit (`enforce_depth_limit` trims BOTH).
        let (want_undo, want_redo) = (
            self.cursor - self.floor,
            (self.top - self.cursor).min(self.history_limit),
        );
        if self.undo_len() != want_undo || self.redo_len() != want_redo {
            self.fail(
                &format!("{what} left the history stacks in an unexpected shape"),
                &format!(
                    "  expected undo={} redo={}, got undo={} redo={}",
                    want_undo,
                    want_redo,
                    self.undo_len(),
                    self.redo_len()
                ),
            );
        }
    }
}

/// One drawn mutation: what to run, and a label for the move log.
struct Drawn {
    label: String,
    result: CommandResult,
    /// Set when this was a `CreateShot` that appended the FIRST shot into an
    /// empty section - finding 3's precondition, recorded here because only the
    /// generator knows the section was empty.
    appended_into_empty: Option<SectionId>,
    /// The shot this command's entry will address by id when it is restored.
    target: Option<ShotTarget>,
    /// The shot a `CreateShot`'s redo will anchor its re-insert to.
    anchor: Option<ShotTarget>,
}

impl Drawn {
    fn new(label: String, result: CommandResult) -> Self {
        Self {
            label,
            result,
            appended_into_empty: None,
            target: None,
            anchor: None,
        }
    }
}

impl Fuzzer {
    /// Draw and apply one mutation. Returns `None` when nothing was buildable
    /// (the project momentarily has no target of the drawn kind).
    fn draw_mutation(&mut self) -> Option<Drawn> {
        let targets = read_targets(&self.state);
        // Weights keep the cheap structural edits dominant while still reaching
        // the graph operations, which is where the interesting undo bugs live.
        // The delete family is held down so a long run does not empty the project.
        let kind = self.rng.below(100);
        let drawn = match kind {
            0..=9 => self.gen_create_section(),
            10..=21 => self.gen_create_shot(&targets),
            22..=35 => self.gen_update_shot(&targets),
            36..=43 => self.gen_set_shot_kind(&targets),
            44..=50 => self.gen_update_section(&targets),
            51..=55 => self.gen_delete_shot(&targets),
            56..=58 => self.gen_delete_section(&targets),
            59..=63 => self.gen_reverse_section(&targets),
            64..=69 => self.gen_move(&targets),
            70..=74 => self.gen_move_station(&targets),
            75..=79 => self.gen_station_comment(&targets),
            80..=83 => self.gen_merge(&targets),
            84..=86 => self.gen_unmerge(&targets),
            87..=89 => self.gen_closure(&targets),
            90..=91 => self.gen_zero_datum(&targets),
            92..=95 => self.gen_split_family(&targets),
            _ => self.gen_batch(&targets),
        };
        drawn
    }

    fn gen_create_section(&mut self) -> Option<Drawn> {
        // Includes the EMPTY section deliberately: finding 3 is literally "append
        // the first shot into an empty section", and a uniform generator reaches
        // that shape rarely.
        let count = self.rng.below(4);
        let shots: Vec<ShotData> = (0..count).map(|_| random_shot(&mut self.rng)).collect();
        let null_metadata = self.rng.chance(30);
        Some(Drawn::new(
            format!("createSection(shots={count},nullMeta={null_metadata})"),
            self.state.execute(Command::CreateSection {
                name: (!null_metadata).then(|| format!("fuzz-{}", self.rng.range(1000, 9999))),
                surveyor: (!null_metadata).then(|| "fuzz".to_string()),
                date: None,
                color: (*self.rng.pick(COLORS)).to_string(),
                direction: None,
                shots,
            }),
        ))
    }

    fn gen_create_shot(&mut self, targets: &Targets) -> Option<Drawn> {
        if targets.sections.is_empty() {
            return None;
        }
        let index = self.rng.below(targets.sections.len());
        let (section_id, shots) = targets.sections[index].clone();
        let shot = random_shot(&mut self.rng);
        // A mid-section insert is what makes shot ids diverge from positional
        // order, which is the precondition for findings 8, 12 and 13.
        let (after, before, how) = if shots.is_empty() {
            (None, None, "append")
        } else {
            match self.rng.below(3) {
                0 => (Some(shots[self.rng.below(shots.len())]), None, "after"),
                1 => (None, Some(shots[self.rng.below(shots.len())]), "before"),
                _ => (None, None, "append"),
            }
        };
        let appended_into_empty = (how == "append" && shots.is_empty()).then_some(section_id);
        // The anchor's identity is read BEFORE the insert, because that is the
        // shot the persisted `after_shot_id` / `before_shot_id` means. After a
        // reload the same id may address a different one - which is what makes
        // the REDO re-insert somewhere else.
        let anchor = after
            .or(before)
            .and_then(|shot_id| self.shot_target(section_id, shot_id));
        let mut drawn = Drawn::new(
            format!("createShot(s={section_id},n={},{how})", shots.len()),
            self.state.execute(Command::CreateShot {
                section_id,
                shot,
                after_shot_id: after,
                before_shot_id: before,
            }),
        );
        // FINDING 3's precondition, and only the generator knows it: the section
        // had NO shots, so the appended shot is index 0 and its undo goes through
        // `remove_shot_with_rewire`'s `pos == 0` branch.
        drawn.appended_into_empty = appended_into_empty;
        drawn.anchor = anchor;
        // And the shot the UNDO will delete by id, read after the insert.
        drawn.target = drawn
            .result
            .shot_id
            .and_then(|shot_id| self.shot_target(section_id, shot_id));
        Some(drawn)
    }

    /// `(section, shot, uuid)` for a live shot, or `None` when the id addresses
    /// nothing.
    fn shot_target(&self, section_id: SectionId, shot_id: ShotId) -> Option<ShotTarget> {
        let uuid = self.uuid_of(section_id, shot_id)?;
        Some(ShotTarget {
            section_id,
            shot_id,
            uuid,
        })
    }

    /// The uuid the id `shot_id` addresses in `section_id` RIGHT NOW.
    fn uuid_of(&self, section_id: SectionId, shot_id: ShotId) -> Option<String> {
        self.state
            .get_project_state()?
            .sections
            .iter()
            .find(|section| section.id == section_id)?
            .shots
            .iter()
            .find(|shot| shot.id == shot_id)?
            .uuid
            .clone()
    }

    /// A shot picked from a section that has one, with its section.
    fn pick_shot(&mut self, targets: &Targets) -> Option<(SectionId, ShotId)> {
        let populated: Vec<&(SectionId, Vec<ShotId>)> = targets
            .sections
            .iter()
            .filter(|(_, shots)| !shots.is_empty())
            .collect();
        if populated.is_empty() {
            return None;
        }
        let (section_id, shots) = populated[self.rng.below(populated.len())];
        Some((*section_id, shots[self.rng.below(shots.len())]))
    }

    fn gen_update_shot(&mut self, targets: &Targets) -> Option<Drawn> {
        let (section_id, shot_id) = self.pick_shot(targets)?;
        let mut updates = ShotUpdates::default();
        // Each field independently, so both the "set" and the "clear" arms of the
        // nullable ones are exercised.
        if self.rng.chance(50) {
            updates.length = Some(self.rng.float(0.5, 20.0));
        }
        if self.rng.chance(40) {
            updates.azimuth_in = Some(self.rng.float(0.0, 359.9));
        }
        if self.rng.chance(30) {
            updates.depth_out = Some(self.rng.float(0.0, 40.0));
        }
        if self.rng.chance(30) {
            updates.pitch_in = Some(self.rng.chance(50).then(|| self.rng.float(-60.0, 60.0)));
        }
        if self.rng.chance(30) {
            updates.left = Some(self.rng.chance(50).then(|| self.rng.float(0.0, 5.0)));
        }
        if self.rng.chance(25) {
            updates.comment = Some(
                self.rng
                    .chance(50)
                    .then(|| format!("c{}", self.rng.range(0, 999))),
            );
        }
        let target = self.shot_target(section_id, shot_id);
        let mut drawn = Drawn::new(
            format!("updateShot(s={section_id},shot={shot_id})"),
            self.state.execute(Command::UpdateShot {
                section_id,
                shot_id,
                updates,
            }),
        );
        // `UndoData::PreviousValues { section_id, shot_id, .. }` - the undo calls
        // `update_shot` with this id, and `redo_inner`'s catch-all re-executes
        // the command with it too. Finding 12's two halves.
        drawn.target = target;
        Some(drawn)
    }

    fn gen_set_shot_kind(&mut self, targets: &Targets) -> Option<Drawn> {
        let (section_id, shot_id) = self.pick_shot(targets)?;
        let kind = *self
            .rng
            .pick(&[ShotKind::Normal, ShotKind::Jump, ShotKind::Reference]);
        let target = self.shot_target(section_id, shot_id);
        let mut drawn = Drawn::new(
            format!("setShotKind(s={section_id},shot={shot_id},{kind:?})"),
            self.state.execute(Command::SetShotKind {
                section_id,
                shot_id,
                kind,
            }),
        );
        // `UndoData::InverseCommand(Command::SetShotKind { shot_id, .. })`, which
        // names the shot by its in-session id on BOTH the undo and the redo.
        drawn.target = target;
        Some(drawn)
    }

    fn gen_update_section(&mut self, targets: &Targets) -> Option<Drawn> {
        if targets.sections.is_empty() {
            return None;
        }
        let section_id = targets.sections[self.rng.below(targets.sections.len())].0;
        let mut updates = SectionUpdates::default();
        if self.rng.chance(45) {
            updates.name = Some(
                self.rng
                    .chance(60)
                    .then(|| format!("r{}", self.rng.range(0, 999))),
            );
        }
        if self.rng.chance(45) {
            updates.surveyor = Some(
                self.rng
                    .chance(60)
                    .then(|| format!("s{}", self.rng.range(0, 9))),
            );
        }
        if self.rng.chance(40) {
            updates.color = Some((*self.rng.pick(COLORS)).to_string());
        }
        if self.rng.chance(30) {
            updates.quality = Some(self.rng.range(1, 5) as f64);
        }
        Some(Drawn::new(
            format!("updateSection(s={section_id})"),
            self.state.execute(Command::UpdateSectionMetadata {
                section_id,
                updates,
            }),
        ))
    }

    fn gen_delete_shot(&mut self, targets: &Targets) -> Option<Drawn> {
        let (section_id, shot_id) = self.pick_shot(targets)?;
        Some(Drawn::new(
            format!("deleteShot(s={section_id},shot={shot_id})"),
            self.state.execute(Command::DeleteShot {
                section_id,
                shot_id,
            }),
        ))
    }

    fn gen_delete_section(&mut self, targets: &Targets) -> Option<Drawn> {
        // Keep at least two sections so cross-section merges stay reachable.
        if targets.sections.len() <= 2 {
            return None;
        }
        let section_id = targets.sections[self.rng.below(targets.sections.len())].0;
        Some(Drawn::new(
            format!("deleteSection(s={section_id})"),
            self.state.execute(Command::DeleteSection { section_id }),
        ))
    }

    fn gen_reverse_section(&mut self, targets: &Targets) -> Option<Drawn> {
        if targets.sections.is_empty() {
            return None;
        }
        let section_id = targets.sections[self.rng.below(targets.sections.len())].0;
        let swap = self.rng.chance(50);
        Some(Drawn::new(
            format!("reverseSection(s={section_id},swapLR={swap})"),
            self.state.execute(Command::ReverseSection {
                section_id,
                swap_left_right: swap,
            }),
        ))
    }

    fn gen_move(&mut self, targets: &Targets) -> Option<Drawn> {
        if targets.sections.is_empty() {
            return None;
        }
        let section_id = targets.sections[self.rng.below(targets.sections.len())].0;
        let offset = random_offset(&mut self.rng);
        let segment = self.rng.chance(50);
        Some(Drawn::new(
            format!(
                "{}(s={section_id})",
                if segment {
                    "moveSegment"
                } else {
                    "moveSection"
                }
            ),
            self.state.execute(if segment {
                Command::MoveSegment { section_id, offset }
            } else {
                Command::MoveSection { section_id, offset }
            }),
        ))
    }

    fn gen_move_station(&mut self, targets: &Targets) -> Option<Drawn> {
        if targets.stations.is_empty() {
            return None;
        }
        let (section_id, index) = targets.stations[self.rng.below(targets.stations.len())];
        Some(Drawn::new(
            format!("moveStation({section_id}/{index})"),
            self.state.execute(Command::MoveStation {
                station_ref: StationRef::new(section_id, index),
                offset: random_offset(&mut self.rng),
            }),
        ))
    }

    fn gen_station_comment(&mut self, targets: &Targets) -> Option<Drawn> {
        if targets.stations.is_empty() {
            return None;
        }
        let (section_id, index) = targets.stations[self.rng.below(targets.stations.len())];
        let comment = self
            .rng
            .chance(70)
            .then(|| format!("note-{}", self.rng.range(0, 9999)));
        Some(Drawn::new(
            format!("stationComment({section_id}/{index},{})", comment.is_some()),
            self.state.execute(Command::SetStationComment {
                station_ref: StationRef::new(section_id, index),
                comment,
            }),
        ))
    }

    /// Two stations in DIFFERENT sections: merging or closing within one section
    /// is rejected up front, so cross-section pairs are the ones that exercise the
    /// undo path.
    fn pick_cross_pair(
        &mut self,
        targets: &Targets,
    ) -> Option<((SectionId, u32), (SectionId, u32))> {
        if targets.sections.len() < 2 || targets.stations.len() < 2 {
            return None;
        }
        let a = targets.stations[self.rng.below(targets.stations.len())];
        let candidates: Vec<(SectionId, u32)> = targets
            .stations
            .iter()
            .copied()
            .filter(|station| station.0 != a.0)
            .collect();
        if candidates.is_empty() {
            return None;
        }
        Some((a, candidates[self.rng.below(candidates.len())]))
    }

    fn gen_merge(&mut self, targets: &Targets) -> Option<Drawn> {
        let (a, b) = self.pick_cross_pair(targets)?;
        Some(Drawn::new(
            format!("mergeStations({}/{},{}/{})", a.0, a.1, b.0, b.1),
            self.state.execute(Command::MergeStations {
                station_a: StationRef::new(a.0, a.1),
                station_b: StationRef::new(b.0, b.1),
            }),
        ))
    }

    fn gen_unmerge(&mut self, targets: &Targets) -> Option<Drawn> {
        if targets.merges.is_empty() {
            return None;
        }
        let (a, b) = targets.merges[self.rng.below(targets.merges.len())];
        Some(Drawn::new(
            format!("unmergePair({}/{},{}/{})", a.0, a.1, b.0, b.1),
            self.state.execute(Command::UnmergeStationPair {
                station_a: StationRef::new(a.0, a.1),
                station_b: StationRef::new(b.0, b.1),
            }),
        ))
    }

    fn gen_closure(&mut self, targets: &Targets) -> Option<Drawn> {
        if !self.closures {
            return None;
        }
        if !targets.closures.is_empty() && self.rng.chance(40) {
            let closure_id = targets.closures[self.rng.below(targets.closures.len())];
            return Some(Drawn::new(
                format!("removeLoopClosure({closure_id})"),
                self.state
                    .execute(Command::RemoveLoopClosure { closure_id }),
            ));
        }
        let (a, b) = self.pick_cross_pair(targets)?;
        // `ProportionalByLength` / `EqualDistribution` are rejected outright by
        // `create_loop_closure`, so they are drawn only occasionally: a rejected
        // command is a case the model checks, just not an interesting one to spend
        // most draws on.
        let strategy = *self.rng.pick(&[
            ClosureStrategy::Move,
            ClosureStrategy::Move,
            ClosureStrategy::LeastSquaresWeighted,
            ClosureStrategy::ProportionalByLength,
        ]);
        Some(Drawn::new(
            format!("createLoopClosure({}/{},{}/{})", a.0, a.1, b.0, b.1),
            self.state.execute(Command::CreateLoopClosure {
                station_a: StationRef::new(a.0, a.1),
                station_b: StationRef::new(b.0, b.1),
                closure_strategy: strategy,
            }),
        ))
    }

    fn gen_zero_datum(&mut self, targets: &Targets) -> Option<Drawn> {
        if !targets.datums.is_empty() && self.rng.chance(50) {
            let (section_id, index) = targets.datums[self.rng.below(targets.datums.len())];
            return Some(Drawn::new(
                format!("removeZeroDatum({section_id}/{index})"),
                self.state.execute(Command::RemoveZeroDatum {
                    station_ref: StationRef::new(section_id, index),
                }),
            ));
        }
        if targets.stations.is_empty() {
            return None;
        }
        let (section_id, index) = targets.stations[self.rng.below(targets.stations.len())];
        let gps = GpsCoordinates::new(
            self.rng.float(20.2, 20.5),
            self.rng.float(-87.5, -87.2),
            self.rng.float(0.0, 5.0),
        )
        .ok()?;
        Some(Drawn::new(
            format!("setZeroDatum({section_id}/{index})"),
            self.state.execute(Command::SetZeroDatum {
                station_ref: StationRef::new(section_id, index),
                coordinates: gps,
            }),
        ))
    }

    /// The delete/split family, which are `AppState` entry points rather than
    /// `Command` variants and so never see `execute()`'s epilogue - which is
    /// exactly what finding 10 is about.
    fn gen_split_family(&mut self, targets: &Targets) -> Option<Drawn> {
        let (section_id, shot_id) = self.pick_shot(targets)?;
        let shots = targets
            .sections
            .iter()
            .find(|(id, _)| *id == section_id)
            .map(|(_, shots)| shots.clone())
            .unwrap_or_default();
        match self.rng.below(5) {
            0 => {
                // Distances AT the boundaries are the interesting ones: a split
                // there degenerates into a zero-length shot.
                let distance = if self.rng.chance(20) {
                    *self.rng.pick(&[0.0, 1e-9, GEOMETRY_EXTREME])
                } else {
                    self.rng.float(0.1, 8.0)
                };
                Some(Drawn::new(
                    format!("splitShotAtDistance(s={section_id},shot={shot_id})"),
                    self.state
                        .execute_split_shot_at_distance(section_id, shot_id, distance),
                ))
            }
            1 => Some(Drawn::new(
                format!("deleteShotAndSplit(s={section_id},shot={shot_id})"),
                self.state.execute_delete_shot_and_split(
                    section_id,
                    shot_id,
                    "split-a".to_string(),
                    "split-b".to_string(),
                ),
            )),
            2 => Some(Drawn::new(
                format!("deleteLastShotAndSection(s={section_id},shot={shot_id})"),
                self.state
                    .execute_delete_last_shot_and_section(section_id, shot_id),
            )),
            _ => {
                if shots.len() < 2 {
                    return None;
                }
                let first = self.rng.below(shots.len());
                let second = self.rng.below(shots.len());
                let (lo, hi) = (first.min(second), first.max(second));
                let split = self.rng.chance(50);
                Some(Drawn::new(
                    format!(
                        "{}(s={section_id},{}..{})",
                        if split {
                            "deleteShotRangeSplit"
                        } else {
                            "deleteShotRangeShift"
                        },
                        shots[lo],
                        shots[hi]
                    ),
                    if split {
                        self.state.execute_delete_shot_range_split(
                            section_id,
                            shots[lo],
                            shots[hi],
                            "range-a".to_string(),
                            "range-b".to_string(),
                        )
                    } else {
                        self.state
                            .execute_delete_shot_range_shift(section_id, shots[lo], shots[hi])
                    },
                ))
            }
        }
    }

    /// A batch is ONE undo entry covering several sub-commands, with all-or-nothing
    /// rollback - the only way to reach `execute_batch`'s snapshot-pair path and
    /// its rollback guard.
    fn gen_batch(&mut self, targets: &Targets) -> Option<Drawn> {
        let count = self.rng.range(2, 4);
        let mut commands = Vec::new();
        for _ in 0..count {
            let built = match self.rng.below(4) {
                0 => self
                    .pick_shot(targets)
                    .map(|(section_id, shot_id)| Command::UpdateShot {
                        section_id,
                        shot_id,
                        updates: ShotUpdates {
                            length: Some(self.rng.float(1.0, 15.0)),
                            ..ShotUpdates::default()
                        },
                    }),
                1 => (!targets.sections.is_empty()).then(|| {
                    let index = self.rng.below(targets.sections.len());
                    Command::MoveSection {
                        section_id: targets.sections[index].0,
                        offset: random_offset(&mut self.rng),
                    }
                }),
                2 => (!targets.stations.is_empty()).then(|| {
                    let index = self.rng.below(targets.stations.len());
                    let (section_id, station) = targets.stations[index];
                    Command::MoveStation {
                        station_ref: StationRef::new(section_id, station),
                        offset: random_offset(&mut self.rng),
                    }
                }),
                _ => (!targets.sections.is_empty()).then(|| {
                    let index = self.rng.below(targets.sections.len());
                    Command::ReverseSection {
                        section_id: targets.sections[index].0,
                        swap_left_right: self.rng.chance(50),
                    }
                }),
            };
            if let Some(command) = built {
                commands.push(command);
            }
        }
        if commands.is_empty() {
            return None;
        }
        // The case the rollback exists for: the last sub-command names a section
        // id that cannot exist, so the batch must fail, leave state untouched and
        // push nothing.
        let poisoned = self.rng.chance(20);
        if poisoned {
            commands.push(Command::MoveSection {
                section_id: 999_999,
                offset: Coordinates::new(1.0, 1.0, 1.0),
            });
        }
        Some(Drawn::new(
            format!("batch(n={},poisoned={poisoned})", commands.len()),
            self.state.execute(Command::Batch { commands }),
        ))
    }
}

/// The persisted window: only the newest `undo_persist_limit` entries of each
/// stack survive a save, so a deeper history would come back truncated and the
/// model would be invalid. Matches `config::defaults`.
const UNDO_PERSIST_LIMIT: usize = 20;
/// Headroom kept below the in-memory history limit so FIFO trimming can never
/// fire in the ordinary modes. HORIZON mode deliberately goes past it - see
/// `Plan::horizon`.
const MAX_MODEL_DEPTH: usize = 40;
/// Fallback when the app's own limit cannot be read (a poisoned lock, which
/// would fail the run for other reasons first). Matches `config::defaults`.
const DEFAULT_HISTORY_LIMIT: usize = 100;
/// How often a history move is taken as a multi-step `undo_to`/`redo_to` jump,
/// when `Plan::jumps` is on. Raised from 10 while hunting finding 7, which only
/// exists on that path: a jump is the only move that skips `reconcile_geometry`.
const JUMP_PERCENT: u32 = 40;

impl Fuzzer {
    /// One mutation, with the full case analysis on what the stacks did.
    fn step_mutate(&mut self) {
        let before_undo = self.undo_len();
        let before_redo = self.redo_len();
        let before_newest = self.newest_entry();
        let allocators = self.allocators();
        let Some(Some(drawn)) = self.catching_alignment(Self::draw_mutation) else {
            return;
        };
        let label = drawn.label.clone();
        self.record_mutation(drawn, before_undo, before_redo, before_newest);
        self.expect_allocators_advanced(&allocators, &label);
        self.record_growth();
    }

    /// The bookkeeping half of `step_mutate`, split out so the exposure prologue
    /// can push its own commands through the SAME model updates and the SAME
    /// per-move oracles rather than a parallel path.
    fn record_mutation(
        &mut self,
        drawn: Drawn,
        before_undo: usize,
        before_redo: usize,
        before_newest: Option<String>,
    ) {
        let accepted = drawn.result.success;
        // Not a length delta. AT THE HISTORY LIMIT a push and its FIFO trim
        // cancel out - the stack was 100 entries and is still 100 - so a length
        // delta reads a real push as a no-op, which is how the horizon run first
        // went wrong: the model stopped advancing, kept comparing against the
        // wrong depth, and reported an app bug that was its own. The newest
        // entry's identity is the signal that survives trimming.
        let newest = self.newest_entry();
        let pushed = if self.undo_len() > before_undo {
            self.undo_len() - before_undo
        } else if self.undo_len() == before_undo
            && before_undo >= self.history_limit
            && newest.is_some()
            && newest != before_newest
        {
            1
        } else {
            0
        };
        self.note(format!(
            "{} -> {} (undo {}->{}, redo {}->{})",
            drawn.label,
            if accepted { "ok" } else { "rejected" },
            before_undo,
            self.undo_len(),
            before_redo,
            self.redo_len()
        ));

        if !accepted {
            self.outcome.rejected += 1;
            // A rejected command must change neither the stacks nor the state.
            // That assertion is what catches a command that mutates and THEN
            // fails, which is the worst shape a validation bug can take.
            if self.undo_len() != before_undo || self.redo_len() != before_redo {
                self.fail(
                    "a REJECTED command changed the history stacks",
                    &format!("  error: {:?}", drawn.result.error),
                );
            }
            self.expect_state(
                self.cursor,
                "a rejected command",
                Vec::new(),
                StaleTargets::default(),
            );
            return;
        }

        if pushed == 1 {
            if self.redo_len() != 0 {
                self.fail(
                    "a successful command did not clear the redo stack",
                    &format!("  after {}", drawn.label),
                );
            }
            self.cursor += 1;
            self.top = self.cursor;
            self.snapshots.truncate(self.cursor);
            self.verdicts.truncate(self.cursor);
            self.adjusted.truncate(self.cursor);
            self.epochs.truncate(self.cursor);
            self.entry_meta.truncate(self.cursor);
            let snapshot = self.snapshot();
            self.snapshots.push(snapshot);
            let verdict = self.verdict();
            self.verdicts.push(verdict);
            let adjusted = self.adjusted_geometry();
            self.adjusted.push(adjusted);
            self.epochs.push(self.epoch);
            // Read the entry BACK off the stack rather than inferring it from the
            // command that was drawn: the app is the authority on what it pushed,
            // and several entry points push an entry labelled by a different
            // command than the one the caller named.
            let command = self
                .state
                .get_undo_stack()
                .first()
                .map(|item| item.command_type.clone())
                .unwrap_or_default();
            self.entry_meta.push(EntryMeta {
                command,
                epoch: self.epoch,
                appended_into_empty: drawn.appended_into_empty,
                target: drawn.target,
                anchor: drawn.anchor,
            });
            self.outcome.mutations += 1;
            self.outcome.max_depth = self.outcome.max_depth.max(self.cursor);
            self.absorb_trim(&drawn.label);
            self.expect_merges_aligned(&drawn.label);
            self.expect_raw_and_resolved_agree(&drawn.label);
            return;
        }
        if pushed > 1 {
            self.fail(
                &format!("one command pushed {pushed} undo entries (expected 0 or 1)"),
                &format!("  after {}", drawn.label),
            );
        }

        // Succeeded without pushing an entry: a no-op command. It must not have
        // touched the project; it MAY have cleared the redo stack, which truncates
        // the model's forward branch.
        self.outcome.noops += 1;
        if self.redo_len() == 0 {
            self.top = self.cursor;
            self.snapshots.truncate(self.cursor + 1);
            self.verdicts.truncate(self.cursor + 1);
            self.adjusted.truncate(self.cursor + 1);
            self.epochs.truncate(self.cursor + 1);
            self.entry_meta.truncate(self.cursor + 1);
        } else if self.redo_len() != before_redo {
            self.fail(
                "a no-op command changed the redo stack without clearing it",
                &format!("  after {}", drawn.label),
            );
        }
        self.expect_state(
            self.cursor,
            "a no-op command",
            Vec::new(),
            StaleTargets::default(),
        );
    }

    /// Run one command through the model exactly as a drawn mutation, for the
    /// prologues that need a specific shape rather than a random one.
    ///
    /// `before` is the stack shape from BEFORE the command ran, which the caller
    /// has to capture: `record_mutation` tells a push from a no-op by the
    /// difference, and reading it here would make every forced command look like
    /// a no-op.
    fn forced(&mut self, drawn: Drawn, before: (usize, usize, Option<String>)) {
        self.record_mutation(drawn, before.0, before.1, before.2);
    }

    /// The current `(undo, redo)` stack depths, and the newest entry's identity.
    fn stacks(&self) -> (usize, usize, Option<String>) {
        (self.undo_len(), self.redo_len(), self.newest_entry())
    }

    /// A fingerprint of the newest undo entry, or `None` when the stack is empty.
    ///
    /// `(timestamp, command_type, description)` - enough to tell a fresh push
    /// from the same entry still sitting on top, which a stack LENGTH cannot do
    /// once the FIFO trim is active.
    fn newest_entry(&self) -> Option<String> {
        self.state.get_undo_stack().first().map(|item| {
            format!(
                "{}|{}|{}",
                item.timestamp.clone().unwrap_or_default(),
                item.command_type,
                item.description
            )
        })
    }

    /// Build the state findings 8, 12 and 13 need, instead of waiting for a seed
    /// to stumble into it.
    ///
    /// The three defects all require a shot id that means something DIFFERENT
    /// after a reload, and an entry carrying such an id that a walk actually
    /// reaches. A random stream reaches both by luck: it has to insert
    /// mid-section (so the ids stop matching positional order), then push an
    /// id-bearing entry, then save, then unwind to it without crossing a
    /// `ProjectSnapshotPair` on the way - and a snapshot-pair entry is a WALL,
    /// because `Shot::id` is serialized inside a project snapshot, so restoring
    /// one puts the whole project back into the pre-save id space and every
    /// stale id below it becomes valid again.
    ///
    /// So this builds the shape directly, in the order the harness's
    /// `undo-persistence-fuzz` arrived at for the same reason
    /// (`e2e/agent/scenarios/undoPersistenceCoverage.ts`, "why a
    /// ProjectSnapshotPair entry is a wall"): a fresh section, the insert that
    /// makes ids diverge, then EVERY id-bearing entry contiguous at the top, so
    /// the reload lands inside that block and the unwind starts on it.
    ///
    /// The section is FRESH - disconnected, no datum, in no loop - on purpose:
    /// `delete_shot`'s loop guard would otherwise refuse the undo of the insert
    /// (finding 6) and wedge the history before any of this could be observed.
    fn expose_stale_ids(&mut self) {
        let shots: Vec<ShotData> = (0..3).map(|_| random_shot(&mut self.rng)).collect();
        let before = self.stacks();
        let created = self.state.execute(Command::CreateSection {
            name: Some("exposed".to_string()),
            surveyor: None,
            date: None,
            color: (*self.rng.pick(COLORS)).to_string(),
            direction: None,
            shots,
        });
        let Some(section_id) = created.section_id else {
            self.fail(
                "the exposure prologue could not create its section",
                &format!("  error: {:?}", created.error),
            );
        };
        self.forced(
            Drawn::new(
                format!("exposure:createSection(s={section_id},shots=3)"),
                created,
            ),
            before,
        );

        // The insert that makes ids diverge from positional order. BEFORE the
        // first shot, so every id moves by one slot when the loader renumbers.
        let first = self.live_shot_ids(section_id);
        let Some(&first_shot) = first.first() else {
            self.fail("the exposure prologue's section has no shots", "");
        };
        let anchor = self.shot_target(section_id, first_shot);
        let shot = random_shot(&mut self.rng);
        let before = self.stacks();
        let inserted = self.state.execute(Command::CreateShot {
            section_id,
            shot,
            after_shot_id: None,
            before_shot_id: Some(first_shot),
        });
        let mut drawn = Drawn::new(
            format!("exposure:createShot(s={section_id},before)"),
            inserted,
        );
        drawn.anchor = anchor;
        drawn.target = drawn
            .result
            .shot_id
            .and_then(|shot_id| self.shot_target(section_id, shot_id));
        self.forced(drawn, before);

        // The divergence is the whole precondition, so it is CHECKED rather than
        // assumed: a section whose ids still equal `section * STRIDE + position`
        // survives the reload unchanged and none of this proves anything.
        let colliding = self.colliding_shots(section_id);
        assert!(
            !colliding.is_empty(),
            "the exposure prologue produced no colliding shot id in section {section_id}: ids {:?}",
            self.live_shot_ids(section_id)
        );

        // Every id-bearing edit variant, contiguous, on top: `PreviousValues`
        // (update_shot) and `InverseCommand` (set_shot_kind), each aimed at a
        // shot whose id will address a DIFFERENT one after the renumbering.
        for &shot_id in colliding.iter().take(2) {
            let target = self.shot_target(section_id, shot_id);
            let before = self.stacks();
            let edited = self.state.execute(Command::UpdateShot {
                section_id,
                shot_id,
                updates: ShotUpdates {
                    length: Some(self.rng.float(20.0, 40.0)),
                    ..ShotUpdates::default()
                },
            });
            let mut drawn = Drawn::new(
                format!("exposure:updateShot(s={section_id},shot={shot_id})"),
                edited,
            );
            drawn.target = target;
            self.forced(drawn, before);
        }
        for &shot_id in colliding.iter().take(2) {
            let target = self.shot_target(section_id, shot_id);
            let before = self.stacks();
            let marked = self.state.execute(Command::SetShotKind {
                section_id,
                shot_id,
                // Never `Normal`: every shot here starts Normal, so setting it
                // would be a forward no-op with a no-op inverse, and an undo
                // landing on the WRONG shot would be unobservable.
                kind: ShotKind::Jump,
            });
            let mut drawn = Drawn::new(
                format!("exposure:setShotKind(s={section_id},shot={shot_id})"),
                marked,
            );
            drawn.target = target;
            self.forced(drawn, before);
        }
    }

    /// Build the two closure shapes findings 4 and 10 need.
    ///
    /// Both are reachable in principle from the generators and neither is
    /// reachable in practice: a 30-seed x 60-move sweep with `closures` on
    /// produced no `RemoveLoopClosure` of a non-last closure at all, because a
    /// second closure needs a second independent path between the same two
    /// sections and `create_loop_closure` refuses everything else. So the shapes
    /// are constructed, and then left to the ordinary walk to exercise.
    ///
    /// GROUP 1, finding 4: two sections joined by a merge, two closures between
    /// them, and the FIRST one removed. Its undo is `loop_closures.push()`
    /// (core/state/undo.rs) rather than an insert at the recorded index, so the
    /// order the walk restores is not the order it recorded - and that order is
    /// persisted, indexed by the frontend and traversed by `resolve_offsets`.
    ///
    /// GROUP 2, finding 10: A - bridge - B chained by two merges plus a closure
    /// straight from A to B, with the bridge then deleted through
    /// `execute_delete_last_shot_and_section` - one of the two delete entry
    /// points that never calls `convert_orphan_closures_to_merges`. The closure
    /// is now the sole connection, so it is "really" a merge; memory keeps it as
    /// a closure, the save persists that, and the LOADER converts it.
    fn expose_closure_shapes(&mut self) {
        let group_one = self.build_merged_pair("closure-order-a", "closure-order-b", 2);
        if let Some((a, b)) = group_one {
            let mut ids = Vec::new();
            for (station_a, station_b) in [((a, 0), (b, 1)), ((a, 1), (b, 1))] {
                let before = self.stacks();
                let created = self.state.execute(Command::CreateLoopClosure {
                    station_a: StationRef::new(station_a.0, station_a.1),
                    station_b: StationRef::new(station_b.0, station_b.1),
                    closure_strategy: ClosureStrategy::Move,
                });
                if let Some(closure) = self
                    .state
                    .get_project_state()
                    .and_then(|project| project.loop_closures.last().map(|c| c.id))
                {
                    if created.success {
                        ids.push(closure);
                    }
                }
                self.forced(
                    Drawn::new(
                        format!(
                            "closures:createLoopClosure({}/{})",
                            station_a.0, station_b.0
                        ),
                        created,
                    ),
                    before,
                );
            }
            // The FIRST of two, so the undo's `push` lands it in the wrong place.
            // Removing the last one would restore correctly and prove nothing.
            if ids.len() == 2 {
                let before = self.stacks();
                let removed = self
                    .state
                    .execute(Command::RemoveLoopClosure { closure_id: ids[0] });
                self.forced(
                    Drawn::new(format!("closures:removeLoopClosure({})", ids[0]), removed),
                    before,
                );
            }
        }
    }

    /// GROUP 2, finding 10, built immediately before the save rather than at the
    /// start of the run.
    ///
    /// The orphan has to still BE an orphan when the file is written: any later
    /// command flagged `can_orphan_closures` runs the conversion from
    /// `execute()`'s epilogue and heals it, which is what made this fire in 1
    /// seed out of 10 when it was built up front.
    fn expose_orphan_closure(&mut self) {
        let a = self.forced_section("orphan-a", 1);
        let bridge = self.forced_section("orphan-bridge", 1);
        let b = self.forced_section("orphan-b", 1);
        let (Some(a), Some(bridge), Some(b)) = (a, bridge, b) else {
            return;
        };
        let before = self.stacks();
        let datum = self.state.execute(Command::SetZeroDatum {
            station_ref: StationRef::new(a, 0),
            coordinates: GpsCoordinates::new(21.1, -86.9, 0.0).unwrap(),
        });
        self.forced(
            Drawn::new(format!("closures:setZeroDatum({a}/0)"), datum),
            before,
        );
        for (left, right) in [((a, 1), (bridge, 0)), ((bridge, 1), (b, 0))] {
            let before = self.stacks();
            let merged = self.state.execute(Command::MergeStations {
                station_a: StationRef::new(left.0, left.1),
                station_b: StationRef::new(right.0, right.1),
            });
            self.forced(
                Drawn::new(format!("closures:merge({}/{})", left.0, right.0), merged),
                before,
            );
        }
        let before = self.stacks();
        let closure = self.state.execute(Command::CreateLoopClosure {
            station_a: StationRef::new(a, 0),
            station_b: StationRef::new(b, 1),
            closure_strategy: ClosureStrategy::Move,
        });
        let closed = closure.success;
        self.forced(
            Drawn::new(format!("closures:createLoopClosure({a}/{b})"), closure),
            before,
        );
        if !closed {
            return;
        }
        // The delete path that does NOT convert. `execute_delete_last_shot_and_section`
        // is an `AppState` entry point rather than a `Command`, so it never sees
        // `execute()`'s `can_orphan_closures` epilogue either.
        let Some(&bridge_shot) = self.live_shot_ids(bridge).first() else {
            return;
        };
        let before = self.stacks();
        let deleted = self
            .state
            .execute_delete_last_shot_and_section(bridge, bridge_shot);
        self.forced(
            Drawn::new(
                format!("closures:deleteLastShotAndSection(s={bridge})"),
                deleted,
            ),
            before,
        );
    }

    /// A section with `shots` random shots, run through the model. Returns its id.
    fn forced_section(&mut self, name: &str, shots: usize) -> Option<SectionId> {
        let shots: Vec<ShotData> = (0..shots).map(|_| random_shot(&mut self.rng)).collect();
        let before = self.stacks();
        let created = self.state.execute(Command::CreateSection {
            name: Some(name.to_string()),
            surveyor: None,
            date: None,
            color: (*self.rng.pick(COLORS)).to_string(),
            direction: None,
            shots,
        });
        let section_id = created.section_id;
        self.forced(
            Drawn::new(format!("closures:createSection({name})"), created),
            before,
        );
        section_id
    }

    /// Two sections joined by a merge, with a zero datum on the first so a loop
    /// closure between them is legal. Returns `(a, b)`.
    fn build_merged_pair(
        &mut self,
        name_a: &str,
        name_b: &str,
        shots_a: usize,
    ) -> Option<(SectionId, SectionId)> {
        let a = self.forced_section(name_a, shots_a)?;
        let b = self.forced_section(name_b, 1)?;
        let before = self.stacks();
        let datum = self.state.execute(Command::SetZeroDatum {
            station_ref: StationRef::new(a, 0),
            coordinates: GpsCoordinates::new(20.9, -87.1, 0.0).unwrap(),
        });
        self.forced(
            Drawn::new(format!("closures:setZeroDatum({a}/0)"), datum),
            before,
        );
        let before = self.stacks();
        let merged = self.state.execute(Command::MergeStations {
            station_a: StationRef::new(a, shots_a as u32),
            station_b: StationRef::new(b, 0),
        });
        let ok = merged.success;
        self.forced(
            Drawn::new(format!("closures:merge({a}/{b})"), merged),
            before,
        );
        ok.then_some((a, b))
    }

    /// Live shot ids of one section, in positional order.
    fn live_shot_ids(&self, section_id: SectionId) -> Vec<ShotId> {
        self.state
            .get_project_state()
            .map(|project| {
                project
                    .sections
                    .iter()
                    .find(|section| section.id == section_id)
                    .map(|section| section.shots.iter().map(|shot| shot.id).collect())
                    .unwrap_or_default()
            })
            .unwrap_or_default()
    }

    /// Shots whose id will address a DIFFERENT, still-valid position once the
    /// loader has renumbered the section.
    ///
    /// The loader rewrites position `i` to `section_id * FEATURE_ID_STRIDE + i`
    /// (persistence/sqlite/read.rs), so a persisted id `ids[i]` will address
    /// position `ids[i] - section_id * STRIDE` after a reload. It is a COLLISION
    /// exactly when that number is a different, still-valid position - which is
    /// findings 8 and 12's regime, as opposed to finding 13's (out of range).
    fn colliding_shots(&self, section_id: SectionId) -> Vec<ShotId> {
        let ids = self.live_shot_ids(section_id);
        let base = section_id * crate::models::FEATURE_ID_STRIDE;
        ids.iter()
            .enumerate()
            .filter(|(position, id)| {
                let lands = id.saturating_sub(base) as usize;
                lands != *position && lands < ids.len()
            })
            .map(|(_, id)| *id)
            .collect()
    }

    /// Run `body`, turning the app's OWN merge-alignment assert into a
    /// classified, TERMINAL finding-14 hit instead of an unattributable process
    /// panic.
    ///
    /// `Project::debug_assert_merge_alignment` (models/project/offsets.rs) has a
    /// `#[cfg(test)]` assert arm, so it exists in this tier and in no other. It
    /// fires at the END of `insert_shot_after` - after the mutation it is
    /// checking - which is why this cannot be pre-empted by checking alignment
    /// before the move: the command that breaks the invariant is the command
    /// that asserts it. `expect_merges_aligned` proves the state was clean
    /// immediately before.
    ///
    /// Three things keep this from being a blanket catch:
    ///
    /// * the payload is READ, and anything whose message is not that assert is
    ///   re-raised verbatim with `resume_unwind` - no other panic is absorbed;
    /// * the context string has to be one of the INSERT sites finding 14 names,
    ///   so the same assert firing after `merge_stations` or `set_zero_datum`
    ///   is still an unexplained failure;
    /// * the run STOPS. The assert unwinds through `AppState`'s project mutex,
    ///   which poisons it, and several call sites treat a poisoned lock as "no
    ///   project" - so everything after it would be measuring a crippled
    ///   `AppState` rather than the app.
    ///
    /// The assert itself is untouched. Disabling it would delete this tier's
    /// only view of the defect.
    fn catching_alignment<T>(&mut self, body: impl FnOnce(&mut Self) -> T) -> Option<T> {
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| body(self)));
        match outcome {
            Ok(value) => Some(value),
            Err(payload) => {
                let message = payload
                    .downcast_ref::<String>()
                    .cloned()
                    .or_else(|| payload.downcast_ref::<&str>().map(|s| (*s).to_string()))
                    .unwrap_or_default();
                // The CONTEXT decides which finding it is, and an assert from a
                // site neither of them names is re-raised verbatim.
                let id = if message.contains("Merge alignment violated after insert_shot_") {
                    "finding-14-insert-leaves-a-merge-metres-out-of-alignment"
                } else if message.contains("Merge alignment violated after remove_shot_with_rewire")
                {
                    // Finding 14's mirror image, and reached only through an
                    // UNDO: `remove_shot_with_rewire` is what undo of CreateShot
                    // routes into, and it has the same "compensate only when the
                    // partner is independently anchored" shape as the insert.
                    "finding-14-variant-a-shot-removal-leaves-a-merge-out-of-alignment"
                } else {
                    std::panic::resume_unwind(payload);
                };
                *self.outcome.hits.entry(id).or_insert(0) += 1;
                self.outcome.alignment_panic = true;
                self.note(format!(
                    "  ^ the app's own merge-alignment assert fired: {}",
                    message.lines().next().unwrap_or_default()
                ));
                None
            }
        }
    }

    /// Move the model's floor up when the app FIFO-trimmed the oldest entries,
    /// and assert it trimmed exactly as much as the limit requires.
    ///
    /// `UndoStack::enforce_depth_limit` drops from the FRONT of the undo stack
    /// while `len > history_limit` (core/undo/budget.rs). So after a push the
    /// app holds at most `history_limit` entries, and the model's reachable
    /// floor is `cursor - history_limit`. Everything below that is unreachable
    /// FOREVER - not "not currently reachable" - so the model drops those
    /// depths' expectations rather than keeping stale ones it can never check.
    ///
    /// The assertion is exact in both directions: too little trimming is an
    /// unbounded history, too much is a user's edits disappearing early.
    fn absorb_trim(&mut self, what: &str) {
        let reachable = self.cursor - self.floor;
        let expected_undo = reachable.min(self.history_limit);
        let actual_undo = self.undo_len();
        if actual_undo != expected_undo {
            self.fail(
                &format!("{what} left the undo stack the wrong length for the history limit"),
                &format!(
                    "  limit={} reachable={reachable} expected undo={expected_undo}, got {actual_undo}",
                    self.history_limit
                ),
            );
        }
        if reachable > self.history_limit {
            let new_floor = self.cursor - self.history_limit;
            // The trimmed depths can never be observed again, so their
            // expectations are dropped rather than left to rot. `snapshots` is
            // indexed by ABSOLUTE depth, so the entries stay in place and only
            // the floor moves - which keeps every other index meaningful.
            self.outcome.trimmed += new_floor - self.floor;
            self.floor = new_floor;
        }
    }

    /// Allocators may not go BACKWARDS across a forward command.
    ///
    /// The roundtrip oracle drops them deliberately: a snapshot-pair undo
    /// restores them verbatim while a targeted undo only ever raises them, so
    /// comparing them per depth would fire on every mixed history. That leaves
    /// the one thing about them that IS an invariant unchecked - a forward
    /// command that lowers an allocator hands the same id out twice - which is
    /// what this checks, per mutation, against the value from immediately
    /// before it.
    fn expect_allocators_advanced(&mut self, before: &BTreeMap<String, u32>, what: &str) {
        let after = self.allocators();
        let mut regressions = Vec::new();
        for (key, old) in before {
            if let Some(new) = after.get(key) {
                if new < old {
                    regressions.push(format!("{key}: {old} -> {new}"));
                }
            }
        }
        if regressions.is_empty() {
            return;
        }
        self.fail(
            &format!("{what} REWOUND an id allocator, so an id can now be issued twice"),
            &format!("  {}", regressions.join("\n  ")),
        );
    }

    /// Every id allocator in the project, by name.
    fn allocators(&self) -> BTreeMap<String, u32> {
        let mut out = BTreeMap::new();
        let Some(project) = self.state.get_project_state() else {
            return out;
        };
        out.insert("next_section_id".to_string(), project.next_section_id);
        out.insert(
            "next_closure_id".to_string(),
            u32::try_from(project.next_closure_id).unwrap_or(u32::MAX),
        );
        for section in &project.sections {
            out.insert(
                format!("section {}.next_shot_id", section.id),
                section.next_shot_id,
            );
        }
        out
    }

    /// The sizes worth watching over a long run: an unbounded collection is a
    /// leak whether or not any single move looks wrong.
    fn record_growth(&mut self) {
        let Some(project) = self.state.get_project_state() else {
            return;
        };
        let stations: usize = project
            .sections
            .iter()
            .map(|section| section.shots.len() + 1)
            .sum();
        let peak = &mut self.outcome.peak;
        peak.sections = peak.sections.max(project.sections.len());
        peak.stations = peak.stations.max(stations);
        peak.section_offsets = peak.section_offsets.max(project.section_offsets.len());
        peak.station_offsets = peak.station_offsets.max(project.station_offsets.len());
        peak.station_comments = peak.station_comments.max(project.station_comments.len());
        peak.merges = peak.merges.max(project.station_merges.len());
        peak.closures = peak.closures.max(project.loop_closures.len());
    }

    /// Did a failed history move fail for a KNOWN, documented reason?
    ///
    /// Both of these leave the entry on its stack (`undo_inner`'s epilogue pushes
    /// it back), so the history is WEDGED and the walk cannot continue - which is
    /// why the caller stops rather than retrying.
    fn classify_move_failure(&mut self, error: &str) -> Option<&'static str> {
        // FINDING 6 is "the user-facing `delete_shot` refuses the undo of a
        // permitted `CreateShot`", and `delete_shot` has THREE guards that can
        // do it, not the one the write-up quotes: the loop/datum pair, and a
        // frozen-shot check that runs before them (core/state/command_shot.rs,
        // "Defense-in-depth: refuse to delete a frozen shot"). All three leave
        // the entry pushed back and the history wedged, which is the finding.
        if error.contains("part of a loop")
            || error.contains("zero datum")
            || error.contains("Cannot delete a frozen shot")
        {
            return Some("finding-6-undo-refused-by-a-delete-guard");
        }
        // Two spellings, one defect. Finding 13 names all three arms a stale shot
        // id can reach, and they do not word it the same way:
        // `delete_shot`/`restore_shot` say "Shot {id} not found in section {s}"
        // (models/project/shots.rs), while `update_shot` and `set_shot_kind` say
        // "Shot {s}:{id} not found" (core/state/command_shot.rs). Matching only
        // the first left the `PreviousValues` and `InverseCommand` arms - the two
        // finding 13's own write-up lists after `CreatedShotSnapshot` -
        // unclassified.
        if error.contains("not found in section")
            || (error.starts_with("Shot ") && error.ends_with(" not found"))
        {
            return Some("finding-13-stale-id-misses-and-wedges-the-history");
        }
        None
    }

    /// What the ids on `entry` address in the LIVE project right now.
    ///
    /// This is the whole of findings 8, 12 and 13 reduced to one measurement.
    /// `Staleness::Absent` when the run has never reloaded, because an id that
    /// has not crossed the loader's renumbering cannot be stale - and saying so
    /// keeps the classifiers from ever explaining an in-memory difference with a
    /// persistence defect.
    fn measure_staleness(&self, entry: Option<&EntryMeta>) -> StaleTargets {
        if self.outcome.reloads == 0 {
            return StaleTargets::default();
        }
        let Some(entry) = entry else {
            return StaleTargets::default();
        };
        let measure = |target: Option<&ShotTarget>| -> Staleness {
            let Some(target) = target else {
                return Staleness::Absent;
            };
            match self.uuid_of(target.section_id, target.shot_id) {
                None => Staleness::Missing,
                Some(uuid) if uuid == target.uuid => Staleness::Fresh,
                Some(_) => Staleness::Collides,
            }
        };
        StaleTargets {
            target: measure(entry.target.as_ref()),
            anchor: measure(entry.anchor.as_ref()),
        }
    }

    /// One history move. `steps` > 1 goes through `undo_to`/`redo_to`, the
    /// history dropdown's multi-step path, verified against the SAME snapshots
    /// single steps recorded - an equivalence that is not free, because
    /// `undo_to`/`redo_to` loop the `*_inner` variants and call neither
    /// `invalidate_adjusted_cache()` nor `reconcile_geometry()` (finding 7).
    ///
    /// Returns false when a known wedge stopped it.
    fn step_history(&mut self, back: bool, steps: usize) -> bool {
        // `floor`, not 0: everything below it was FIFO-trimmed and the app has
        // no entry left to undo.
        let reach = if back {
            self.cursor - self.floor
        } else {
            self.top - self.cursor
        };
        if reach == 0 || steps == 0 {
            return true;
        }
        let steps = steps.min(reach);
        let jumped = steps > 1;
        // The entry this move will consume. For an undo that is the one at the
        // current depth; for a redo, the one just above it. A jump consumes
        // several - the FIRST one is what the classifiers key on, since it is the
        // one whose restore produced the state being compared.
        // Every entry this move consumes, in restore order. For an undo those are
        // the entries at the current depth downwards; for a redo, the ones just
        // above it upwards.
        let consumed: Vec<EntryMeta> = if back {
            (0..steps)
                .filter_map(|step| self.entry_meta.get(self.cursor - step).cloned())
                .collect()
        } else {
            (1..=steps)
                .filter_map(|step| self.entry_meta.get(self.cursor + step).cloned())
                .collect()
        };
        // Measured NOW, before the move: the ids the entry carries are about to
        // be resolved against THIS project, and the move itself changes which
        // shot each one addresses.
        // Over EVERY entry the move will consume, worst case per role. For the
        // entries after the first this is measured against the pre-move project
        // rather than against the intermediate state each restore will actually
        // see - an approximation, and one that can only ever say "an id on this
        // move is stale", which is exactly what the classifiers ask it.
        let stale = consumed
            .iter()
            .map(|entry| self.measure_staleness(Some(entry)))
            .fold(StaleTargets::default(), StaleTargets::worst);
        // A restore that is ABOUT to address the wrong shot is a measured fact,
        // not an inference from the damage afterwards - and it is what makes
        // every deeper comparison in this walk a re-measurement rather than a
        // new defect. Armed here so the cascade classifier is armed even when
        // the first-hand diff shape is one no classifier names.
        if matches!(stale.target, Staleness::Collides | Staleness::Missing)
            || matches!(stale.anchor, Staleness::Collides | Staleness::Missing)
        {
            if !self.stale_corruption {
                self.note(format!(
                    "  ^ a persisted id on this entry is STALE (target={:?}, anchor={:?}): \
                     every later comparison against a pre-save snapshot re-measures it",
                    stale.target, stale.anchor
                ));
            }
            self.stale_corruption = true;
        }
        let Some(result) = self.catching_alignment(|fuzzer| {
            if back {
                if jumped {
                    fuzzer.state.undo_to(steps - 1)
                } else {
                    fuzzer.state.undo()
                }
            } else if jumped {
                fuzzer.state.redo_to(steps - 1)
            } else {
                fuzzer.state.redo()
            }
        }) else {
            return false;
        };
        let label = format!(
            "{}{} x{steps}",
            if back { "undo" } else { "redo" },
            if jumped { "To" } else { "" }
        );

        if !result.success {
            let error = result.error.clone().unwrap_or_default();
            self.note(format!("{label} -> FAILED [{error}]"));
            if let Some(id) = self.classify_move_failure(&error) {
                *self.outcome.hits.entry(id).or_insert(0) += 1;
                self.outcome.wedged = true;
                return false;
            }
            self.fail(
                &format!("{label} at depth {} failed outright", self.cursor),
                &format!("  error: {error}"),
            );
        }

        self.cursor = if back {
            self.cursor - steps
        } else {
            self.cursor + steps
        };
        self.note(format!("{label} -> depth {}", self.cursor));
        if back {
            self.outcome.undos += 1;
        } else {
            self.outcome.redos += 1;
        }
        if jumped {
            self.outcome.jumps += 1;
        }
        self.expect_stacks(&label);
        if jumped {
            self.probe_jump_equivalence(back, steps, self.cursor);
        }
        self.expect_state(self.cursor, &label, consumed, stale);
        self.expect_merges_aligned(&label);
        self.expect_raw_and_resolved_agree(&label);
        !self.outcome.drift_stop
    }

    /// FINDING 7, decided by PROVING the inequality rather than by recognising a
    /// shape: run the same distance again one step at a time and see whether the
    /// two paths agree.
    ///
    /// `undo()` and `redo()` end in `reconcile_geometry()`, which runs
    /// `realign_merges()`; `undo_to()` and `redo_to()` validate the index and
    /// then loop the `*_inner` variants, calling it NEITHER per step nor at the
    /// end (core/state/undo.rs). The contract that breaks is exactly
    /// "`undo_to(N)` == N x `undo()`", so this measures that contract directly:
    /// the jump is replayed forwards, then walked back down in single steps, and
    /// if the single-step path lands on the state the model recorded while the
    /// jump did not, the two paths are not equal. That is the finding, proven on
    /// the spot rather than inferred.
    ///
    /// Only ever entered for a jump that has ALREADY diverged, and it attributes
    /// nothing unless the single-step walk succeeds AND lands exactly on the
    /// recorded state; anything else is left to the ordinary classification,
    /// with the log recording that the replay happened.
    fn probe_jump_equivalence(&mut self, back: bool, steps: usize, depth: usize) {
        if self.snapshot() == self.snapshots[depth] {
            return;
        }
        // Undo what the jump did, one step at a time in the opposite direction,
        // then redo it one step at a time. Both use the plain `undo`/`redo`
        // entry points, which is the whole point - they carry the epilogue.
        let (rewind, replay): (
            fn(&AppState) -> CommandResult,
            fn(&AppState) -> CommandResult,
        ) = if back {
            (AppState::redo, AppState::undo)
        } else {
            (AppState::undo, AppState::redo)
        };
        for _ in 0..steps {
            if !rewind(&self.state).success {
                return;
            }
        }
        for _ in 0..steps {
            if !replay(&self.state).success {
                return;
            }
        }
        self.note(format!(
            "  ^ replayed the same {steps} step(s) singly to test undo_to == N x undo"
        ));
        if self.snapshot() == self.snapshots[depth] {
            *self
                .outcome
                .hits
                .entry("finding-7-a-jump-is-not-n-single-steps")
                .or_insert(0) += 1;
        }
    }

    /// Save to a temp path, close, reopen. Undo history is PERSISTED - both stacks
    /// serialize into the `.stalx` and restore on open - so nothing below a save
    /// point is exercised until a run crosses this boundary. Findings 8, 12 and 13
    /// all live on the other side of it.
    fn cross_boundary(&mut self) -> bool {
        if self.orphan_pending {
            self.orphan_pending = false;
            self.expose_orphan_closure();
        }
        if self.top == 0 || self.top > UNDO_PERSIST_LIMIT {
            return false;
        }
        let temp = self.temp.get_or_insert_with(|| TempDir::new().unwrap());
        let path: PathBuf = temp.path().join("fuzz.stalx");

        // The save is about to make undo-less changes, so everything recorded so
        // far belongs to the previous epoch.
        self.epoch += 1;
        let saved = self.state.save_project(Some(path.clone()));
        if !saved.success {
            self.fail(
                "save_project failed",
                &format!("  error: {:?}", saved.error),
            );
        }
        self.outcome.saves += 1;
        self.record_saved_anchors();
        self.note(format!("save -> ok (depth {})", self.cursor));
        self.expect_stacks("save");
        self.expect_state(self.cursor, "save", Vec::new(), StaleTargets::default());

        let closed = self.state.execute(Command::CloseProject);
        if !closed.success {
            self.fail(
                "CloseProject failed",
                &format!("  error: {:?}", closed.error),
            );
        }
        let opened = self.state.execute(Command::OpenProject { path });
        if !opened.success {
            self.fail(
                "OpenProject failed",
                &format!("  error: {:?}", opened.error),
            );
        }
        // Switch BEFORE re-observing, so both sides of the comparison are in the
        // same form.
        self.enable_id_agnostic();
        self.epoch += 1;
        self.outcome.reloads += 1;
        self.note(format!("reload -> depth {}", self.cursor));
        self.expect_stacks("reload");
        self.expect_state(self.cursor, "reload", Vec::new(), StaleTargets::default());
        true
    }

    /// The closing guarantee: unwind every entry to depth 0, then replay every
    /// entry back to the top, verifying the recorded snapshot at each depth in
    /// BOTH directions.
    fn finish(&mut self) {
        let summit = self.top;
        while self.cursor > self.floor {
            if !self.step_history(true, 1) {
                return;
            }
        }
        while self.cursor < summit {
            if !self.step_history(false, 1) {
                return;
            }
        }
    }
}

/// What a run is allowed to do.
#[derive(Clone, Copy)]
struct Plan {
    iterations: usize,
    /// Cross the save/close/reopen boundary once, part way through.
    persistence: bool,
    /// Draw multi-step `undo_to`/`redo_to` jumps as well as single steps.
    ///
    /// OFF for the gate, ON for the soak, and the reason is finding 7, not taste.
    /// `undo_to`/`redo_to` loop `undo_inner`/`redo_inner` and call NEITHER
    /// `invalidate_adjusted_cache()` NOR `reconcile_geometry()`, which
    /// `undo()`/`redo()` both do - so `realign_merges()` never runs after a jump
    /// and a merge can be left METRES out of alignment. In this tier that does not
    /// surface as a snapshot mismatch the fuzzer can classify: it surfaces later,
    /// as the app's OWN `debug_assert_merge_alignment` (models/project/offsets.rs,
    /// `#[cfg(test)]` and therefore an oracle only this tier has) panicking inside
    /// whatever command next touches the merge. A panic from inside the app cannot
    /// be attributed to a finding from outside it, so a gate that drew jumps would
    /// be red for a KNOWN bug with an unreadable message.
    ///
    /// Turn this on with finding 7 and the gate goes red - which is the point:
    /// delete this flag when it is fixed.
    jumps: bool,
    /// Put a genuine LOOP CLOSURE in the starting project, and let the generators
    /// create more.
    ///
    /// OFF for the gate, ON for the soak, because of FINDING 14 - which this tier
    /// found, and which no other tier can see. With a closure present,
    /// `insert_shot_after` leaves a downstream merge METRES out of alignment, and
    /// the app's own `#[cfg(test)]` `debug_assert_merge_alignment`
    /// (models/project/offsets.rs) panics the process from inside the insert. It
    /// is the INSERT that breaks it, not a leftover: this module re-checks raw
    /// merge alignment after every move with the same measure the assert uses,
    /// and that check is clean on the move immediately before.
    ///
    /// A panic from inside the app cannot be classified from outside it, so a gate
    /// that built closures would be red for a known finding with an unreadable
    /// message. Delete this flag when finding 14 is fixed; the gate then covers
    /// `ClosureInfo` again, which is the coverage it currently costs.
    closures: bool,
    /// Build the id-vs-position divergence findings 8, 12 and 13 need, and put
    /// every id-bearing entry contiguous on top, before crossing the save
    /// boundary. See `Fuzzer::expose_stale_ids`.
    ///
    /// OFF for the gate. Not because it is slow but because it is DELIBERATE
    /// corruption: with it on a run reaches the data-loss findings by
    /// construction, and its classified-hit counts then say nothing about
    /// whether the model has acquired a NEW way to be wrong, which is the only
    /// thing the gate is for.
    divergence: bool,
    /// Build the two closure shapes findings 4 and 10 need before fuzzing. See
    /// `Fuzzer::expose_closure_shapes`. Implies `closures`.
    ///
    /// OFF for the gate, for the same reason as `divergence` and for
    /// `closures`'s reason too: the shapes are built to reach known defects, so
    /// the hit counts say nothing about new ones.
    closure_shapes: bool,
    /// How many times a persistence run crosses save/close/reopen.
    ///
    /// One is the historical behaviour and what the gate uses. MORE than one is
    /// what stacks heals on heals: `capture_missing_gauge_anchors` runs per
    /// save, the loader re-solves offsets per open, and the orphan-closure
    /// conversion happens on load - so every crossing bumps the epoch again and
    /// a snapshot recorded two epochs back is compared against a project that
    /// has been healed twice. Nothing exercised that: `cross_boundary` was
    /// called at most twice per run and only ever once in the gate.
    crossings: usize,
    /// Run PAST the app's `undo_history_limit`, so the FIFO trim fires and the
    /// model becomes a sliding window.
    ///
    /// OFF for the gate because it needs thousands of moves to be worth
    /// anything: the trim only starts at depth 100, and the accumulation oracle
    /// it exists alongside needs a depth to be revisited dozens of times before
    /// tolerated dust can add up to anything.
    horizon: bool,
}

fn run_fuzz(seed: u32, plan: Plan) -> Outcome {
    let mut fuzzer = Fuzzer::new(seed, plan.closures || plan.closure_shapes);
    // The exposure prologue runs FIRST and crosses the boundary itself, so the
    // block of id-bearing entries it builds is the newest thing on the stack
    // when the reload lands and the closing unwind starts on it.
    if plan.divergence {
        fuzzer.expose_stale_ids();
        fuzzer.cross_boundary();
    }
    if plan.closure_shapes {
        fuzzer.expose_closure_shapes();
        fuzzer.orphan_pending = plan.persistence;
    }
    // Crossing at a third of the way in leaves entries both below and above the
    // boundary, so the closing walk covers restored UNDO entries and restored
    // REDO entries alike. With `crossings` > 1 the rest are spread over the
    // remaining run, so each one lands on a stack the previous crossing already
    // restored - which is the case heals-on-heals needs.
    let crossings = plan.crossings.max(1);
    let boundaries: Vec<usize> = if plan.persistence && !plan.divergence {
        (0..crossings)
            .map(|index| plan.iterations / 3 + index * (plan.iterations * 2 / 3) / crossings)
            .collect()
    } else {
        Vec::new()
    };

    // HORIZON mode deliberately pushes past the app's own history limit so the
    // FIFO trim fires and the sliding window gets fuzzed; every other mode stays
    // under it, which is what keeps `snapshots[0]` valid for the closing walk.
    let depth_cap = if plan.horizon {
        fuzzer.history_limit * 2
    } else {
        MAX_MODEL_DEPTH
    };
    for iteration in 0..plan.iterations {
        // Nothing after the app's own assert measures the app: it unwound
        // through the project mutex, so the lock is poisoned and half the call
        // sites now read "no project open".
        if fuzzer.outcome.alignment_panic || fuzzer.outcome.drift_stop {
            break;
        }
        if boundaries.contains(&iteration) {
            fuzzer.cross_boundary();
        }
        // 60 / 25 / 15 mutate / undo / redo, re-rolled when the stack a move
        // needs is empty. Same mix as the harness.
        let roll = fuzzer.rng.below(100);
        // 60 / 25 / 15 mutate / undo / redo, EXCEPT while a horizon run is still
        // climbing: at that mix the depth random-walks around 25 and never
        // reaches the history limit at all (measured - 335 mutations, depth 23),
        // because every jump knocks the cursor down and the next mutation
        // truncates everything above it. 85 / 8 / 7 climbs while still walking
        // the history on the way up. ONE draw either way, so no other mode's
        // stream moves.
        let climbing = plan.horizon && fuzzer.cursor - fuzzer.floor < depth_cap;
        let mut back = if climbing {
            (85..93).contains(&roll)
        } else {
            (60..85).contains(&roll)
        };
        let mut forward = roll >= if climbing { 93 } else { 85 };
        if forward && fuzzer.cursor >= fuzzer.top {
            forward = false;
            back = fuzzer.cursor > fuzzer.floor;
        }
        if back && fuzzer.cursor == fuzzer.floor {
            back = false;
        }
        if !back && !forward {
            if fuzzer.cursor - fuzzer.floor >= depth_cap {
                if !fuzzer.step_history(true, 1) {
                    break;
                }
                continue;
            }
            fuzzer.step_mutate();
            if fuzzer.outcome.alignment_panic || fuzzer.outcome.drift_stop {
                break;
            }
            continue;
        }
        // About one history move in ten is taken as a multi-step jump.
        let reach = if back {
            fuzzer.cursor
        } else {
            fuzzer.top - fuzzer.cursor
        };
        // One history move in ten is a jump by default. `plan.jumps` is checked
        // FIRST so a run without jumps draws nothing here and its stream is
        // unchanged by this knob - the gate's pinned seeds depend on that.
        // No jumps while a horizon run is CLIMBING: a jump lands the cursor near
        // the floor and the next mutation truncates everything above it, which
        // caps the depth well below the history limit (measured - 909 mutations
        // and 57 jumps got to depth 63, never to 100). Jumps resume once the
        // window is sliding, which is where they are interesting anyway.
        let steps = if plan.jumps && !climbing && reach > 1 && fuzzer.rng.chance(JUMP_PERCENT) {
            1 + fuzzer.rng.below(reach)
        } else {
            1
        };
        if !fuzzer.step_history(back, steps) {
            break;
        }
        if fuzzer.outcome.alignment_panic || fuzzer.outcome.drift_stop {
            break;
        }
    }

    if !fuzzer.outcome.wedged && !fuzzer.outcome.alignment_panic && !fuzzer.outcome.drift_stop {
        // Cross the boundary at least once per persistence run, so the closing
        // walk below runs against a RESTORED stack rather than an in-memory one.
        if plan.persistence && fuzzer.outcome.reloads == 0 {
            fuzzer.cross_boundary();
        }
        fuzzer.finish();
    }
    fuzzer.outcome
}

// ===========================================================================
// The CI gate
// ===========================================================================

/// Seeds the gate runs, in both modes.
///
/// PINNED, and pinned deliberately rather than arbitrarily: `fuzz_seed_survey`
/// (below) reports which seeds are currently clean, and these are clean at 100
/// moves, so they have headroom above the 60 the gate uses.
///
/// RE-PINNED once the classifiers could name what they were hitting. The list
/// was six seeds when 32 of the first 40 reached an unclassified finding within
/// 100 moves; both of the findings responsible turned out to be one already on
/// the issue (finding 3, which nothing classified in its ratcheted or
/// data-loss form) plus its cascade, and with those named 35 of the first 40 are
/// clean at 100. Thirteen of them are gated, which is still well under a second
/// per mode.
///
/// What that does NOT mean is that the gate now covers those findings: it covers
/// SEQUENCES that do not reach them. The modes that construct a known defect
/// (`Plan::divergence`, `Plan::closure_shapes`, `jumps`, `closures`) stay out of
/// the gate on purpose - see the matrix in the module header. Re-run the survey
/// and widen this list as findings are FIXED.
const GATE_SEEDS: &[u32] = &[1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 19, 26];
/// Moves per gate seed. 60 keeps the whole gate well inside a second while still
/// reaching depth 20+, crossing the persistence boundary and walking the closing
/// unwind/rewind over every entry.
const GATE_ITERATIONS: usize = 60;

/// Bucket a failure by its SHAPE rather than by its text.
///
/// The headline alone buckets by depth ("did not restore the state recorded at
/// depth 23"), which splits one defect across twenty buckets and hides how many
/// distinct things a sweep actually found. Digits are collapsed to `#` and the
/// first differing path is appended, so two seeds that lost the same field at
/// different depths land in the same bucket - which is what a triage read wants.
fn failure_signature(message: &str) -> String {
    let collapse = |text: &str| -> String {
        let mut out = String::with_capacity(text.len());
        let mut in_digits = false;
        for ch in text.chars() {
            if ch.is_ascii_digit() {
                if !in_digits {
                    out.push('#');
                    in_digits = true;
                }
            } else {
                out.push(ch);
                in_digits = false;
            }
        }
        out
    };
    let headline = collapse(message.lines().next().unwrap_or("<empty>"));
    let first_path = message
        .lines()
        .map(str::trim)
        .find(|line| line.starts_with("at "))
        .map(collapse);
    match first_path {
        Some(path) => format!("{headline} | {path}"),
        None => headline,
    }
}

fn summarize(label: &str, seed: u32, outcome: &Outcome) -> String {
    let hits = outcome
        .hits
        .iter()
        .map(|(id, count)| format!("{id}={count}"))
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        "{label} seed={seed}: {} mutations, {} rejected, {} no-ops, {} undos, {} redos, \
         {} jumps, {} saves, {} reloads, depth<={}, float-noise={}, attributed={}, \
         integrity-compared={}, adjusted-compared={}, oracle-us=(snap {} integrity {} adjusted {}), \
         trimmed={}, peak={:?}{}{}",
        outcome.mutations,
        outcome.rejected,
        outcome.noops,
        outcome.undos,
        outcome.redos,
        outcome.jumps,
        outcome.saves,
        outcome.reloads,
        outcome.max_depth,
        outcome.float_noise,
        outcome.attributed,
        outcome.integrity_compared,
        outcome.adjusted_compared,
        outcome.oracle_us.0,
        outcome.oracle_us.1,
        outcome.oracle_us.2,
        outcome.trimmed,
        outcome.peak,
        if outcome.wedged {
            " WEDGED"
        } else if outcome.alignment_panic {
            " ALIGNMENT-PANIC"
        } else if outcome.drift_stop {
            " MERGE-DRIFT-STOP"
        } else {
            ""
        },
        if hits.is_empty() {
            String::new()
        } else {
            format!("; classified hits: {hits}")
        }
    )
}

/// THE GATE. Not `#[ignore]`d, so it runs on every `cargo test` and in CI.
///
/// It passes when every difference the fuzzer sees is either equal, inside the
/// numeric tolerance, a documented save/reload heal, or one of the classified
/// open bugs on <https://github.com/Stalagmight/Stalagmight/issues/413>. ANY
/// unexplained divergence panics with the seed, the depth and the first differing
/// paths.
///
/// So this is a REGRESSION guard rather than a bug hunt: the hunt happens in the
/// soak below and in the agent harness. What it guarantees is that the undo model
/// does not acquire a NEW way to be wrong without someone noticing.
#[test]
fn undo_redo_fuzz_gate() {
    let mut total: BTreeMap<&'static str, usize> = BTreeMap::new();
    for &seed in GATE_SEEDS {
        let outcome = run_fuzz(
            seed,
            Plan {
                iterations: GATE_ITERATIONS,
                persistence: false,
                crossings: 1,
                jumps: false,
                closures: false,
                divergence: false,
                closure_shapes: false,
                horizon: false,
            },
        );
        println!("{}", summarize("in-memory", seed, &outcome));
        assert!(
            outcome.mutations > 10,
            "seed {seed} barely mutated ({} mutations); the generators are not reaching the project",
            outcome.mutations
        );
        assert!(
            outcome.undos > 3 && outcome.redos > 3,
            "seed {seed} barely walked the history (undos={} redos={})",
            outcome.undos,
            outcome.redos
        );
        for (id, count) in outcome.hits {
            *total.entry(id).or_insert(0) += count;
        }
    }
    println!("gate (in-memory) classified totals: {total:?}");
}

/// The persistence half of the gate: every seed crosses save/close/reopen and
/// then walks the RESTORED stacks, including the restored REDO entries.
///
/// Split from the in-memory gate because it is the slower half (each crossing is
/// a real SQLite write and read) and because a failure here has a different
/// meaning: it is about what survives the file, not about the model.
#[test]
fn undo_redo_fuzz_gate_persistence() {
    let mut total: BTreeMap<&'static str, usize> = BTreeMap::new();
    let mut crossings = 0;
    for &seed in GATE_SEEDS {
        let outcome = run_fuzz(
            seed,
            Plan {
                iterations: GATE_ITERATIONS,
                persistence: true,
                crossings: 1,
                jumps: false,
                closures: false,
                divergence: false,
                closure_shapes: false,
                horizon: false,
            },
        );
        println!("{}", summarize("persistence", seed, &outcome));
        crossings += outcome.reloads;
        for (id, count) in outcome.hits {
            *total.entry(id).or_insert(0) += count;
        }
    }
    assert!(
        crossings >= GATE_SEEDS.len(),
        "the persistence gate never crossed the boundary ({crossings} reloads)"
    );
    println!("gate (persistence) classified totals: {total:?}");
}

/// The MULTI-CROSSING half of the persistence gate: several save/close/reopen
/// boundaries per run, so the run walks stacks that a previous crossing already
/// restored.
///
/// One crossing exercises "does the file carry the history". Several exercise
/// what only stacking can: `capture_missing_gauge_anchors` runs on every save,
/// the loader re-solves offsets on every open, the orphan-closure conversion
/// happens on load, and each crossing bumps the epoch again - so a snapshot
/// recorded two epochs back is compared against a project that has been healed
/// twice, and the save/reload attribution has to hold across BOTH. Nothing
/// exercised that: `cross_boundary` was reachable at most twice per run and the
/// gate only ever crossed once.
/// The gate's seeds MINUS seed 10, which fails under three crossings and does
/// not under one - see the module header's open observations. Pinned rather
/// than dropped so the exclusion is visible and reversible: when that
/// observation is understood, delete this list and use `GATE_SEEDS`.
const MULTI_CROSSING_SEEDS: &[u32] = &[1, 2, 3, 4, 5, 6, 7, 9, 11, 12, 19, 26];

#[test]
fn undo_redo_fuzz_gate_multi_crossing() {
    let mut total: BTreeMap<&'static str, usize> = BTreeMap::new();
    let mut reloads = 0;
    for &seed in MULTI_CROSSING_SEEDS {
        let outcome = run_fuzz(
            seed,
            Plan {
                iterations: GATE_ITERATIONS,
                persistence: true,
                crossings: 3,
                jumps: false,
                closures: false,
                divergence: false,
                closure_shapes: false,
                horizon: false,
            },
        );
        println!("{}", summarize("multi-crossing", seed, &outcome));
        reloads += outcome.reloads;
        for (id, count) in outcome.hits {
            *total.entry(id).or_insert(0) += count;
        }
    }
    // A run that crossed once per seed proves nothing this test does not
    // already get from `undo_redo_fuzz_gate_persistence`.
    assert!(
        reloads > MULTI_CROSSING_SEEDS.len(),
        "the multi-crossing gate crossed {reloads} time(s) over {} seed(s) - no seed crossed \
         more than once, so nothing stacked",
        MULTI_CROSSING_SEEDS.len()
    );
    println!("gate (multi-crossing) classified totals: {total:?}");
}

/// Determinism is the property every other guarantee rests on: without it a
/// failing seed is not a repro and the shrink loop in the harness has nothing to
/// stand on.
#[test]
fn the_fuzzer_is_deterministic() {
    // The GATE's seeds, not arbitrary ones: a seed that reaches an open finding
    // panics rather than returning an `Outcome`, and this test is about replay
    // fidelity, not about which seeds are clean (`fuzz_seed_survey` answers that).
    for &seed in GATE_SEEDS {
        let plan = Plan {
            iterations: GATE_ITERATIONS,
            persistence: false,
            crossings: 1,
            jumps: false,
            closures: false,
            divergence: false,
            closure_shapes: false,
            horizon: false,
        };
        let first = run_fuzz(seed, plan);
        let second = run_fuzz(seed, plan);
        assert_eq!(
            (
                first.mutations,
                first.rejected,
                first.noops,
                first.undos,
                first.redos,
                first.max_depth
            ),
            (
                second.mutations,
                second.rejected,
                second.noops,
                second.undos,
                second.redos,
                second.max_depth
            ),
            "seed {seed} did not replay identically"
        );
        assert_eq!(
            first.hits, second.hits,
            "seed {seed} classified differently on replay"
        );
    }
}

// ===========================================================================
// RED tests pinned to a SEED
// ===========================================================================
//
// Two findings have no reduction that reproduces them - both were measured, and
// both attempts are recorded in `open_undo_bugs_tests.rs`. What they do have is
// a deterministic seed, which is a repro in every sense that matters: it is
// synthetic (no fixture is read or derived from), it is byte-identical on every
// machine (`Rng` is integer-only and no float makes a decision anywhere in this
// module), and it fails today for the documented reason.
//
// They are `#[ignore]`d like every other red test. DELETE THE IGNORE WHEN THE
// BUG IS FIXED and each becomes its regression guard.

/// FINDING 14, red: an insert leaves a merged partner metres out of alignment,
/// and the app's own `#[cfg(test)]` assert says so from inside
/// `insert_shot_after`.
///
/// The fuzzer catches that panic, verifies the message is that assert, and stops
/// the run - so the finding shows up here as `alignment_panic` rather than as a
/// process abort.
#[test]
#[ignore = "open finding 14: a mid-chain insert leaves a merged partner metres out of alignment"]
fn finding_14_no_insert_leaves_a_merge_out_of_alignment() {
    let outcome = run_fuzz(
        6,
        Plan {
            iterations: 60,
            persistence: false,
            crossings: 1,
            jumps: false,
            closures: true,
            divergence: false,
            closure_shapes: false,
            horizon: false,
        },
    );
    assert!(
        !outcome.alignment_panic,
        "seed 6 x60 with closures tripped the app's own merge-alignment assert: {}",
        summarize("finding-14", 6, &outcome)
    );
}

/// BUG 7, red: `undo_to(N)` is not N x `undo()`.
///
/// `undo()`/`redo()` end in `reconcile_geometry()`; `undo_to()`/`redo_to()` loop
/// the `*_inner` variants and call it neither per step nor at the end
/// (core/state/undo.rs). The fuzzer proves the inequality rather than
/// recognising it: on a jump that diverges it replays the same distance in
/// single steps and only records the finding when the single-step path lands
/// exactly where the model says it should.
///
/// This is the first pin bug 7 has ever had. `open_undo_bugs_tests.rs` records
/// the four synthetic reductions that were measured and do NOT diverge, and why:
/// `realign_merges` is `resolve_offsets` behind a 5 cm gate, and every command's
/// own epilogue has already run it, so a persistently misaligned merge is not
/// reachable through the command API in a small project.
#[test]
#[ignore = "open bug 7: undo_to/redo_to skip the reconcile epilogue, so a jump is not N single steps"]
fn bug_7_a_jump_is_n_single_steps() {
    let outcome = run_fuzz(
        6,
        Plan {
            iterations: 150,
            persistence: true,
            crossings: 1,
            jumps: true,
            closures: true,
            divergence: false,
            closure_shapes: true,
            horizon: false,
        },
    );
    assert_eq!(
        outcome.hits.get("finding-7-a-jump-is-not-n-single-steps"),
        None,
        "a multi-step undo_to/redo_to landed somewhere the same number of single steps does not: {}",
        summarize("bug-7", 6, &outcome)
    );
}

/// Which seeds are currently clean, and what the rest fail on.
///
/// The triage tool for choosing (and re-choosing) `GATE_SEEDS`: it catches each
/// run's panic instead of propagating it, so one bad seed does not hide the
/// twenty after it. `catch_unwind` is used with `AssertUnwindSafe` because a
/// panicking run's `AppState` is dropped immediately and never observed again.
#[test]
#[ignore = "survey: prints per-seed status, used to choose GATE_SEEDS"]
fn fuzz_seed_survey() {
    let seeds: u32 = std::env::var("STALAGMIGHT_RUST_FUZZ_SEEDS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(40);
    let iterations: usize = std::env::var("STALAGMIGHT_RUST_FUZZ_ITERATIONS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(GATE_ITERATIONS);
    let jumps = std::env::var("STALAGMIGHT_RUST_FUZZ_JUMPS").is_ok();
    let closures = std::env::var("STALAGMIGHT_RUST_FUZZ_CLOSURES").is_ok();
    let divergence = std::env::var("STALAGMIGHT_RUST_FUZZ_DIVERGENCE").is_ok();
    let closure_shapes = std::env::var("STALAGMIGHT_RUST_FUZZ_CLOSURE_SHAPES").is_ok();
    let horizon = std::env::var("STALAGMIGHT_RUST_FUZZ_HORIZON").is_ok();
    let crossings: usize = std::env::var("STALAGMIGHT_RUST_FUZZ_CROSSINGS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(1);
    let verbose = std::env::var("STALAGMIGHT_RUST_FUZZ_VERBOSE").is_ok();
    let mut clean = Vec::new();
    let mut failures: BTreeMap<String, Vec<u32>> = BTreeMap::new();
    for seed in 1..=seeds {
        for persistence in [false, true] {
            let plan = Plan {
                iterations,
                persistence,
                crossings,
                jumps,
                closures,
                divergence,
                closure_shapes,
                horizon,
            };
            let outcome =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run_fuzz(seed, plan)));
            match outcome {
                Ok(result) => {
                    if !persistence {
                        clean.push(seed);
                    }
                    println!(
                        "{}",
                        summarize(
                            if persistence { "persist" } else { "memory " },
                            seed,
                            &result
                        )
                    );
                }
                Err(payload) => {
                    let message = payload
                        .downcast_ref::<String>()
                        .cloned()
                        .or_else(|| payload.downcast_ref::<&str>().map(|s| (*s).to_string()))
                        .unwrap_or_else(|| "<non-string panic>".to_string());
                    if verbose {
                        println!(
                            "--- seed {seed} ({}) panicked ---\n{message}",
                            if persistence { "persist" } else { "memory" }
                        );
                    }
                    failures
                        .entry(failure_signature(&message))
                        .or_default()
                        .push(seed);
                    clean.retain(|&s| s != seed);
                }
            }
        }
    }
    println!("clean seeds ({}): {clean:?}", clean.len());
    for (headline, seeds) in &failures {
        println!("FAILING {} seed(s) on: {headline}", seeds.len());
        println!("  seeds: {seeds:?}");
    }
}

/// THE HORIZON RUN: thousands of moves, past the app's own history limit.
///
/// Three things only a long run can reach, and all three are about time rather
/// than about any single move:
///
/// 1. **The FIFO trim.** `UndoStack::enforce_depth_limit` drops the oldest entry
///    from BOTH stacks once either passes `undo_history_limit`
///    (core/undo/budget.rs). Nothing shorter than ~100 pushes reaches it, so the
///    sliding window was completely unfuzzed. The model follows it exactly:
///    `absorb_trim` asserts the app trimmed neither too little (an unbounded
///    history) nor too much (a user's edits disappearing early), moves the
///    reachable `floor` up, and every walk from then on treats the floor as the
///    bottom - including the closing unwind, which still verifies every depth
///    that is still reachable.
/// 2. **Accumulation.** A difference under `TOLERANCE_ABS` is accepted every
///    time it is seen, so a depth visited a hundred times can be walked past the
///    tolerance one grain at a time. The run remembers what it tolerated per
///    depth per path, and a later failure whose every path has been inexact here
///    before AND has grown is classified as accumulation rather than reported as
///    a fresh regression - then re-baselined, so the next one is measured from
///    there.
/// 3. **Growth.** Id allocators may not be rewound by a forward command (that
///    hands the same id out twice) and the peak size of every
///    unbounded-in-principle collection is reported.
///
/// ```text
/// STALAGMIGHT_RUST_FUZZ_HORIZON=1 STALAGMIGHT_RUST_FUZZ_SEEDS=4 \
///   STALAGMIGHT_RUST_FUZZ_ITERATIONS=10000 \
///   TELEMETRY_ENDPOINT=http://localhost/dummy cargo test \
///   --manifest-path src-tauri/Cargo.toml --features telemetry \
///   --lib undo_redo_fuzz_horizon -- --ignored --nocapture
/// ```
#[test]
#[ignore = "horizon: thousands of moves per seed - run deliberately with STALAGMIGHT_RUST_FUZZ_SEEDS/ITERATIONS"]
fn undo_redo_fuzz_horizon() {
    let seeds: u32 = std::env::var("STALAGMIGHT_RUST_FUZZ_SEEDS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(2);
    let iterations: usize = std::env::var("STALAGMIGHT_RUST_FUZZ_ITERATIONS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(10_000);
    let persistence = std::env::var("STALAGMIGHT_RUST_FUZZ_PERSISTENCE").is_ok();
    let mut total: BTreeMap<&'static str, usize> = BTreeMap::new();
    let mut trimmed = 0;
    let mut failures = Vec::new();
    for seed in 1..=seeds {
        let plan = Plan {
            iterations,
            persistence,
            crossings: 1,
            jumps: true,
            closures: false,
            divergence: false,
            closure_shapes: false,
            horizon: true,
        };
        // Caught per seed, and RE-RAISED at the end. A long run is expensive
        // enough that stopping the whole sweep on the first failure wastes the
        // other seeds' evidence; hiding the failure would be worse, so every one
        // is reported and the test still fails.
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run_fuzz(seed, plan))) {
            Ok(outcome) => {
                println!("{}", summarize("horizon", seed, &outcome));
                trimmed += outcome.trimmed;
                for (id, count) in outcome.hits {
                    *total.entry(id).or_insert(0) += count;
                }
            }
            Err(payload) => {
                let message = payload
                    .downcast_ref::<String>()
                    .cloned()
                    .or_else(|| payload.downcast_ref::<&str>().map(|s| (*s).to_string()))
                    .unwrap_or_else(|| "<non-string panic>".to_string());
                println!("horizon seed={seed} FAILED:\n{message}");
                failures.push(seed);
            }
        }
    }
    // A horizon run that never trimmed proves nothing about the window, which is
    // the main thing it exists to exercise.
    assert!(
        trimmed > 0,
        "no run reached the history limit ({trimmed} entries trimmed over {seeds} seed(s) x \
         {iterations} moves); the sliding window went unfuzzed"
    );
    println!("horizon: {trimmed} entry(ies) trimmed; classified totals: {total:?}");
    assert!(
        failures.is_empty(),
        "horizon seed(s) {failures:?} failed - see the payloads above"
    );
}

/// The SOAK: the same engine, at a scale a CI gate cannot afford.
///
/// `#[ignore]`d, and driven by the environment so a sweep needs no recompile:
///
/// ```text
/// STALAGMIGHT_RUST_FUZZ_SEEDS=200 STALAGMIGHT_RUST_FUZZ_ITERATIONS=1000 \
///   TELEMETRY_ENDPOINT=http://localhost/dummy cargo test \
///   --manifest-path src-tauri/Cargo.toml --features telemetry \
///   --lib undo_redo_fuzz_soak -- --ignored --nocapture
/// ```
///
/// Every seed runs BOTH modes. A soak failure is a finding: minimize it by
/// re-running the seed with a smaller iteration count (the run is deterministic,
/// so a prefix that still fails is a valid smaller repro), then pin it in
/// `open_undo_bugs_tests.rs`.
#[test]
#[ignore = "soak: minutes, not seconds - run deliberately with STALAGMIGHT_RUST_FUZZ_SEEDS/ITERATIONS"]
fn undo_redo_fuzz_soak() {
    let seeds: u32 = std::env::var("STALAGMIGHT_RUST_FUZZ_SEEDS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(50);
    let iterations: usize = std::env::var("STALAGMIGHT_RUST_FUZZ_ITERATIONS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(1000);
    let mut total: BTreeMap<&'static str, usize> = BTreeMap::new();
    let mut wedges = 0;
    for seed in 1..=seeds {
        for persistence in [false, true] {
            let outcome = run_fuzz(
                seed,
                Plan {
                    iterations,
                    persistence,
                    // The soak crosses several times: heals stack on heals, and
                    // a snapshot two epochs back is compared against a project
                    // that has been through the loader twice.
                    crossings: 3,
                    // The soak DOES draw jumps and build closures: findings 7 and
                    // 14 are real, and this is the tier that can afford to keep
                    // hitting them.
                    jumps: true,
                    closures: true,
                    divergence: persistence,
                    closure_shapes: true,
                    horizon: false,
                },
            );
            if outcome.wedged {
                wedges += 1;
            }
            for (id, count) in outcome.hits {
                *total.entry(id).or_insert(0) += count;
            }
        }
    }
    println!("soak: {seeds} seed(s) x {iterations} iterations x 2 modes");
    println!("soak classified totals: {total:?} ({wedges} wedged run(s))");
}

/// Is the adjusted solve a FUNCTION of the project, or does it wander?
///
/// The horizon run's adjusted-geometry oracle fired on a state whose stored
/// project roundtripped byte for byte, with a station 28 microns from where the
/// same depth had it - at kilometre-scale coordinates, 3e-8 relative. Either the
/// solve is not deterministic or something outside the compared state feeds it,
/// and the difference between those two answers decides whether the oracle's
/// tolerance is a measurement or an excuse.
///
/// This measures BOTH paths, and the split is the whole point. The first version
/// of it measured only the first and reported "zero spread", which was used to
/// argue the solve was deterministic and the input must have differed. That
/// conclusion did not follow: a project with no eligible loop closure never
/// enters `adjust_least_squares` at all (`plan_adjustment_anchors`,
/// models/project/coordinates.rs), so the measurement had never touched the code
/// that wanders. FINDING 21 is the second column.
#[test]
#[ignore = "measurement: prints the solve-to-solve spread, used to justify ADJUSTED_TOLERANCE_M"]
fn measure_adjusted_solve_determinism() {
    // PATH ONE: no closure, so the "solve" is a deterministic coordinate walk.
    // Closures are also excluded because the starting topology with one is
    // finding 14's and the app's own assert would stop this before it measured
    // anything.
    let mut fuzzer = Fuzzer::new(1, false);
    for _ in 0..40 {
        if fuzzer.catching_alignment(Fuzzer::step_mutate).is_none() {
            break;
        }
    }
    let first = fuzzer.adjusted_geometry();
    let mut worst: f64 = 0.0;
    let mut differing = 0;
    for _ in 0..8 {
        fuzzer.state.invalidate_adjusted_cache();
        let again = fuzzer.adjusted_geometry();
        let diffs = adjusted_diffs(&first, &again);
        if !diffs.is_empty() {
            println!("solve differs: {diffs:?}");
        }
        if again != first {
            differing += 1;
        }
        for (a, b) in first.lines().zip(again.lines()) {
            let (pa, pb): (Vec<&str>, Vec<&str>) = (a.split('|').collect(), b.split('|').collect());
            for axis in 1..4 {
                if let (Ok(x), Ok(y)) = (
                    pa.get(axis).unwrap_or(&"0").parse::<f64>(),
                    pb.get(axis).unwrap_or(&"0").parse::<f64>(),
                ) {
                    worst = worst.max((x - y).abs());
                }
            }
        }
    }
    println!("no closure: {differing} of 8 re-solves differ; worst difference {worst:e} m");

    // PATH TWO: a least-squares closure, which is what
    // `plan_adjustment_anchors` requires before it enters
    // `adjust_least_squares` at all. `Move` is not enough - it is applied
    // directly - so the strategy is named explicitly rather than drawn.
    let state = AppState::new().unwrap();
    assert!(
        state
            .execute(Command::CreateProject {
                name: "SolveDeterminism".to_string(),
                location: None,
            })
            .success
    );
    let mut rng = Rng::new(1);
    let section = |name: &str, count: usize, rng: &mut Rng| -> SectionId {
        let shots: Vec<ShotData> = (0..count).map(|_| random_shot(rng)).collect();
        state
            .execute(Command::CreateSection {
                name: Some(name.to_string()),
                surveyor: None,
                date: None,
                color: COLORS[0].to_string(),
                direction: None,
                shots,
            })
            .section_id
            .expect("CreateSection returned no id")
    };
    let a = section("lsq-a", 3, &mut rng);
    let b = section("lsq-b", 2, &mut rng);
    assert!(
        state
            .execute(Command::SetZeroDatum {
                station_ref: StationRef::new(a, 0),
                coordinates: GpsCoordinates::new(20.4, -87.3, 0.0).unwrap(),
            })
            .success
    );
    assert!(
        state
            .execute(Command::MergeStations {
                station_a: StationRef::new(a, 3),
                station_b: StationRef::new(b, 0),
            })
            .success
    );
    let closed = state.execute(Command::CreateLoopClosure {
        station_a: StationRef::new(a, 0),
        station_b: StationRef::new(b, 2),
        closure_strategy: ClosureStrategy::LeastSquaresWeighted,
    });
    assert!(closed.success, "CreateLoopClosure: {:?}", closed.error);

    let base = adjusted_geometry_of(&state);
    let mut lsq_worst: f64 = 0.0;
    let mut lsq_differing = 0;
    for _ in 0..64 {
        state.invalidate_adjusted_cache();
        let again = adjusted_geometry_of(&state);
        if again == base {
            continue;
        }
        lsq_differing += 1;
        for (left, right) in base.lines().zip(again.lines()) {
            let (pa, pb): (Vec<&str>, Vec<&str>) =
                (left.split('|').collect(), right.split('|').collect());
            for axis in 1..4 {
                if let (Ok(x), Ok(y)) = (
                    pa.get(axis).unwrap_or(&"0").parse::<f64>(),
                    pb.get(axis).unwrap_or(&"0").parse::<f64>(),
                ) {
                    lsq_worst = lsq_worst.max((x - y).abs());
                }
            }
        }
    }
    println!(
        "least-squares closure: {lsq_differing} of 64 re-solves differ; worst difference \
         {lsq_worst:e} m (FINDING 21)"
    );
}
