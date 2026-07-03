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

use std::collections::{HashMap, HashSet};

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
    // We must be able to identify our OWN commits to claim the gap as our landed
    // push. An empty `my_email` (absent session email → unwrap_or_default) matches
    // nothing, and a server-omitted author deserializes to "" (#[serde(default)]):
    // without this guard `"" == ""` would mis-classify a stranger's commit as ours
    // and adopt+overwrite it. Fail closed to the divergence prompt instead.
    if my_email.trim().is_empty() {
        return AncestryOutcome::Diverged;
    }
    // Any commit not authored by us means someone else pushed. Compare case-
    // INSENSITIVELY: the server may normalise email case (mirrors
    // `concurrent_session_notice`; the live revision test asserts the same).
    if new_commits
        .iter()
        .any(|c| !c.author_email.eq_ignore_ascii_case(my_email))
    {
        return AncestryOutcome::Diverged;
    }
    // All new commits are ours and linear back to BASE/root → our push landed.
    AncestryOutcome::Landed {
        clear_dirty: edits_captured_by_push(last_edit_at, push_start_at),
    }
}

/// Resolve the server HEAD as the leaf of a linear commit history: the unique
/// commit that **no other commit lists as a parent**.
///
/// We CANNOT use the server's `latest_commit` field for this. It is computed as
/// `commits.order_by("-authored_date").first()` — the max git *author* timestamp
/// — and project-creation + the first upload land within the same second, so
/// their author timestamps tie and the tie breaks arbitrarily (verified live: it
/// returns the service-account ROOT, not the real HEAD; confirmed in the server
/// source). The parent-id topology is unambiguous, so the fence resolves the tip
/// from it instead.
///
/// Returns `None` for an empty history OR an ambiguous one (zero or multiple
/// leaves — e.g. a fork), so the caller fails closed rather than guessing.
pub(crate) fn tip_of(commits: &[RevisionCommit]) -> Option<&str> {
    let parents: HashSet<&str> = commits
        .iter()
        .flat_map(|c| c.parent_ids.iter().map(String::as_str))
        .collect();
    let mut leaves = commits
        .iter()
        .map(|c| c.id.as_str())
        .filter(|id| !parents.contains(id));
    let head = leaves.next()?;
    if leaves.next().is_some() {
        return None; // more than one head (fork) — ambiguous, fail closed
    }
    Some(head)
}

/// Pure structural check: is `base` reachable by walking the linear parent chain
/// back from `tip`? I.e. is the server `tip` a genuine **descendant** of our
/// `base` (a real fast-forward) rather than an **ancestor** or a fork.
///
/// This guards the clean `FastForward` path against the server's
/// eventually-consistent `latest_commit`: right after a confirmed push, `acquire`
/// / `get_project` were observed live to still report the PRIOR tip (the
/// service-account root) as `latest_commit`. Fast-forwarding to that stale
/// ancestor would re-pull an OLDER tree and reset the project BACKWARD, losing the
/// just-pushed state. Only fast-forward when this returns `true`.
///
/// - `base == None` → we hold no commit yet (fresh open); any tip is adoptable → `true`.
/// - `base == tip` → already there → `true`.
/// - a merge (non-linear) or a commit missing from `commits` → `false` (fail safe:
///   never fast-forward into something we cannot verify).
/// - reaching a root without meeting `base` → `base` is not an ancestor → `false`.
pub(crate) fn base_is_ancestor_of_tip(
    base: Option<&str>,
    tip: &str,
    commits: &[RevisionCommit],
) -> bool {
    let Some(base) = base else {
        return true;
    };
    if base == tip {
        return true;
    }
    let by_id: HashMap<&str, &RevisionCommit> =
        commits.iter().map(|c| (c.id.as_str(), c)).collect();
    let mut cursor: &str = tip;
    let mut steps = 0usize;
    loop {
        if cursor == base {
            return true;
        }
        let Some(c) = by_id.get(cursor).copied() else {
            return false; // tip (or an ancestor) absent from history — can't verify
        };
        if c.parent_ids.len() > 1 {
            return false; // a merge is non-linear — refuse
        }
        let Some(parent) = c.parent_ids.first() else {
            return false; // reached a root without meeting base → not an ancestor
        };
        cursor = parent.as_str();
        steps += 1;
        if steps > commits.len() {
            return false; // cycle / runaway guard
        }
    }
}

