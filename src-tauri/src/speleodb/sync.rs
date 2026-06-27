//! Pure SpeleoDB sync-engine logic — the data-loss-critical decisions, with no
//! I/O.
//!
//! These functions take the SHAs / commit lists already fetched by the client
//! and return a typed verdict that the orchestration in
//! [`crate::core::state::speleodb`] acts on. Keeping the policy pure makes every
//! branch exhaustively unit-testable offline, which is what the guardrail suite
//! (#211) relies on.
//!
//! - [`fence`] — the base-SHA divergence fence (#192): BASE vs server tip.
//! - [`classify_ancestry`] — guardrail-7 ancestry recovery (#193): after a push
//!   whose confirmation was lost, did my edit actually land on the server?

use std::collections::HashMap;

use super::models::RevisionCommit;

/// Verdict of the base-SHA fence: our recorded BASE commit compared against the
/// server's current tip, given whether we hold un-pushed local edits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FenceOutcome {
    /// Server tip == our BASE (including both at the empty-repo BASE). There is
    /// no remote change to reconcile; any local dirty edits are simply ours to
    /// push.
    UpToDate,
    /// Server advanced beyond our BASE and we hold NO local edits — safe to
    /// fast-forward (pull the server state and re-stamp BASE).
    FastForward,
    /// Server advanced beyond our BASE AND we hold un-pushed local edits — a
    /// genuine divergence. NEVER auto-resolved or overwritten; the caller
    /// surfaces it for the user to reconcile.
    Diverged,
    /// Anomalous: we hold a BASE commit but the server reports no tip at all
    /// (e.g. a transient/empty response, or a vanished commit). Fail closed —
    /// the caller should re-fetch once before trusting it and must never assume
    /// it may overwrite the server.
    FailClosed,
}

/// The base-SHA divergence fence (#192).
///
/// Compares our recorded BASE against the server tip to decide whether starting
/// to edit (or refreshing) is a no-op, a safe fast-forward, a divergence, or an
/// anomaly to fail closed on. The server has **no** optimistic-concurrency
/// control (last-writer-wins), so this client-side fence is the *only* thing
/// standing between a stale local copy and silently clobbering someone else's
/// push.
///
/// - `base`  — our `speleo_link.base_commit_sha` (`None` = empty-repo BASE).
/// - `tip`   — the server's current latest commit (`None` = server reports none).
/// - `dirty` — `has_unpushed_edits`.
#[must_use]
pub(crate) fn fence(base: Option<&str>, tip: Option<&str>, dirty: bool) -> FenceOutcome {
    match (base, tip) {
        // base == tip (including the empty-repo None == None): nothing remote to
        // reconcile. The dirty bit is orthogonal — those edits are ours to push.
        (None, None) => FenceOutcome::UpToDate,
        (Some(b), Some(t)) if b == t => FenceOutcome::UpToDate,
        // We based on a real commit but the server now reports none — anomalous,
        // never an invitation to overwrite.
        (Some(_), None) => FenceOutcome::FailClosed,
        // Server tip moved beyond our BASE: either (None -> Some) (the repo
        // gained its first commit since we pulled the empty BASE) or two
        // differing Somes. Clean -> fast-forward; dirty -> divergence.
        _ => {
            if dirty {
                FenceOutcome::Diverged
            } else {
                FenceOutcome::FastForward
            }
        }
    }
}

/// Verdict of guardrail-7 ancestry recovery: after a push whose confirmation was
/// lost, whether our edit landed on the server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AncestryOutcome {
    /// The server tip is still our BASE — our push is NOT on the server. The
    /// re-push is retry-safe.
    NotLanded,
    /// Our push landed: every commit between BASE (exclusive) and the tip is ours
    /// and forms a linear chain back to BASE (or to the root, for an empty-repo
    /// BASE). Advance BASE to the tip. `clear_dirty` is true ONLY when no local
    /// edit happened after the push began (`last_edit_at <= push_start_at`); a
    /// post-push edit is not in the landed commit, so the dirty bit must stay set.
    Landed { clear_dirty: bool },
    /// A commit authored by someone else sits between BASE and the tip — a real
    /// divergence. Never overwritten.
    Diverged,
    /// History we cannot reason about safely (a merge / multiple parents, a
    /// referenced commit missing from the fetched history, or a tip we can't
    /// resolve). Fail closed.
    FailClosed,
}

