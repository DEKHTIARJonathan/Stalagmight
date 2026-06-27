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
//! - ancestry recovery (#193) — added in a later unit, same module.

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
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "fence consumer is #194 start_editing (Unit 4)")
)]
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

#[cfg(test)]
mod tests {
    use super::{fence, FenceOutcome};

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
}