/// Whether a confirmed-landed push captured all our local edits — i.e. no edit
/// happened after the push began. Biased to **false** (keep the dirty bit) on any
/// uncertainty: a wrongly-kept dirty bit costs only a redundant no-op re-push,
/// whereas a wrongly-cleared one drops un-pushed edits.
///
/// Used both by `classify_ancestry` (g7) and by the push 200/304 dirty-clear
/// (#197): a confirmed push clears the dirty bit ONLY when this returns true, so a
/// concurrent edit recorded after `push_start_at` (not in the uploaded snapshot)
/// keeps its dirty bit and is re-pushed on the next Done rather than silently lost.
pub(crate) fn edits_captured_by_push(
    last_edit_at: Option<&str>,
    push_start_at: Option<&str>,
) -> bool {
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

/// Verdict for the read-side reconcile paths (Start editing / Update): how our
/// local copy stands against the server tip, collapsing the fence + the
/// fast-forward ancestry guard into the three outcomes those callers act on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReconcileVerdict {
    /// BASE == tip: nothing remote to reconcile.
    UpToDate,
    /// Tip moved forward of a clean BASE AND BASE is a genuine ancestor of it —
    /// safe to pull + re-stamp.
    FastForward,
    /// Anything we must NOT auto-resolve: a real fork, a fast-forward target BASE
    /// is not an ancestor of (the eventually-consistent `latest_commit`), OR a
    /// server inconsistency (non-linear / multi-root / a recorded BASE with no
    /// tip). All route to the divergence PROMPT — never a hard error, never an
    /// overwrite (#193 b2: "fail closed to the divergence prompt").
    Diverged,
}

/// Read-side reconcile decision for Start editing / Update (#192, #193 b2). Pure
/// over the already-fetched tip + history so every branch is unit-tested offline.
/// FailClosed folds into `Diverged` here precisely so non-linear / multi-root /
/// empty-with-base histories surface the divergence prompt instead of erroring.
#[must_use]
pub(crate) fn reconcile_verdict(
    base: Option<&str>,
    tip: Option<&str>,
    dirty: bool,
    commits: &[RevisionCommit],
) -> ReconcileVerdict {
    match fence(base, tip, dirty) {
        FenceOutcome::UpToDate => ReconcileVerdict::UpToDate,
        FenceOutcome::FastForward
            if base_is_ancestor_of_tip(base, tip.unwrap_or_default(), commits) =>
        {
            ReconcileVerdict::FastForward
        }
        // FastForward-but-not-ancestor, Diverged, and FailClosed all fail closed to
        // the divergence prompt rather than overwriting or surfacing a hard error.
        FenceOutcome::FastForward | FenceOutcome::Diverged | FenceOutcome::FailClosed => {
            ReconcileVerdict::Diverged
        }
    }
}

/// What a Done push should do, after fencing BASE against the server tip and (on a
/// moved tip we hold the lock over) classifying the BASE..tip gap by authorship.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PushPlan {
    /// BASE == tip: upload our edits directly.
    Upload,
    /// Our prior (ambiguous) push landed but an edit followed it: adopt the landed
    /// tip as BASE, then re-push the current state on top (a no-op 304 if nothing
    /// changed since the landed commit).
    AdoptThenUpload,
    /// Our prior push landed and nothing was edited after it: adopt the tip as BASE
    /// and clear the dirty bit WITHOUT a redundant re-push (the push is confirmed).
    AdoptConfirmed,
    /// A stranger's commit, OR a server inconsistency (non-linear / multi-root /
    /// recorded BASE with no tip): route to the divergence prompt. Never overwrite,
    /// never guess (#193 b2 + b5).
    Diverged,
}