/// Guardrail-7 ancestry recovery (#193).
///
/// Invoked when a push's confirmation was lost (an ambiguous result): the dirty
/// bit is still set and BASE still old, but the edit may or may not have reached
/// the server. We fetch the linear revision history and classify whether our
/// edit landed, so we never re-push over our own landed commit nor clobber a
/// stranger's.
///
/// **Assumption (documented):** a project is edited from a single account in a
/// single session at a time (the single-writer lock enforces this). "My" commits
/// are identified purely by `author_email == my_email`; a second device editing
/// the same project under the same account concurrently is out of scope.
///
/// - `base` — our recorded BASE (`None` = empty-repo BASE).
/// - `tip` — the server's current tip (`None` = server reports none).
/// - `commits` — the project's linear revision history.
/// - `my_email` — the authenticated user's email.
/// - `last_edit_at` / `push_start_at` — RFC-3339 UTC timestamps gating whether
///   the landed push captured all our edits (see [`AncestryOutcome::Landed`]).
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "ancestry-recovery caller is #194/#197 (Unit 4/6)")
)]
pub(crate) fn classify_ancestry(
    base: Option<&str>,
    tip: Option<&str>,
    commits: &[RevisionCommit],
    my_email: &str,
    last_edit_at: Option<&str>,
    push_start_at: Option<&str>,
) -> AncestryOutcome {
    // 1. Server tip unchanged from our BASE (incl. None == None): our push is not
    //    on the server, so it is safe to retry.
    if base == tip {
        return AncestryOutcome::NotLanded;
    }
    // 2. base != tip. A vanished server tip (base Some, tip None) is anomalous.
    let Some(tip) = tip else {
        return AncestryOutcome::FailClosed;
    };

    let by_id: HashMap<&str, &RevisionCommit> =
        commits.iter().map(|c| (c.id.as_str(), c)).collect();

    // 3. Walk the linear chain from the tip back toward BASE (or the root, for an
    //    empty-repo BASE), collecting the commits new relative to BASE.
    let mut cursor: &str = tip;
    let mut new_commits: Vec<&RevisionCommit> = Vec::new();
    loop {
        // Reached our BASE: the chain base..tip is fully collected.
        if base == Some(cursor) {
            break;
        }
        let Some(c) = by_id.get(cursor).copied() else {
            // A referenced commit is absent from the fetched history — we can't
            // verify ancestry.
            return AncestryOutcome::FailClosed;
        };
        // A merge (more than one parent) is non-linear — cannot reason safely.
        if c.parent_ids.len() > 1 {
            return AncestryOutcome::FailClosed;
        }
        new_commits.push(c);
        if let Some(parent) = c.parent_ids.first() {
            cursor = parent.as_str();
        } else {
            // Reached a root commit.
            if base.is_none() {
                break; // empty-repo BASE: the root is the valid terminus.
            }
            // We hold a BASE commit, but it is not in the tip's linear history —
            // the histories diverged.
            return AncestryOutcome::Diverged;
        }
        // Cycle / runaway guard: a linear chain can't be longer than the history.
        if new_commits.len() > commits.len() {
            return AncestryOutcome::FailClosed;
        }
    }

    // 4. `new_commits` is the set strictly between BASE (exclusive) and the tip
    //    (inclusive); `base != tip` guarantees it is non-empty.
    if new_commits.is_empty() {
        return AncestryOutcome::FailClosed; // defensive (unreachable for base != tip)
    }
    // Any commit not authored by us means someone else pushed.
    if new_commits.iter().any(|c| c.author_email != my_email) {
        return AncestryOutcome::Diverged;
    }
    // All new commits are ours and linear back to BASE/root → our push landed.
    AncestryOutcome::Landed {
        clear_dirty: edits_captured_by_push(last_edit_at, push_start_at),
    }
}

