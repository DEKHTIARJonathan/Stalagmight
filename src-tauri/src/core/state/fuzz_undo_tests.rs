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
//! | `open_undo_bugs_tests.rs` | `AppState` directly | the eleven KNOWN open bugs, pinned | `-- --ignored` |
//!
//! # What it does NOT cover
//!
//! Everything above the `AppState` boundary: the projectStore actions, the IPC
//! serialization (notably serde's double-option, which is how bug 5 was found),
//! and the frontend's own bookkeeping. Those are the harness's job and the
//! reason it stays.
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
struct Rng {
    state: u32,
}

impl Rng {
    const fn new(seed: u32) -> Self {
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
    fn below(&mut self, bound: usize) -> usize {
        if bound == 0 {
            return 0;
        }
        (self.next_u32() as usize) % bound
    }

    /// Inclusive integer range.
    fn range(&mut self, min: i64, max: i64) -> i64 {
        if max <= min {
            return min;
        }
        let span = (max - min + 1) as usize;
        min + self.below(span) as i64
    }

    /// True with probability `percent`/100.
    fn chance(&mut self, percent: u32) -> bool {
        (self.next_u32() % 100) < percent
    }

    /// A float in `[min, max]`, quantized to 1/1000 so the value is a function of
    /// an INTEGER draw. Generating it from the raw u32 as a fraction would make
    /// the produced value depend on f64 rounding; this cannot.
    fn float(&mut self, min: f64, max: f64) -> f64 {
        let steps = self.range(0, 1000) as f64;
        min + (max - min) * (steps / 1000.0)
    }

    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
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
const GEOMETRY_EXTREME: f64 = 1e3;

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
struct Diff {
    path: String,
    expected: String,
    actual: String,
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

fn diff_snapshots(expected: &str, actual: &str) -> Vec<Diff> {
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

fn describe_diffs(diffs: &[Diff]) -> String {
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
/// The harness tier cannot see this - its bridge only knows the move's DIRECTION
/// - which is why its gauge-anchor classifier has to conflate findings 1 and 11.
/// Here the entry that a move consumed is a `get_undo_stack` read away, so the
/// two can be told apart precisely, and several other classifiers can be narrowed
/// to the exact entry shape their bug needs instead of to a path alone.
#[derive(Clone, Copy)]
struct MoveCtx<'a> {
    /// The entry the move consumed, when the move was an undo or a redo.
    entry: Option<&'a EntryMeta>,
    /// Has this run crossed a save?
    after_save: bool,
    /// Has this run reopened a saved project?
    after_reload: bool,
    /// The run's current epoch; an entry with a lower one predates the last save.
    epoch: u32,
    /// Has finding 1 or finding 11 ALREADY reverted the save's gauge capture in
    /// this run?
    heal_reverted: bool,
    /// Sections finding 3 has already displaced in this run, and the canonical
    /// text of the `section_offsets` value it left behind. See the cascade
    /// classifier.
    displaced: &'a BTreeMap<SectionId, String>,
}

impl MoveCtx<'_> {
    fn command_is(&self, command: &str) -> bool {
        self.entry.is_some_and(|entry| entry.command == command)
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
        self.entry.and_then(|entry| entry.appended_into_empty)
    }

    /// Does `diff` sit on the `section_offsets` key of a section finding 3 has
    /// already displaced, with the exact value it left on one side of it?
    fn is_finding_3_leftover(&self, diff: &Diff) -> bool {
        let Some((section_id, element)) = offset_key_of(&diff.path) else {
            return false;
        };
        let Some(recorded) = self.displaced.get(&section_id) else {
            return false;
        };
        // For a whole-key diff the recorded text is the pair; for an element diff
        // it is that element of the pair. Either way the leftover has to appear
        // VERBATIM on one side, so a section that has since acquired a different
        // offset is not this and still fails.
        let Some(leftover) = element.map_or_else(
            || Some(recorded.clone()),
            |index| {
                serde_json::from_str::<serde_json::Value>(recorded)
                    .ok()?
                    .get(index)
                    .map(ToString::to_string)
            },
        ) else {
            return false;
        };
        diff.expected == leftover || diff.actual == leftover
    }
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
        matches: |d, ctx| ctx.is_finding_3_leftover(d),
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
    path_is(diff, "section_offsets.#") || diff.path.starts_with("station_offsets")
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

/// FINDING 4's structural signature: `loop_closures` holds the same members in a
/// different order and the snapshots are otherwise identical. Undo of
/// `RemoveLoopClosure` pushes instead of re-inserting at the removed index.
fn is_closure_reorder(expected: &str, actual: &str) -> bool {
    let (Ok(mut left), Ok(mut right)) = (
        serde_json::from_str::<serde_json::Value>(expected),
        serde_json::from_str::<serde_json::Value>(actual),
    ) else {
        return false;
    };
    let sort_closures = |value: &mut serde_json::Value| -> bool {
        let Some(list) = value
            .get_mut("loop_closures")
            .and_then(|c| c.as_array_mut())
        else {
            return false;
        };
        if list.len() < 2 {
            return false;
        }
        list.sort_by_key(ToString::to_string);
        true
    };
    if !sort_closures(&mut left) || !sort_closures(&mut right) {
        return false;
    }
    let mut diffs = Vec::new();
    diff_values(&left, &right, "", &mut diffs);
    diffs.is_empty()
}

// ===========================================================================
// Synthetic starting project
// ===========================================================================

const COLORS: &[&str] = &["#3388FF", "#FF8833", "#33CC66", "#CC33AA", "#FFCC00"];

/// A valid, unremarkable shot. Every value comes from an integer draw.
fn random_shot(rng: &mut Rng) -> ShotData {
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
fn build_project(state: &AppState, rng: &mut Rng, closures: bool) -> Vec<SectionId> {
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
struct Targets {
    /// `(section_id, [shot_id, ...])`, ascending.
    sections: Vec<(SectionId, Vec<ShotId>)>,
    /// `(section_id, station_index)`, ascending.
    stations: Vec<(SectionId, u32)>,
    /// Merged pairs, as resolved positional refs, ascending.
    merges: Vec<((SectionId, u32), (SectionId, u32))>,
    /// Zero-datum stations, ascending.
    datums: Vec<(SectionId, u32)>,
    /// Loop closure ids, ascending.
    closures: Vec<u64>,
}

fn read_targets(state: &AppState) -> Targets {
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

fn random_offset(rng: &mut Rng) -> Coordinates {
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
}

struct Fuzzer {
    state: AppState,
    rng: Rng,
    seed: u32,
    /// `snapshots[d]` is the canonical project at undo depth `d`.
    snapshots: Vec<String>,
    /// Epoch each snapshot was recorded in; a save or a reload bumps the epoch.
    epochs: Vec<u32>,
    /// `entry_meta[d]` describes the entry that takes depth d-1 to d. Index 0 is
    /// a placeholder so the indexing matches `snapshots`.
    entry_meta: Vec<EntryMeta>,
    epoch: u32,
    cursor: usize,
    top: usize,
    /// Human-readable move history, tailed into a failure payload.
    log: Vec<String>,
    id_agnostic: bool,
    outcome: Outcome,
    /// Kept alive for the run: dropping it deletes the save file.
    temp: Option<TempDir>,
    /// May the generators create loop closures? See `Plan::closures`.
    closures: bool,
    /// Set once findings 1 or 11 have reverted the save's gauge capture. From then
    /// on the live project no longer HAS the anchors, so every later depth
    /// recorded with them disagrees - the same defect, re-measured. See the
    /// cascade classifier.
    heal_reverted: bool,
    /// Sections finding 3 has displaced, and the canonical text of the
    /// `section_offsets` value it left. Same idea as `heal_reverted`, one
    /// defect down: the slide is never undone, so every deeper snapshot
    /// recorded without it disagrees until a snapshot-pair entry heals it.
    displaced: BTreeMap<SectionId, String>,
    /// Sections whose station-0 refs finding 3 has destroyed. Same cascade, on
    /// the data-loss half of the same branch.
    ref_dropped: BTreeSet<SectionId>,
}

impl Fuzzer {
    fn new(seed: u32, closures: bool) -> Self {
        let state = AppState::new().unwrap();
        let mut rng = Rng::new(seed);
        build_project(&state, &mut rng, closures);
        let mut fuzzer = Self {
            state,
            rng,
            seed,
            snapshots: Vec::new(),
            epochs: Vec::new(),
            entry_meta: vec![EntryMeta::default()],
            epoch: 0,
            cursor: 0,
            top: 0,
            log: Vec::new(),
            id_agnostic: false,
            outcome: Outcome::default(),
            temp: None,
            closures,
            heal_reverted: false,
            displaced: BTreeMap::new(),
            ref_dropped: BTreeSet::new(),
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
    fn snapshot(&self) -> String {
        let raw = self
            .state
            .capture_project_snapshot()
            .expect("capture_project_snapshot failed");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("snapshot is not JSON");
        canonicalize(&parsed, "", self.id_agnostic).to_string()
    }

    /// Re-express every recorded snapshot in id-agnostic form. Called once, on the
    /// first reload: `Shot::id` is not persisted, so from then on a byte-exact
    /// comparison against a pre-reload snapshot would report the renumbering as
    /// drift.
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
    fn expect_state(&mut self, depth: usize, what: &str, consumed: Option<EntryMeta>) {
        let ctx_entry = consumed;
        // Cloned rather than borrowed: the classification loop below records new
        // displacements into `self`, and a live borrow of the map would make
        // that a borrow error. The map holds one small entry per section finding
        // 3 has displaced.
        let displaced = self.displaced.clone();
        let ctx = MoveCtx {
            entry: ctx_entry.as_ref(),
            after_save: self.outcome.saves > 0,
            after_reload: self.outcome.reloads > 0,
            epoch: self.epoch,
            heal_reverted: self.heal_reverted,
            displaced: &displaced,
        };
        let actual = self.snapshot();
        let expected = self.snapshots[depth].clone();
        if expected == actual {
            return;
        }
        let mut diffs = diff_snapshots(&expected, &actual);
        if diffs.is_empty() {
            self.outcome.float_noise += 1;
            return;
        }

        // FINDING 3's DATA-LOSS half, subtracted before anything else looks at
        // the diffs: a dropped merge re-indexes the list, so every field of every
        // later entry reads as changed and the offset half of the SAME hit would
        // be buried under twenty derived paths. Only ever applied when the
        // consumed entry is the empty-section append the finding needs, and only
        // when refs to that section's station 0 were really lost.
        let mut ref_drop = None;
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
                    self.record_displacement(ctx.appended_into_empty(), &actual);
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
            return;
        }

        // Structural signatures, checked only over what the path rules could not
        // explain. Order matters: a whole-section uuid re-mint (finding 1) also
        // reads as "different shots are present", so the path classifiers get
        // first refusal.
        if is_closure_reorder(&expected, &actual) {
            *self
                .outcome
                .hits
                .entry("finding-4-closure-reordered-on-undo")
                .or_insert(0) += 1;
            self.resync(depth, actual);
            return;
        }
        if ctx.after_reload && is_shot_identity_swap(&expected, &actual) {
            *self
                .outcome
                .hits
                .entry("finding-8-or-12-stale-id-hits-the-wrong-shot")
                .or_insert(0) += 1;
            self.resync(depth, actual);
            return;
        }

        let entry_note = ctx_entry.as_ref().map_or_else(
            || "  consumed entry: (none - not a history move)".to_string(),
            |entry| {
                format!(
                    "  consumed entry: {} (pushed in epoch {}, run epoch {}{})",
                    entry.command,
                    entry.epoch,
                    self.epoch,
                    if entry.appended_into_empty.is_some() {
                        ", appended into an EMPTY section"
                    } else {
                        ""
                    }
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

    /// Remember what finding 3 left in `section_offsets`, so the cascade
    /// classifier can recognise the SAME value later and nothing else.
    ///
    /// The value is read out of the snapshot the hit was measured against, in
    /// its canonical form, which is the exact text a later `Diff` will carry.
    fn record_displacement(&mut self, section_id: Option<SectionId>, actual: &str) {
        let Some(section_id) = section_id else {
            return;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(actual) else {
            return;
        };
        let Some(offset) = value
            .get("section_offsets")
            .and_then(|offsets| offsets.get(section_id.to_string()))
        else {
            return;
        };
        self.displaced.insert(section_id, offset.to_string());
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
        let Some(project) = self.state.get_project_state() else {
            return;
        };
        // The RAW check, deliberately, and not `check_merge_alignment()`: the two
        // disagree. `check_merge_alignment` measures through
        // `resolved_station_offsets()`, which folds in closure adjustment, while
        // `debug_assert_merge_alignment` measures `compute_station_raw_coords`.
        // Only the second one panics the process, so the second one is what this
        // has to pre-empt if a violation is to be attributed to the move that
        // caused it rather than to the next command that happens to look.
        let mut messages = Vec::new();
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
            let (Some(pa), Some(pb)) = (
                project.compute_station_raw_coords(a),
                project.compute_station_raw_coords(b),
            ) else {
                continue;
            };
            let dist = ((pa.x - pb.x).powi(2) + (pa.y - pb.y).powi(2)).sqrt();
            if dist >= 0.01 {
                messages.push(format!(
                    "merged {}:{} and {}:{} are {dist:.6} m apart (raw)",
                    a.section_id, a.station_index, b.section_id, b.station_index
                ));
            }
        }
        if messages.is_empty() {
            return;
        }
        self.fail(
            &format!("{what} left a station merge out of alignment"),
            &format!("  {}", messages.join("\n  ")),
        );
    }

    fn expect_stacks(&self, what: &str) {
        let (want_undo, want_redo) = (self.cursor, self.top - self.cursor);
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
}

impl Drawn {
    fn new(label: String, result: CommandResult) -> Self {
        Self {
            label,
            result,
            appended_into_empty: None,
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
        Some(drawn)
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
        Some(Drawn::new(
            format!("updateShot(s={section_id},shot={shot_id})"),
            self.state.execute(Command::UpdateShot {
                section_id,
                shot_id,
                updates,
            }),
        ))
    }

    fn gen_set_shot_kind(&mut self, targets: &Targets) -> Option<Drawn> {
        let (section_id, shot_id) = self.pick_shot(targets)?;
        let kind = *self
            .rng
            .pick(&[ShotKind::Normal, ShotKind::Jump, ShotKind::Reference]);
        Some(Drawn::new(
            format!("setShotKind(s={section_id},shot={shot_id},{kind:?})"),
            self.state.execute(Command::SetShotKind {
                section_id,
                shot_id,
                kind,
            }),
        ))
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
/// fire and silently invalidate `snapshots[0]`.
const MAX_MODEL_DEPTH: usize = 40;

impl Fuzzer {
    /// One mutation, with the full case analysis on what the stacks did.
    fn step_mutate(&mut self) {
        let before_undo = self.undo_len();
        let before_redo = self.redo_len();
        let Some(drawn) = self.draw_mutation() else {
            return;
        };
        let accepted = drawn.result.success;
        let pushed = self.undo_len().saturating_sub(before_undo);
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
            self.expect_state(self.cursor, "a rejected command", None);
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
            self.epochs.truncate(self.cursor);
            self.entry_meta.truncate(self.cursor);
            let snapshot = self.snapshot();
            self.snapshots.push(snapshot);
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
            });
            self.outcome.mutations += 1;
            self.outcome.max_depth = self.outcome.max_depth.max(self.cursor);
            self.expect_merges_aligned(&drawn.label);
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
            self.epochs.truncate(self.cursor + 1);
            self.entry_meta.truncate(self.cursor + 1);
        } else if self.redo_len() != before_redo {
            self.fail(
                "a no-op command changed the redo stack without clearing it",
                &format!("  after {}", drawn.label),
            );
        }
        self.expect_state(self.cursor, "a no-op command", None);
    }

    /// Did a failed history move fail for a KNOWN, documented reason?
    ///
    /// Both of these leave the entry on its stack (`undo_inner`'s epilogue pushes
    /// it back), so the history is WEDGED and the walk cannot continue - which is
    /// why the caller stops rather than retrying.
    fn classify_move_failure(&mut self, error: &str) -> Option<&'static str> {
        if error.contains("part of a loop") || error.contains("zero datum") {
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

    /// One history move. `steps` > 1 goes through `undo_to`/`redo_to`, the
    /// history dropdown's multi-step path, verified against the SAME snapshots
    /// single steps recorded - an equivalence that is not free, because
    /// `undo_to`/`redo_to` loop the `*_inner` variants and call neither
    /// `invalidate_adjusted_cache()` nor `reconcile_geometry()` (finding 7).
    ///
    /// Returns false when a known wedge stopped it.
    fn step_history(&mut self, back: bool, steps: usize) -> bool {
        let reach = if back {
            self.cursor
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
        let consumed = if back {
            self.entry_meta.get(self.cursor).cloned()
        } else {
            self.entry_meta.get(self.cursor + 1).cloned()
        };
        let result = if back {
            if jumped {
                self.state.undo_to(steps - 1)
            } else {
                self.state.undo()
            }
        } else if jumped {
            self.state.redo_to(steps - 1)
        } else {
            self.state.redo()
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
        self.expect_state(self.cursor, &label, consumed);
        self.expect_merges_aligned(&label);
        true
    }

    /// Save to a temp path, close, reopen. Undo history is PERSISTED - both stacks
    /// serialize into the `.stalx` and restore on open - so nothing below a save
    /// point is exercised until a run crosses this boundary. Findings 8, 12 and 13
    /// all live on the other side of it.
    fn cross_boundary(&mut self) -> bool {
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
        self.note(format!("save -> ok (depth {})", self.cursor));
        self.expect_stacks("save");
        self.expect_state(self.cursor, "save", None);

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
        self.expect_state(self.cursor, "reload", None);
        true
    }

    /// The closing guarantee: unwind every entry to depth 0, then replay every
    /// entry back to the top, verifying the recorded snapshot at each depth in
    /// BOTH directions.
    fn finish(&mut self) {
        let summit = self.top;
        while self.cursor > 0 {
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
}

fn run_fuzz(seed: u32, plan: Plan) -> Outcome {
    let mut fuzzer = Fuzzer::new(seed, plan.closures);
    // Crossing at a third of the way in leaves entries both below and above the
    // boundary, so the closing walk covers restored UNDO entries and restored
    // REDO entries alike.
    let boundary_at = if plan.persistence {
        plan.iterations / 3
    } else {
        usize::MAX
    };

    for iteration in 0..plan.iterations {
        if iteration == boundary_at {
            fuzzer.cross_boundary();
        }
        // 60 / 25 / 15 mutate / undo / redo, re-rolled when the stack a move
        // needs is empty. Same mix as the harness.
        let roll = fuzzer.rng.below(100);
        let mut back = roll >= 60 && roll < 85;
        let mut forward = roll >= 85;
        if forward && fuzzer.cursor >= fuzzer.top {
            forward = false;
            back = fuzzer.cursor > 0;
        }
        if back && fuzzer.cursor == 0 {
            back = false;
        }
        if !back && !forward {
            if fuzzer.cursor >= MAX_MODEL_DEPTH {
                if !fuzzer.step_history(true, 1) {
                    break;
                }
                continue;
            }
            fuzzer.step_mutate();
            continue;
        }
        // About one history move in ten is taken as a multi-step jump.
        let reach = if back {
            fuzzer.cursor
        } else {
            fuzzer.top - fuzzer.cursor
        };
        let steps = if plan.jumps && reach > 1 && fuzzer.rng.chance(10) {
            1 + fuzzer.rng.below(reach)
        } else {
            1
        };
        if !fuzzer.step_history(back, steps) {
            break;
        }
    }

    if !fuzzer.outcome.wedged {
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

/// Seeds the gate runs, in both modes. Fixed rather than random: a gate whose
/// input moves is not a gate.
/// Seeds the gate runs, in both modes.
///
/// PINNED, and pinned deliberately rather than arbitrarily. `fuzz_seed_survey`
/// (below) reports which seeds are currently clean; these six are clean at 100
/// moves, so they have headroom above the 60 the gate uses. The other 32 of the
/// first 40 reach an OPEN, unclassified finding within 100 moves - findings 14
/// and 15 on <https://github.com/Stalagmight/Stalagmight/issues/413>, both found
/// by this module and both written up there before these seeds were chosen.
///
/// That is a real limit on what the gate proves, and it is stated rather than
/// hidden: the gate guards against NEW ways for the undo model to be wrong on
/// short sequences, not against the ones already known. Re-run the survey and
/// widen this list as findings are fixed; the soak is what keeps hitting them
/// meanwhile.
const GATE_SEEDS: &[u32] = &[1, 3, 6, 12, 19, 26];
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
         {} jumps, {} saves, {} reloads, depth<={}, float-noise={}, attributed={}{}{}",
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
        if outcome.wedged { " WEDGED" } else { "" },
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
                jumps: false,
                closures: false,
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
                jumps: false,
                closures: false,
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
            jumps: false,
            closures: false,
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
    let verbose = std::env::var("STALAGMIGHT_RUST_FUZZ_VERBOSE").is_ok();
    let mut clean = Vec::new();
    let mut failures: BTreeMap<String, Vec<u32>> = BTreeMap::new();
    for seed in 1..=seeds {
        for persistence in [false, true] {
            let plan = Plan {
                iterations,
                persistence,
                jumps,
                closures,
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
                    // The soak DOES draw jumps and build closures: findings 7 and
                    // 14 are real, and this is the tier that can afford to keep
                    // hitting them.
                    jumps: true,
                    closures: true,
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