/// Pure Done-push decision (#192/#193): fence BASE against the tip, and on a moved
/// tip (we hold the lock, so it is almost always our own ambiguous push) classify
/// the gap by authorship. Every fail-closed branch routes to the divergence prompt
/// rather than a hard error or a blind re-push.
#[must_use]
pub(crate) fn plan_push(
    base: Option<&str>,
    tip: Option<&str>,
    commits: &[RevisionCommit],
    my_email: &str,
    last_edit_at: Option<&str>,
    push_start_at: Option<&str>,
) -> PushPlan {
    match fence(base, tip, true) {
        FenceOutcome::UpToDate => PushPlan::Upload,
        FenceOutcome::Diverged => {
            match classify_ancestry(base, tip, commits, my_email, last_edit_at, push_start_at) {
                AncestryOutcome::Landed { clear_dirty: true } => PushPlan::AdoptConfirmed,
                AncestryOutcome::Landed { clear_dirty: false } => PushPlan::AdoptThenUpload,
                // Stranger commit, a non-linear/multi-root inconsistency, or (not
                // reachable on a moved tip) a not-landed push — never overwrite or
                // guess, route to the divergence prompt.
                AncestryOutcome::Diverged
                | AncestryOutcome::NotLanded
                | AncestryOutcome::FailClosed => PushPlan::Diverged,
            }
        }
        // A dirty copy never fast-forwards (the fence returns Diverged for a dirty
        // moved tip); a recorded BASE with no tip is a server inconsistency. Both
        // fail closed to the divergence prompt.
        FenceOutcome::FastForward | FenceOutcome::FailClosed => PushPlan::Diverged,
    }
}

/// Whether opening a remote project should warn about a concurrent SAME-ACCOUNT
/// session (#193 b8). [`classify_ancestry`] treats `author_email == my_email` as
/// "this session's push"; a second session under the same account editing the same
/// project breaks that proxy (its commit reads as "mine" and could wrongly clear
/// the dirty bit). The single-writer lock makes this rare, but if the server
/// already reports a lock held by our OWN account when we open, a second session is
/// live — surface a notice. Case-insensitive (the server may normalise email case);
/// a lock held by a DIFFERENT account is an ordinary contended-lock case, not this.
#[must_use]
pub(crate) fn concurrent_session_notice(active_mutex_user: Option<&str>, my_email: &str) -> bool {
    active_mutex_user.is_some_and(|holder| holder.eq_ignore_ascii_case(my_email))
}

#[cfg(test)]
mod tests {
    use super::{
        base_is_ancestor_of_tip, classify_ancestry, concurrent_session_notice,
        edits_captured_by_push, fence, plan_push, reconcile_verdict, tip_of, AncestryOutcome,
        FenceOutcome, PushPlan, ReconcileVerdict, RevisionCommit,
    };