/// Whether a confirmed-landed push captured all our local edits — i.e. no edit
/// happened after the push began. Biased to **false** (keep the dirty bit) on any
/// uncertainty: a wrongly-kept dirty bit costs only a redundant no-op re-push,
/// whereas a wrongly-cleared one drops un-pushed edits.
fn edits_captured_by_push(last_edit_at: Option<&str>, push_start_at: Option<&str>) -> bool {
    match (last_edit_at, push_start_at) {
        (Some(le), Some(ps)) => match (
            chrono::DateTime::parse_from_rfc3339(le),
            chrono::DateTime::parse_from_rfc3339(ps),
        ) {
            (Ok(edited), Ok(started)) => edited <= started,
            _ => false, // unparseable → conservative
        },
        // Unknown edit/push timing (e.g. a legacy dirty bit) → keep dirty.
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::{classify_ancestry, fence, AncestryOutcome, FenceOutcome, RevisionCommit};

    /// Build a revision-history commit with the given parents and author.
    fn commit(id: &str, parents: &[&str], email: &str) -> RevisionCommit {
        RevisionCommit {
            id: id.to_string(),
            parent_ids: parents.iter().map(|s| (*s).to_string()).collect(),
            author_email: email.to_string(),
        }
    }

    const ME: &str = "me@example.com";
    const OTHER: &str = "other@example.com";
    // T1 < T2 < T3, all RFC-3339 UTC.
    const T1: &str = "2026-06-27T10:00:00+00:00";
    const T2: &str = "2026-06-27T11:00:00+00:00";
    const T3: &str = "2026-06-27T12:00:00+00:00";

    #[test]
    fn up_to_date_when_both_at_empty_base() {
        // None == None: empty repo on both sides.
        assert_eq!(fence(None, None, false), FenceOutcome::UpToDate);
    }

    #[test]
    fn up_to_date_when_base_equals_tip() {
        assert_eq!(
            fence(Some("abc"), Some("abc"), false),
            FenceOutcome::UpToDate
        );
    }

    #[test]
    fn up_to_date_ignores_dirty_when_tip_unmoved() {
        // We hold local edits but no one else pushed (tip == base): still
        // UpToDate — the divergence fence is about REMOTE movement only.
        assert_eq!(
            fence(Some("abc"), Some("abc"), true),
            FenceOutcome::UpToDate
        );
        assert_eq!(fence(None, None, true), FenceOutcome::UpToDate);
    }

    #[test]
    fn fast_forward_when_tip_moved_and_clean() {
        assert_eq!(
            fence(Some("abc"), Some("def"), false),
            FenceOutcome::FastForward
        );
    }

    #[test]
    fn fast_forward_from_empty_base_when_clean() {
        // We pulled the empty BASE (None); the server has since gained a commit.
        assert_eq!(fence(None, Some("def"), false), FenceOutcome::FastForward);
    }

    #[test]
    fn diverged_when_tip_moved_and_dirty() {
        assert_eq!(
            fence(Some("abc"), Some("def"), true),
            FenceOutcome::Diverged
        );
    }

    #[test]
    fn diverged_from_empty_base_when_dirty() {
        assert_eq!(fence(None, Some("def"), true), FenceOutcome::Diverged);
    }

    #[test]
    fn fail_closed_when_base_some_but_tip_none() {
        // Clean or dirty, a vanished/absent server tip is never overwrite-safe.
        assert_eq!(fence(Some("abc"), None, false), FenceOutcome::FailClosed);
        assert_eq!(fence(Some("abc"), None, true), FenceOutcome::FailClosed);
    }

    // --- #193 ancestry recovery ---

    #[test]
    fn ancestry_not_landed_when_tip_unchanged() {
        // Tip still at BASE (and the empty-repo None == None): nothing landed.
        assert_eq!(
            classify_ancestry(Some("b"), Some("b"), &[], ME, Some(T1), Some(T2)),
            AncestryOutcome::NotLanded
        );
        assert_eq!(
            classify_ancestry(None, None, &[], ME, None, None),
            AncestryOutcome::NotLanded
        );
    }

    #[test]
    fn ancestry_landed_when_my_linear_commit_on_top() {
        // c (mine) sits directly on BASE b. Edited before the push began → clear.
        let commits = [commit("c", &["b"], ME)];
        assert_eq!(
            classify_ancestry(Some("b"), Some("c"), &commits, ME, Some(T1), Some(T2)),
            AncestryOutcome::Landed { clear_dirty: true }
        );
    }

    #[test]
    fn ancestry_landed_walks_multi_commit_chain() {
        // c -> b -> a(BASE): both new commits are mine.
        let commits = [commit("c", &["b"], ME), commit("b", &["a"], ME)];
        assert_eq!(
            classify_ancestry(Some("a"), Some("c"), &commits, ME, Some(T1), Some(T1)),
            AncestryOutcome::Landed { clear_dirty: true }
        );
    }

    #[test]
    fn ancestry_landed_from_empty_base_to_root() {
        // Empty-repo BASE (None): the chain ends at the root commit.
        let commits = [commit("c", &[], ME)];
        assert_eq!(
            classify_ancestry(None, Some("c"), &commits, ME, Some(T1), Some(T2)),
            AncestryOutcome::Landed { clear_dirty: true }
        );
    }

    #[test]
    fn ancestry_landed_keeps_dirty_when_edited_after_push_start() {
        // edit -> push starts -> push lands -> confirmation lost -> edit AGAIN.
        // The landed commit predates the second edit, so the dirty bit must stay
        // set (post-push edits survive). last_edit_at (T3) > push_start_at (T2).
        let commits = [commit("c", &["b"], ME)];
        assert_eq!(
            classify_ancestry(Some("b"), Some("c"), &commits, ME, Some(T3), Some(T2)),
            AncestryOutcome::Landed { clear_dirty: false }
        );
    }

    #[test]
    fn ancestry_landed_keeps_dirty_on_unknown_timing() {
        // Legacy dirty bit (no last_edit_at) or missing push_start → conservative.
        let commits = [commit("c", &["b"], ME)];
        assert_eq!(
            classify_ancestry(Some("b"), Some("c"), &commits, ME, None, Some(T2)),
            AncestryOutcome::Landed { clear_dirty: false }
        );
        assert_eq!(
            classify_ancestry(Some("b"), Some("c"), &commits, ME, Some(T1), None),
            AncestryOutcome::Landed { clear_dirty: false }
        );
    }

    #[test]
    fn ancestry_diverged_on_stranger_commit() {
        let commits = [commit("c", &["b"], OTHER)];
        assert_eq!(
            classify_ancestry(Some("b"), Some("c"), &commits, ME, Some(T1), Some(T2)),
            AncestryOutcome::Diverged
        );
    }

    #[test]
    fn ancestry_diverged_when_base_not_an_ancestor() {
        // We hold BASE z, but the tip's full history (c -> root) never contains z.
        let commits = [commit("c", &[], ME)];
        assert_eq!(
            classify_ancestry(Some("z"), Some("c"), &commits, ME, Some(T1), Some(T2)),
            AncestryOutcome::Diverged
        );
    }

    #[test]
    fn ancestry_fail_closed_on_merge() {
        // A commit with two parents is non-linear.
        let commits = [commit("c", &["b", "x"], ME)];
        assert_eq!(
            classify_ancestry(Some("b"), Some("c"), &commits, ME, Some(T1), Some(T2)),
            AncestryOutcome::FailClosed
        );
    }

    #[test]
    fn ancestry_fail_closed_on_missing_parent() {
        // c's parent d is absent from the fetched history (and isn't BASE).
        let commits = [commit("c", &["d"], ME)];
        assert_eq!(
            classify_ancestry(Some("b"), Some("c"), &commits, ME, Some(T1), Some(T2)),
            AncestryOutcome::FailClosed
        );
    }

    #[test]
    fn ancestry_fail_closed_when_tip_absent_from_history() {
        // Tip x isn't in the commit list at all.
        assert_eq!(
            classify_ancestry(Some("b"), Some("x"), &[], ME, Some(T1), Some(T2)),
            AncestryOutcome::FailClosed
        );
    }

    #[test]
    fn ancestry_fail_closed_when_base_some_tip_none() {
        assert_eq!(
            classify_ancestry(Some("b"), None, &[], ME, Some(T1), Some(T2)),
            AncestryOutcome::FailClosed
        );
    }
}