    /// Build a revision-history commit with the given parents and author.
    fn commit(id: &str, parents: &[&str], email: &str) -> RevisionCommit {
        RevisionCommit {
            id: id.to_string(),
            parent_ids: parents.iter().map(|s| (*s).to_string()).collect(),
            author_email: email.to_string(),
            authored_date: None,
            message: None,
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

    // --- tip_of (topological HEAD resolution) ---

    #[test]
    fn tip_of_finds_the_leaf_regardless_of_order() {
        // root <- a <- b. b is the leaf (HEAD). Order in the slice is irrelevant
        // (the server returns commits newest-first by authored_date, which ties).
        let commits = [
            commit("root", &[], OTHER),
            commit("b", &["a"], ME),
            commit("a", &["root"], ME),
        ];
        assert_eq!(tip_of(&commits), Some("b"));
    }

    #[test]
    fn tip_of_single_commit_is_the_root() {
        let commits = [commit("root", &[], OTHER)];
        assert_eq!(tip_of(&commits), Some("root"));
    }

    #[test]
    fn tip_of_none_for_empty_or_forked() {
        assert_eq!(tip_of(&[]), None);
        // Two leaves (b and c both children of a) → ambiguous fork → None.
        let forked = [
            commit("a", &[], ME),
            commit("b", &["a"], ME),
            commit("c", &["a"], ME),
        ];
        assert_eq!(tip_of(&forked), None);
    }

    // --- base_is_ancestor_of_tip (clean fast-forward guard) ---

    #[test]
    fn ancestor_guard_true_for_genuine_fast_forward() {
        // root <- a(base) <- b(tip): base IS an ancestor of tip → real FF.
        let commits = [
            commit("b", &["a"], OTHER),
            commit("a", &["root"], ME),
            commit("root", &[], OTHER),
        ];
        assert!(base_is_ancestor_of_tip(Some("a"), "b", &commits));
    }

    #[test]
    fn ancestor_guard_false_for_stale_ancestor_tip() {
        // The server reports a STALE tip "a" that is an ANCESTOR of our base "b"
        // (the eventual-consistency lag after our own push). Must NOT fast-forward
        // backward.
        let commits = [
            commit("b", &["a"], ME),
            commit("a", &["root"], OTHER),
            commit("root", &[], OTHER),
        ];
        assert!(!base_is_ancestor_of_tip(Some("b"), "a", &commits));
    }

    #[test]
    fn ancestor_guard_true_for_none_base_and_equal() {
        // No base yet → adopt any tip; and base == tip is trivially an ancestor.
        let commits = [commit("root", &[], OTHER)];
        assert!(base_is_ancestor_of_tip(None, "root", &commits));
        assert!(base_is_ancestor_of_tip(Some("root"), "root", &commits));
    }

    #[test]
    fn ancestor_guard_false_for_missing_or_merge() {
        // Tip absent from history → can't verify → false.
        assert!(!base_is_ancestor_of_tip(Some("a"), "ghost", &[]));
        // A merge commit on the path is non-linear → false.
        let merged = [commit("m", &["a", "x"], ME), commit("a", &[], ME)];
        assert!(!base_is_ancestor_of_tip(Some("a"), "m", &merged));
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
    fn ancestry_diverged_on_empty_my_email() {
        // #197 review: an absent session email (unwrap_or_default → "") must NOT let
        // a server-omitted author (serde default → "") match as "ours" and get
        // adopted+overwritten. With my_email empty we cannot identify our own commit,
        // so the gap is foreign → divergence prompt, never a silent adopt.
        let commits = [commit("c", &["b"], "")];
        assert_eq!(
            classify_ancestry(Some("b"), Some("c"), &commits, "", Some(T1), Some(T2)),
            AncestryOutcome::Diverged,
            "empty my_email must fail closed, not classify a stranger's commit as ours"
        );
        // Even when our email IS known, a "" author is still a stranger.
        let anon = [commit("c", &["b"], "")];
        assert_eq!(
            classify_ancestry(Some("b"), Some("c"), &anon, ME, Some(T1), Some(T2)),
            AncestryOutcome::Diverged
        );
    }

    #[test]
    fn ancestry_landed_matches_author_case_insensitively() {
        // #197 review: the server may normalise email case. Our own landed commit
        // authored as "Me@Example.COM" must still classify as ours (Landed), not a
        // stranger, mirroring concurrent_session_notice's case-insensitive match.
        let commits = [commit("c", &["b"], "Me@Example.COM")];
        assert_eq!(
            classify_ancestry(Some("b"), Some("c"), &commits, ME, Some(T1), Some(T2)),
            AncestryOutcome::Landed { clear_dirty: true },
            "a case-variant of our own email must not read as a stranger"
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

    // ---- reconcile_verdict (Start editing / Update routing, #193 b2) ----
    // A linear chain root -> a -> b authored by ME, used by the routing tests.
    fn linear_history() -> Vec<RevisionCommit> {
        vec![
            commit("root", &[], ME),
            commit("a", &["root"], ME),
            commit("b", &["a"], ME),
        ]
    }

    #[test]
    fn reconcile_up_to_date_when_base_equals_tip() {
        assert_eq!(
            reconcile_verdict(Some("b"), Some("b"), false, &linear_history()),
            ReconcileVerdict::UpToDate
        );
        // None == None (empty repo) is up to date too.
        assert_eq!(
            reconcile_verdict(None, None, false, &[]),
            ReconcileVerdict::UpToDate
        );
    }

    #[test]
    fn reconcile_fast_forward_only_for_clean_genuine_descendant() {
        // Clean, tip is a real descendant of BASE -> fast-forward.
        assert_eq!(
            reconcile_verdict(Some("a"), Some("b"), false, &linear_history()),
            ReconcileVerdict::FastForward
        );
        // Dirty over a moved tip is a divergence, never a fast-forward.
        assert_eq!(
            reconcile_verdict(Some("a"), Some("b"), true, &linear_history()),
            ReconcileVerdict::Diverged
        );
    }

    #[test]
    fn reconcile_diverges_when_tip_not_a_descendant_of_base() {
        // Tip moved but BASE is NOT an ancestor (stale latest_commit / fork): the
        // ancestor guard refuses the fast-forward and we route to the prompt.
        assert_eq!(
            reconcile_verdict(Some("b"), Some("a"), false, &linear_history()),
            ReconcileVerdict::Diverged
        );
    }

    #[test]
    fn reconcile_non_linear_history_routes_to_divergence_not_error() {
        // A merge commit (two parents) is non-linear -> the ancestor guard fails
        // -> divergence prompt (#193 b2), NOT a hard error.
        let merge = vec![
            commit("root", &[], ME),
            commit("a", &["root"], ME),
            commit("m", &["a", "root"], ME), // merge: two parents
        ];
        assert_eq!(
            reconcile_verdict(Some("a"), Some("m"), false, &merge),
            ReconcileVerdict::Diverged
        );
    }

    #[test]
    fn reconcile_empty_tip_with_recorded_base_routes_to_divergence() {
        // FailClosed (recorded BASE, server reports no tip — incl. the multi-root
        // case where tip_of() yields None) folds into the divergence prompt.
        assert_eq!(
            reconcile_verdict(Some("b"), None, false, &[]),
            ReconcileVerdict::Diverged
        );
    }

    // ---- plan_push (Done push routing, #193 b2 + b5) ----

    #[test]
    fn plan_push_uploads_directly_when_up_to_date() {
        assert_eq!(
            plan_push(
                Some("b"),
                Some("b"),
                &linear_history(),
                ME,
                Some(T1),
                Some(T2)
            ),
            PushPlan::Upload
        );
    }

    #[test]
    fn plan_push_adopts_and_confirms_when_my_push_landed_clean() {
        // My commit b landed on top of BASE a, no edit after push-start -> adopt +
        // confirm without a redundant re-push.
        assert_eq!(
            plan_push(
                Some("a"),
                Some("b"),
                &linear_history(),
                ME,
                Some(T1),
                Some(T2)
            ),
            PushPlan::AdoptConfirmed
        );
    }

    #[test]
    fn plan_push_adopts_then_reuploads_when_edited_after_push_start() {
        // My push landed (b) but I edited again after push-start (T3 > T2) -> adopt
        // the landed tip, then re-push the later edit on top.
        assert_eq!(
            plan_push(
                Some("a"),
                Some("b"),
                &linear_history(),
                ME,
                Some(T3),
                Some(T2)
            ),
            PushPlan::AdoptThenUpload
        );
    }

    #[test]
    fn plan_push_diverges_on_a_strangers_commit() {
        let stolen = vec![
            commit("root", &[], ME),
            commit("a", &["root"], ME),
            commit("b", &["a"], OTHER), // a stranger pushed into the gap (lock theft)
        ];
        assert_eq!(
            plan_push(Some("a"), Some("b"), &stolen, ME, Some(T1), Some(T2)),
            PushPlan::Diverged
        );
    }

    #[test]
    fn plan_push_diverges_on_non_linear_gap_instead_of_error() {
        // A merge in the BASE..tip gap is an inconsistency -> divergence prompt
        // (#193 b2), not a hard error and not a blind re-push.
        let merge = vec![
            commit("root", &[], ME),
            commit("a", &["root"], ME),
            commit("m", &["a", "root"], ME),
        ];
        assert_eq!(
            plan_push(Some("a"), Some("m"), &merge, ME, Some(T1), Some(T2)),
            PushPlan::Diverged
        );
    }

    #[test]
    fn plan_push_diverges_when_base_some_but_tip_none() {
        assert_eq!(
            plan_push(Some("a"), None, &[], ME, Some(T1), Some(T2)),
            PushPlan::Diverged
        );
    }

    // ---- concurrent_session_notice (#193 b8) ----

    #[test]
    fn concurrent_session_flagged_only_for_a_same_account_lock_hold() {
        // Our own account already holds the lock -> a second session is live.
        assert!(concurrent_session_notice(Some(ME), ME));
        // Case-insensitive (the server may normalise email case).
        assert!(concurrent_session_notice(
            Some("ME@Example.com"),
            "me@example.com"
        ));
        // A different account's lock is an ordinary contended lock, not this notice.
        assert!(!concurrent_session_notice(Some(OTHER), ME));
        // No lock held -> nothing to warn about.
        assert!(!concurrent_session_notice(None, ME));
    }

    // ---- edits_captured_by_push (direct, #197 dirty-clear timing) ----

    #[test]
    fn edits_captured_only_when_last_edit_predates_push_start() {
        assert!(
            edits_captured_by_push(Some(T1), Some(T2)),
            "edited before push"
        );
        assert!(
            edits_captured_by_push(Some(T2), Some(T2)),
            "edited at push start"
        );
        assert!(
            !edits_captured_by_push(Some(T3), Some(T2)),
            "edited after push -> keep dirty"
        );
        assert!(
            !edits_captured_by_push(None, Some(T2)),
            "unknown edit time -> keep dirty"
        );
        assert!(
            !edits_captured_by_push(Some("not-a-date"), Some(T2)),
            "unparseable -> keep dirty"
        );
    }
}
