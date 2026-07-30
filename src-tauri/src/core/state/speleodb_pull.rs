//! Everything that brings server bytes down into the cache `.stalx`: listing
//! projects, opening / re-opening one, the one-shot Ariane adoption, and the
//! fast-forward re-pull behind Start editing / Update / Take remote.
//!
//! Split out of `core/state/speleodb.rs` (which is frozen at the file-size ratchet
//! warn line) into a sibling `impl AppState` block.
//!
//! The fast-forward lives HERE rather than with the push because it is a pull: it
//! runs the same download -> classify -> replace pipeline as
//! [`AppState::speleodb_pull_project`] and differs only in the BASE stamp. Keeping
//! the two together is what lets one helper answer "which entry of this dump" for
//! every path that asks.
//!
//! The replace chokepoint itself is `speleodb_cache`, which owns the un-pushed-edits
//! guard. Note that the guard runs BEFORE the download on the pull path, so a
//! refusal costs no bytes - a source-order test pins that.

use std::path::Path;

use super::speleodb::{local_dto, validate_project_id, DumpAt};
use super::speleodb_cache::{restore_display_settings, LocalEditsPolicy};
use super::speleodb_revisions::validate_hexsha;
use super::{AppState, VirtualShotMode};
use crate::speleodb::contract::{dto_for_error, Endpoint};
use crate::speleodb::dump::{self, DumpClassification};
use crate::speleodb::models::{SpeleoDumpCandidate, SpeleoProjectSummary};
use crate::speleodb::{client, sync};
use crate::speleodb::{SpeleoAdoptResult, SpeleoDbError, SpeleoErrorDto, SpeleoOpenResult};

/// Why a dump could not be opened without asking the user first. [#258]
///
/// Distinct from [`SpeleoDbError`] so the name-only classification stays a pure,
/// archive-free function: turning an ambiguity into the IPC error needs each
/// candidate's size and timestamp, which live in the archive the classifier
/// deliberately does not hold.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum UnopenableDump {
    /// `.tml`-only - route to the one-time adoption flow (#214).
    Adopt,
    /// Nothing openable at all.
    Empty,
    /// More than one `.stalx`.
    AmbiguousStalx(Vec<String>),
    /// No `.stalx` and more than one `ariane.tml`.
    AmbiguousAriane(Vec<String>),
}

/// [#258] What a caller is able to do with a dump that holds only Ariane data.
///
/// Adoption is a TIP-only operation: it imports a `.tml` by downloading the project's
/// current contents, with no import-at-hash counterpart. So the answer differs by
/// caller rather than by dump, and the caller has to say which it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ArianeRoute {
    /// Route to the one-shot adoption flow, which imports the `.tml`.
    Adopt,
    /// Refuse. For a caller with no import path, advertising an Ariane choice would
    /// offer a question whose every answer is an error.
    Refuse,
}

/// Refusal for [`ArianeRoute::Refuse`]. Says what is missing and where adoption does
/// work, so the user is not left to infer that a revision swap and adoption are
/// different operations.
const ARIANE_NOT_RESTORABLE: &str =
    "this revision holds only Ariane data and no Stalagmight file, so there is \
     nothing to view or restore; Ariane data can only be adopted from the project's \
     current revision";

/// [#258] Whether a caller can put a `.stalx` ambiguity to the user.
///
/// The same question as [`ArianeRoute`], asked about the other ambiguity, and for
/// the same reason: what to do with a dump the app cannot classify depends on the
/// CALLER's surface, not on the dump. Every frontend host that raises the picker is
/// bound to a specific verb (`dumpCandidates` is checked at each one), so the verbs
/// with no host must not answer with a candidate list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum StalxAmbiguity {
    /// Report the candidates; this caller's frontend raises the picker and replays
    /// the verb with the answer. Open, open-discarding, adopt, restore and the
    /// lock-free probe behind the revert.
    Ask,
    /// Refuse with directions. The verbs behind [`AppState::speleodb_fast_forward`] -
    /// Start editing, Update, Take remote - accept no `entryPath` and have no picker
    /// bound to them, so a candidate list reaches a frontend that cannot use it.
    Refuse,
}

/// Refusal for [`StalxAmbiguity::Refuse`]. Names the flow that CAN ask, because
/// otherwise this is indistinguishable from the dead end it replaces: the verbs it
/// covers already surfaced the raw ambiguity as a bare error whenever the session had
/// no usable answer, which - before choices were dated - is exactly what our own push
/// left behind.
const AMBIGUOUS_NEEDS_REOPEN: &str =
    "this project holds more than one Stalagmight file on the server, and the file \
     you chose is not the one this revision was built from; re-open the project to \
     choose which file to use";

/// Refusal for an Ariane ambiguity that reaches a caller with no picker. Separate from
/// [`AMBIGUOUS_NEEDS_REOPEN`] only in what it names the tree as holding - the remedy is
/// the same, because re-opening is the flow that can ask either question.
const AMBIGUOUS_ARIANE_NEEDS_REOPEN: &str =
    "this project holds more than one Ariane file on the server and no Stalagmight \
     file, so there is nothing here to update; re-open the project to choose which \
     file to adopt";

/// The two shas a pull derives from one head resolution. [#258]
///
/// Deliberately not the same value, which is the whole reason this is a type and not
/// a `let`. A wrong BASE costs at most a redundant fast-forward on the next Start
/// editing, so it is allowed to fall back to the caller's advisory sha. A wrong DATE
/// costs the entire staleness guarantee, and the advisory sha is the worst imaginable
/// source for one: `latest_commit_sha` is `max(authored_date)`, so it can name the
/// root creation commit and STAY there across any number of real revisions. A choice
/// recorded under it would go on matching while the tree moved underneath - the exact
/// rollback the dating exists to prevent, wearing the mark of a guard.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct PullDating {
    /// May date a remembered choice. An authoritative topology tip, or nothing.
    pub(super) datable: Option<String>,
    /// Stamps BASE. Falls back to the caller's advisory sha.
    pub(super) base: Option<String>,
}

/// Split a resolved tip and the caller's advisory sha into [`PullDating`].
pub(super) fn pull_dating(tip: Option<String>, advisory: Option<String>) -> PullDating {
    PullDating {
        base: tip.clone().or(advisory),
        datable: tip,
    }
}

/// A server-reported topology tip, accepted only if it can safely be interpolated
/// into a by-hash download URL. [#258]
///
/// The tip arrives over the wire and `download_dump_at_hash` puts it straight into an
/// authenticated request path - the same boundary `speleodb_restore_revision` and the
/// lock-free probe both cross `validate_hexsha` before building that URL. Being
/// server-derived is no licence to skip it: the value is exactly as trustworthy as the
/// box we happen to be pointed at, and a malformed one reshapes the request rather
/// than failing it. Pinning the download to a sha is what made this a live path, so
/// the check has to come with it.
///
/// A rejected tip answers `None`, which every caller already handles: the dump is
/// fetched at plain HEAD, and `None` is also what says it is undatable - so nothing is
/// recalled against it and nothing is recorded. Fail closed, and never issue the
/// by-hash request at all.
///
/// The sha is deliberately kept out of the log line. It is the untrusted value, and a
/// warning is not worth handing it a way into whatever reads the logs.
pub(super) fn usable_tip(tip: Option<String>, project_id: &str) -> Option<String> {
    let sha = tip?;
    if validate_hexsha(&sha).is_ok() {
        return Some(sha);
    }
    tracing::warn!(
        project_id = %project_id,
        len = sha.len(),
        "server history reported a tip that is not a usable revision id; falling back \
         to an undated HEAD download"
    );
    None
}

/// Trust-boundary check on the lock-free probe's inputs. [#258]
///
/// Both ids reach an authenticated request path, so both are validated exactly as
/// the flows the probe predicts validate them - `speleodb_restore_revision` checks
/// the same pair before it builds its download-at-hash URL. Pure and separate from
/// the command so the check is unit-testable: inside the command every rejection
/// looks like the advisory `None` it shares with "not logged in", which would make a
/// missing guard invisible to a test.
pub(super) fn probe_inputs_valid(project_id: &str, hexsha: Option<&str>) -> bool {
    validate_project_id(project_id).is_ok() && hexsha.is_none_or(|sha| validate_hexsha(sha).is_ok())
}

/// Map a downloaded dump's entry list to the single openable `.stalx` path, or the
/// reason a human has to decide. Pure, so it is unit-testable without an archive.
pub(super) fn classify_dump_entry(names: &[String]) -> Result<String, UnopenableDump> {
    match dump::classify(names) {
        DumpClassification::Stalx(path) => Ok(path),
        DumpClassification::AdoptAriane(_) => Err(UnopenableDump::Adopt),
        DumpClassification::NothingToOpen => Err(UnopenableDump::Empty),
        DumpClassification::AmbiguousStalx(paths) => Err(UnopenableDump::AmbiguousStalx(paths)),
        DumpClassification::AmbiguousAriane(paths) => Err(UnopenableDump::AmbiguousAriane(paths)),
    }
}

/// Turn an [`UnopenableDump`] into the IPC error, reading each ambiguous
/// candidate's metadata out of the archive it came from.
pub(super) fn unopenable_to_error(
    reason: UnopenableDump,
    dump: &mut dump::Dump<'_>,
) -> SpeleoDbError {
    match reason {
        UnopenableDump::Adopt => SpeleoDbError::AdoptAriane,
        UnopenableDump::Empty => SpeleoDbError::EmptyDump,
        UnopenableDump::AmbiguousStalx(paths) => match dump.entry_details(&paths) {
            Ok(candidates) => SpeleoDbError::AmbiguousDump(candidates),
            Err(e) => e,
        },
        UnopenableDump::AmbiguousAriane(paths) => match dump.entry_details(&paths) {
            Ok(candidates) => SpeleoDbError::AmbiguousAriane(candidates),
            Err(e) => e,
        },
    }
}

/// Which entry of this dump to open, honouring an explicit [#258] choice.
///
/// `chosen` is the `entryPath` the picker sent back. It crosses IPC, so it is
/// accepted ONLY when the classifier itself offered it for THIS archive - which
/// refuses a non-openable entry and a stale pick (the dump moved on while the
/// picker was open) alike. A refused choice falls through to a fresh
/// classification, so the user is re-offered what the dump holds NOW rather than
/// told their pick was invalid.
pub(super) fn resolve_dump_entry(
    dump: &mut dump::Dump<'_>,
    chosen: Option<&str>,
) -> Result<String, SpeleoDbError> {
    let names = dump.entry_paths()?;
    if let Some(chosen) = chosen {
        match dump::chosen_candidate(&names, chosen) {
            Some(dump::ChosenKind::Stalx) => return Ok(chosen.to_owned()),
            // An `ariane.tml` is openable, but NOT by this path: every caller hands
            // the result to `replace_cache_stalx_with`, which would write TML bytes
            // into the cache `.stalx` - unopenable, and over whatever clean copy was
            // there. It routes to adoption instead, the one flow that imports rather
            // than extracts, and which carries the chosen entry so the pick is kept.
            Some(dump::ChosenKind::Ariane) => return Err(SpeleoDbError::AdoptAriane),
            None => {}
        }
    }
    classify_dump_entry(&names).map_err(|reason| unopenable_to_error(reason, dump))
}

impl AppState {
    /// [#258] Which entry of this dump to use, consulting - and then updating - the
    /// choice this session has already made for `project_id`.
    ///
    /// Every path that classifies a dump goes through here, so that recalling and
    /// remembering cannot drift apart. They did once: restore recorded the user's
    /// answer but never consulted it, so someone who had already answered at open
    /// time - before any lock existed - was asked again by the revert, which by then
    /// had taken the write lock and had to hand it back to ask.
    ///
    /// An explicit `chosen` wins over the remembered entry, but only while it is an
    /// answer to the question we asked - see `speleodb_dump_offer_answers`. A pick and
    /// a recall are now dated the same way, which they were not: dating the REMEMBERED
    /// answer while letting a fresh `entryPath` through on membership alone left the
    /// hole open at the point the user is actually deciding. The picker lists a size
    /// and a timestamp per candidate so the choice can be informed; it is a question
    /// about one tree, and confirming it replays the verb, which resolves the tip
    /// again. So an answer about A was being applied to B - and membership is exactly
    /// what a surviving backup copy passes.
    ///
    /// Neither is trusted: both are then checked for membership against the archive
    /// being extracted, so a name that made sense for the tip's tree simply falls
    /// through to the ambiguity when a revision's tree does not contain it.
    ///
    /// Membership used to be the only guard on a recall and it is nowhere near enough
    /// on its own, because the stale case USUALLY still passes it: a push writes the
    /// canonical entry and leaves the others where they are, so a choice that named a
    /// backup is still a member of every later tree while pointing at bytes from
    /// before the push. `at` is what catches that, and it catches a collaborator's
    /// push as well as our own - which membership never could.
    ///
    /// `stalx` says whether this caller's frontend can put an ambiguity to the user.
    /// The verbs behind `speleodb_fast_forward` cannot: they carry no `entryPath` and
    /// have no picker host, so handing them a candidate list is handing them a
    /// question nobody will ever be asked. They get a refusal that names the way out
    /// instead - the same shape as `ARIANE_NOT_RESTORABLE`.
    ///
    /// Only an answer the USER gave is recorded. An unambiguous dump asks nothing, so
    /// there is nothing to remember, and recording its sole `.stalx` anyway would
    /// promote an automatic classification into a standing choice: once a second
    /// `.stalx` appears the recalled name still passes membership (the old file is
    /// still in the tree), so the picker never opens, and every later pull - plus the
    /// push that follows - silently keeps using the file nobody picked.
    pub(super) fn speleodb_resolve_entry_remembering(
        &self,
        project_id: &str,
        dump: &mut dump::Dump<'_>,
        chosen: Option<&str>,
        ariane: ArianeRoute,
        at: DumpAt<'_>,
        stalx: StalxAmbiguity,
    ) -> Result<String, SpeleoDbError> {
        // A pick that answers a DIFFERENT revision is discarded here rather than
        // membership-checked, because membership is what it would pass: a push writes
        // the canonical entry and leaves every other `.stalx` where it was, so the
        // backup the user chose at A is still in B's tree. Dropping it falls through to
        // a fresh classification, which re-offers what the dump holds now - and records
        // the new revision, so the next reply matches and this cannot loop.
        let answered_here = chosen.filter(|_| self.speleodb_dump_offer_answers(project_id, at));
        let recalled = self.speleodb_recalled_dump_entry(project_id, at);
        let candidate = answered_here.or(recalled.as_deref());
        match resolve_dump_entry(dump, candidate) {
            Ok(entry) => {
                // Honoured explicit pick only: `resolve_dump_entry` returns the
                // candidate verbatim when it accepts it, and a refused pick falls
                // through to a classification that cannot equal it (a refused name is
                // not an openable entry of this archive, a classified one always is). A
                // hit recalled from the session is already recorded, so re-recording it
                // would be a no-op.
                //
                // `answered_here`, NOT `chosen`: a pick discarded for answering another
                // revision must not be recorded on its way past. An unambiguous dump
                // classifies to its sole entry, which can equal the discarded name - so
                // testing `chosen` would promote a pick we just refused into a standing
                // session answer, over a question that was never asked.
                if answered_here.is_some_and(|c| c == entry.as_str()) {
                    self.speleodb_remember_dump_entry(project_id, &entry, at);
                }
                Ok(entry)
            }
            // [#258] An ambiguity this caller has no way to ask about. Every verb
            // behind the fast-forward lands here once the tree has moved under a
            // remembered choice - which is now the ordinary outcome of a collaborator
            // pushing, not a rare one - and a candidate list would reach a frontend
            // with no picker bound to it and surface as a bare "more than one
            // Stalagmight file". Name the way out instead: re-opening the project is
            // the flow that DOES host the picker, and answering it there re-arms this
            // one for the revision the answer was actually about.
            Err(SpeleoDbError::AmbiguousDump(_)) if stalx == StalxAmbiguity::Refuse => {
                Err(SpeleoDbError::Parse(AMBIGUOUS_NEEDS_REOPEN.to_owned()))
            }
            // [#258 review] The same refusal for the OTHER ambiguity, which slipped
            // between the two flags. `ArianeRoute` answers "can you import a `.tml`?"
            // and `StalxAmbiguity` answers "can you ASK the user?" - the fast-forward
            // says yes to the first and no to the second, so an ambiguous Ariane set
            // matched neither refusing arm and shipped a candidate list to Start
            // editing / Update / Take remote, none of which has a picker bound to it.
            // Deliberately narrower than the arm above it: a LONE `ariane.tml` is a
            // routing signal the frontend does act on, so only the ambiguous set is
            // refused here.
            Err(SpeleoDbError::AmbiguousAriane(_)) if stalx == StalxAmbiguity::Refuse => Err(
                SpeleoDbError::Parse(AMBIGUOUS_ARIANE_NEEDS_REOPEN.to_owned()),
            ),
            // [#258] Ariane data, and this caller cannot import it. Refuse with a
            // reason instead of handing back an adoption signal it has no way to act
            // on: a revision swap that routed here downloaded the TIP, answering a
            // question about an old revision with today's contents. Covers the lone
            // `.tml` and the ambiguous set alike - neither is restorable, so offering
            // a picker for the second would only move the dead end one click later.
            // Nothing is remembered: a pick this flow refuses is not an answer.
            Err(SpeleoDbError::AdoptAriane | SpeleoDbError::AmbiguousAriane(_))
                if ariane == ArianeRoute::Refuse =>
            {
                Err(SpeleoDbError::Parse(ARIANE_NOT_RESTORABLE.to_owned()))
            }
            // [#258] The pick was an `ariane.tml`, so this path refuses it and the
            // flow routes to adoption. Record it anyway: adoption is a SEPARATE
            // command reached through a confirm dialog, so without this the answer
            // would be lost between the two and the picker would re-ask forever.
            // Only when it really is this archive's Ariane pick - the same refusal
            // arises for an ordinary `.tml`-only dump, where there was no choice.
            Err(SpeleoDbError::AdoptAriane) => {
                if let Some(chosen) = candidate {
                    let names = dump.entry_paths()?;
                    if dump::chosen_candidate(&names, chosen) == Some(dump::ChosenKind::Ariane) {
                        self.speleodb_remember_dump_entry(project_id, chosen, at);
                    }
                }
                Err(SpeleoDbError::AdoptAriane)
            }
            // [#258] An ambiguity that is about to be REPORTED - the refusing arms are
            // above, so reaching here means this caller does host a picker and these
            // candidates are going to the user. Record which revision they describe,
            // because the reply arrives through a SEPARATE call that resolves the tip
            // again, and that is the only way to tell an answer to this question from
            // an answer to a different one.
            Err(e @ (SpeleoDbError::AmbiguousDump(_) | SpeleoDbError::AmbiguousAriane(_))) => {
                self.speleodb_note_dump_offer(project_id, at);
                Err(e)
            }
            Err(e) => Err(e),
        }
    }

    /// [#258] Ask what a dump holds WITHOUT taking a lock or touching the cache.
    ///
    /// Exists so the revert composite can put its question before the write lock
    /// rather than after it. Restoring a revision needs the lock, so discovering the
    /// ambiguity inside that call meant taking the lock, failing, handing it back to
    /// ask, and re-taking it - a visible round trip for a question that needed no
    /// lock at all.
    ///
    /// Advisory, and deliberately never fails the caller's flow: anything that is not
    /// a clear ambiguity answers `None`, leaving the real call to produce the
    /// authoritative error. A probe that could report its own failures would just be a
    /// second place the same problem is surfaced, out of order with the flow.
    ///
    /// It used to short-circuit on ANY remembered answer, which cost no network at
    /// all and answered the wrong question. The probe is asked about a specific
    /// `hexsha`, and a session's answer is about the tree it was given - normally the
    /// tip, since opening the project is what settles this. Those are different trees
    /// whenever the revert is doing its job, so the short-circuit was skipping the
    /// requested revision on the strength of an answer that never described it. It is
    /// gone; the recall is consulted where every other path consults it, inside the
    /// resolver, which will only honour it for the revision it belongs to. The cost is
    /// the download this used to skip - which the probe was already prepared to make
    /// on every miss, and still no lock.
    pub(crate) fn speleodb_dump_candidates(
        &self,
        project_id: String,
        hexsha: Option<String>,
    ) -> Result<Option<Vec<SpeleoDumpCandidate>>, SpeleoErrorDto> {
        // Trust boundary first, before any network or session work: both ids are
        // interpolated into an authenticated URL path.
        if !probe_inputs_valid(&project_id, hexsha.as_deref()) {
            return Ok(None);
        }
        let Ok((endpoint, token)) = self.speleodb_active_token() else {
            return Ok(None);
        };
        let insecure_http = self.speleodb_insecure_http();
        let downloaded = match &hexsha {
            // Validated at the entry by `probe_inputs_valid`, exactly like the restore
            // path validates before building its own download-at-hash URL.
            Some(sha) => self.speleodb_handle_auth(
                Endpoint::DownloadDump,
                client::download_dump_at_hash(&endpoint, &token, insecure_http, &project_id, sha),
            ),
            None => self.speleodb_handle_auth(
                Endpoint::DownloadDump,
                client::download_dump(&endpoint, &token, insecure_http, &project_id),
            ),
        };
        let Ok(zip) = downloaded else { return Ok(None) };
        let Ok(mut dump) = dump::Dump::open(&zip) else {
            return Ok(None);
        };
        // Through the shared resolver, not the bare one, so the probe classifies and
        // maps errors exactly as the flow it is predicting - including whether the
        // session's answer applies to the revision being asked about, which is the
        // whole reason the short-circuit above is gone. The resolver's recording side
        // effect stays inert: a probe passes no `chosen`, so there is nothing to
        // record - it is answering "would this ask?", which is not itself an answer.
        //
        // The Ariane route has to match the flow being predicted, or the probe would
        // advertise a picker the real call then refuses: at a `hexsha` this predicts
        // the revision swap, which cannot import.
        let ariane = if hexsha.is_some() {
            ArianeRoute::Refuse
        } else {
            ArianeRoute::Adopt
        };
        // Predicting a flow that ASKS, in both cases: the restore behind a `hexsha`
        // raises the picker, and so does the pull without one. `Refuse` here would
        // convert the very ambiguity this exists to report into a flat message.
        match self.speleodb_resolve_entry_remembering(
            &project_id,
            &mut dump,
            None,
            ariane,
            DumpAt::from_sha(hexsha.as_deref()),
            StalxAmbiguity::Ask,
        ) {
            Ok(_) => Ok(None),
            Err(
                SpeleoDbError::AmbiguousDump(candidates)
                | SpeleoDbError::AmbiguousAriane(candidates),
            ) => Ok(Some(candidates)),
            Err(_) => Ok(None),
        }
    }

    /// List the projects visible to the logged-in user, as display summaries.
    pub(crate) fn speleodb_list_projects(
        &self,
    ) -> Result<Vec<SpeleoProjectSummary>, SpeleoErrorDto> {
        let (endpoint, token) = self.speleodb_active_token().map_err(local_dto)?;
        let insecure_http = self.speleodb_insecure_http();
        // [Track C] (#188, C5): route through the 401 auto-drop handler - a
        // genuine 401 on this established-session call fully clears the token -
        // then map the surfaced SpeleoDbError to the typed DTO ([Track A] D-B2).
        let projects = self
            .speleodb_handle_auth(
                Endpoint::ListProjects,
                client::list_projects(&endpoint, &token, insecure_http),
            )
            .map_err(|e| dto_for_error(Endpoint::ListProjects, &e))?;
        Ok(projects
            .into_iter()
            .map(SpeleoProjectSummary::from_project)
            .collect())
    }

    /// Pull a project's dump, extract its `.stalx` into the app cache, and return
    /// the local path. The frontend then opens it via the normal `open_project`
    /// flow. Read-only against the server (nothing is locked or pushed).
    ///
    /// [Track B] (#189, D-B9) `project_name` + `latest_commit_sha` are threaded
    /// through the open path (extra args, SAME command name → EVENT_NAMES stays
    /// 418) so the extracted `.stalx` is stamped `is_remote == true` end-to-end.
    ///
    /// FRESHNESS-FOLD SEAM (D-B1): #185's get_project/list_projects return the
    /// authoritative Project on every call. The persistence fold (cache the
    /// freshness verdict + reset last_verify_at) is a DOCUMENTED NO-OP until the
    /// #202 piggyback path consumes it. base_commit_sha is captured ONCE here on
    /// pull and NEVER mutated by #189 (a later Sync/Release issue re-stamps it).
    pub(crate) fn speleodb_open_project(
        &self,
        project_id: String,
        project_name: String,
        latest_commit_sha: Option<String>,
        entry_path: Option<String>,
    ) -> Result<SpeleoOpenResult, SpeleoErrorDto> {
        self.speleodb_pull_project(
            project_id,
            project_name,
            latest_commit_sha,
            LocalEditsPolicy::Protect,
            entry_path,
        )
    }

    /// [`Self::speleodb_open_project`] with the un-pushed-edits guard WAIVED: pull
    /// the server copy over the local one, destroying edits that were never pushed.
    ///
    /// The "take remote and discard local" branch of the prompt the refusal raises
    /// (see [`crate::speleodb::UnpushedLocalEdits`]) - the frontend calls this with
    /// the same arguments the refused open was given, and only after the user has
    /// confirmed the loss. Named, not a flag, so there is no way to reach the
    /// destructive pull without spelling it out (mirrors `speleodb_take_remote`
    /// being its own verb rather than a parameter on `speleodb_update`).
    pub(crate) fn speleodb_open_project_discarding_local(
        &self,
        project_id: String,
        project_name: String,
        latest_commit_sha: Option<String>,
        entry_path: Option<String>,
    ) -> Result<SpeleoOpenResult, SpeleoErrorDto> {
        self.speleodb_pull_project(
            project_id,
            project_name,
            latest_commit_sha,
            LocalEditsPolicy::Discard,
            entry_path,
        )
    }

    /// Shared body of the two pull verbs above; `policy` is what separates them.
    fn speleodb_pull_project(
        &self,
        project_id: String,
        project_name: String,
        latest_commit_sha: Option<String>,
        policy: LocalEditsPolicy,
        entry_path: Option<String>,
    ) -> Result<SpeleoOpenResult, SpeleoErrorDto> {
        // Validate the id at the trust boundary, before it reaches the download
        // URL or the cache-path join (closes the path/route-traversal vector).
        validate_project_id(&project_id).map_err(local_dto)?;
        let (endpoint, token) = self.speleodb_active_token().map_err(local_dto)?;
        let insecure_http = self.speleodb_insecure_http();

        let dest = self.speleodb_cache_path(&project_id).map_err(local_dto)?;
        // Run the un-pushed-edits guard BEFORE the download, not just inside the
        // replace. It is a purely LOCAL check (it reads the cached copy's link row),
        // so nothing about it needs the dump - and when it is going to refuse, every
        // byte of that dump is downloaded, held in memory and thrown away first. With
        // the dump ceiling at [`client::DUMP_MAX_BYTES`] that is a long wait and a
        // large allocation spent to arrive at a decision we could have made
        // immediately. The call inside `replace_cache_stalx` stays as the backstop
        // that no call site can forget (and it is what the OTHER two replace flows
        // rely on); this one is purely to fail fast.
        if policy == LocalEditsPolicy::Protect {
            self.guard_local_edits(&project_id, &dest)
                .map_err(local_dto)?;
        }

        // FRESHNESS-FOLD SEAM (D-B1, #189/#191): #185's get_project/list_projects
        // return the authoritative Project; the pull stamp (project_name +
        // latest_commit_sha → speleo_link) and the cache-the-verdict fold land
        // with #189/#191 - this call site is where they hook in.
        //
        // [Track C] (#188, C5): route through the 401 auto-drop handler before
        // mapping the surfaced SpeleoDbError to the typed DTO ([Track A] D-B2).
        // Resolve the server's TRUE HEAD (the revision-topology leaf) FIRST, and then
        // fetch that commit's dump BY HASH.
        //
        // The order is the point. Downloading HEAD and asking what HEAD is are two
        // requests, so a push landing between them hands back commit A's tree
        // labelled B - and both things that label it matter: BASE is stamped from it,
        // and [#258] so is the remembered entry choice. A copy of A stamped B looks
        // current to every later fence, so Start editing sees BASE == B, never
        // reconciles, and the next push puts A over B. Pinning the download to the
        // sha we resolved removes the window rather than narrowing it: the bytes, the
        // date on the choice and BASE are then one immutable object by construction.
        //
        // NOT the list/get_project `latest_commit` field, which is
        // `max(authored_date)` and ties to the root creation commit (see
        // speleodb_server_head). Fetch the history DIRECTLY here (NOT via
        // speleodb_handle_auth) so a transient/spurious 401 on this best-effort
        // resolve cannot auto-drop the whole session mid-open; Start editing / Done DO
        // route revisions through the auto-drop (a dead token there must force
        // re-login). (#197 review.)
        let tip = match client::get_revisions(&endpoint, &token, insecure_http, &project_id) {
            // Through `usable_tip`: what comes back is about to be interpolated into an
            // authenticated by-hash URL, so it crosses the same boundary the restore
            // and the probe cross before building one.
            Ok(history) => usable_tip(
                sync::tip_of(&history.commits).map(str::to_owned),
                &project_id,
            ),
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    project_id = %project_id,
                    purpose = "resolve server HEAD on pull",
                    "speleodb_open_project: could not resolve server HEAD; \
                     falling back to an undated HEAD download"
                );
                None
            }
        };
        let zip = self
            .speleodb_handle_auth(
                Endpoint::DownloadDump,
                match tip.as_deref() {
                    Some(sha) => client::download_dump_at_hash(
                        &endpoint,
                        &token,
                        insecure_http,
                        &project_id,
                        sha,
                    ),
                    // No resolvable tip (an empty repo, or a history call that failed):
                    // take HEAD as before. What comes back is then genuinely undatable,
                    // which `tip` being `None` already says.
                    None => client::download_dump(&endpoint, &token, insecure_http, &project_id),
                },
            )
            .map_err(|e| dto_for_error(Endpoint::DownloadDump, &e))?;

        // [#258] The advisory sha may stamp BASE and may NOT date a choice - see
        // `PullDating` for why those are different questions.
        let PullDating {
            datable,
            base: base_sha,
        } = pull_dating(tip, latest_commit_sha);
        let dated_at = DumpAt::from_sha(datable.as_deref());

        // Open the dump once: list entries (to classify) and extract the chosen
        // `.stalx` from the same parsed archive.
        let mut dump = dump::Dump::open(&zip).map_err(local_dto)?;
        let entry = self
            .speleodb_resolve_entry_remembering(
                &project_id,
                &mut dump,
                entry_path.as_deref(),
                ArianeRoute::Adopt,
                dated_at,
                // The pull is where the picker lives: both its verbs carry an
                // `entryPath`, and all three frontend hosts raise the dialog on the
                // candidates this reports.
                StalxAmbiguity::Ask,
            )
            .map_err(local_dto)?;

        // Carry the user's local view toggles across the download-replace (a re-open
        // of a previously-customized remote project shouldn't reset their view -
        // display_settings are stripped from the server copy). Empty on first open.
        // Also drops the live handle when this very cache file is the open project
        // (a re-pull of what's already open); the FE re-opens it via `open_project`
        // once this returns.
        //
        // Under `Protect` this REFUSES when the cached copy still holds un-pushed
        // edits: re-opening a project from the SpeleoDB list is an ordinary,
        // non-destructive-looking action, so it must never be the thing that
        // destroys a week of unpushed survey. The refusal crosses IPC typed, and
        // the frontend re-enters through `speleodb_open_project_discarding_local`
        // if - and only if - the user chose to abandon the local copy.
        let preserved_view = self
            .replace_cache_stalx_with(&mut dump, &entry, &dest, &project_id, policy)
            .map_err(local_dto)?;

        // Concurrent same-account session notice (#193 b8): if the server already
        // reports a lock held by our OWN account, a second session is editing this
        // project - the ancestry classifier's "author_email == me" proxy can't tell
        // the two sessions apart (a second session's commit reads as "mine" and
        // could wrongly clear the dirty bit), so surface a notice on open. Computed
        // here, before `endpoint`/`token` are moved into the stamped link.
        // Best-effort: a failed lookup (or no session email) never fails the open.
        let concurrent_session = {
            let holder = self.speleodb_lock_holder(&endpoint, &token, insecure_http, &project_id);
            self.speleodb_my_email()
                .is_some_and(|me| sync::concurrent_session_notice(holder.as_deref(), &me))
        };

        // [Track B] (#189, D-B9) Stamp the SpeleoDB hand-off link into the pulled
        // `.stalx`. Opening via `open_existing` runs `ensure_schema_version`,
        // which creates the `speleo_link` table on the freshly-extracted file;
        // then upsert the single row. After this, `load_metadata().is_remote` is
        // true and the dirty bit (`has_unpushed_edits`) starts false.
        match crate::persistence::Database::open_existing(&dest) {
            Ok(db) => {
                restore_display_settings(&db, &preserved_view);
                let link = crate::models::SpeleoLink {
                    endpoint,
                    project_id: project_id.clone(),
                    project_name,
                    base_commit_sha: base_sha,
                    has_unpushed_edits: false,
                    last_edit_at: None,   // freshly pulled: no local edits yet
                    last_verify_at: None, // no lock held on pull; stamped on acquire (#202)
                };
                if let Err(e) = db.save_speleo_link(Some(&link)) {
                    // Non-fatal: the pull succeeded and the file is openable; the
                    // worst case is the project opens as local-only (editable)
                    // rather than read-only-remote. Surfacing a hard error here
                    // would strand a successfully-downloaded `.stalx`.
                    tracing::warn!(
                        error = %e,
                        project_id = %project_id,
                        purpose = "stamp SpeleoDB hand-off link on pull",
                        "speleodb_open_project: failed to stamp speleo_link; project will open local-only"
                    );
                }
            }
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    project_id = %project_id,
                    purpose = "stamp SpeleoDB hand-off link on pull",
                    "speleodb_open_project: could not reopen extracted .stalx to stamp speleo_link"
                );
            }
        }

        Ok(SpeleoOpenResult {
            local_path: dest.to_string_lossy().into_owned(),
            concurrent_session,
        })
    }

    /// [#214] Adopt an Ariane (`.tml`-only) SpeleoDB project: the ONE sanctioned
    /// server-`.tml` read, a one-time bootstrap (never an ongoing reconcile).
    /// Download the dump, import its `ariane.tml` through the existing TML importer,
    /// save a new `.stalx` at the same cache path a pull would use, stamp the
    /// hand-off link, and best-effort flip the server project `type` ariane→other.
    ///
    /// The FE calls this only after `speleodb_open_project` surfaced
    /// `SpeleoDbAction::Adopt` and the user confirmed. Like a pull, it does NOT push;
    /// the adopted `.stalx` is marked dirty (`has_unpushed_edits = true`) so the
    /// first Start-editing → Done pushes it and makes the server `.stalx`-canonical.
    /// Adoption replaces the open `AppState` project (the FE runs its usual
    /// unsaved-changes guard first, exactly as for any open); the webview then
    /// reloads `local_path`, which opens read-only-remote (`is_remote`, #191).
    ///
    /// `discard_local == true` waives the un-pushed-edits guard below, for the ONE
    /// caller that arrives having already had that loss confirmed - see the command
    /// wrapper.
    pub(crate) fn speleodb_adopt_ariane(
        &self,
        project_id: String,
        project_name: String,
        latest_commit_sha: Option<String>,
        discard_local: bool,
        entry_path: Option<String>,
    ) -> Result<SpeleoAdoptResult, SpeleoErrorDto> {
        validate_project_id(&project_id).map_err(local_dto)?;
        let (endpoint, token) = self.speleodb_active_token().map_err(local_dto)?;
        let insecure_http = self.speleodb_insecure_http();

        // [#258] Resolve the head BEFORE the download and fetch that commit by hash,
        // for the reason the pull does: two requests mean a push can land between
        // them, and a tree fetched at A but dated B would let a choice recorded here
        // be recalled against a dump it never described. Best-effort - an unresolvable
        // head just means the bytes are undatable, which is what `None` says, and
        // adoption then asks again through the picker it already hosts.
        //
        // DIRECTLY, not via `speleodb_server_head`, which wraps the same call in
        // `speleodb_handle_auth`. That handler `forget()`s the token on a 401 - keychain
        // entry included - and because this failure is deliberately swallowed and
        // `token` was captured above, routing it there let a spurious 401 delete the
        // user's stored credential while the adopt went on to succeed: signed out with
        // no signal and nothing to sign back in with. The pull states the rule for this
        // exact shape of call, and this function restates it 150 lines down for the type
        // flip; only the resolve was routed through the drop.
        let adopt_at = match client::get_revisions(&endpoint, &token, insecure_http, &project_id) {
            Ok(history) => usable_tip(
                sync::tip_of(&history.commits).map(str::to_owned),
                &project_id,
            ),
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    project_id = %project_id,
                    purpose = "date a remembered Ariane pick on adopt",
                    "speleodb_adopt_ariane: could not resolve server HEAD; re-asking instead \
                     of honouring an undatable choice"
                );
                None
            }
        };
        // Download the dump (routed through the auth handler like the pull, so a dead
        // token forces re-login).
        let zip = self
            .speleodb_handle_auth(
                Endpoint::DownloadDump,
                match adopt_at.as_deref() {
                    Some(sha) => client::download_dump_at_hash(
                        &endpoint,
                        &token,
                        insecure_http,
                        &project_id,
                        sha,
                    ),
                    None => client::download_dump(&endpoint, &token, insecure_http, &project_id),
                },
            )
            .map_err(|e| dto_for_error(Endpoint::DownloadDump, &e))?;

        // Classify authoritatively. Only proceed for a genuine Ariane-only dump; if a
        // `.stalx` has since appeared (a stale `type_tag`, a TOCTOU race with another
        // writer), refuse and tell the user to reopen normally rather than clobber it.
        let mut dump = dump::Dump::open(&zip).map_err(local_dto)?;
        let names = dump.entry_paths().map_err(local_dto)?;
        // [#258] A dump with several `ariane.tml` is ambiguous, and this is the flow
        // that answers it: the picker's choice arrives here, checked for membership
        // against THIS archive exactly like a `.stalx` pick. Without it the picker
        // would re-raise the same question on every retry, because nothing else on
        // this path can act on the answer.
        // The picker's answer reaches this command either directly, or - when the
        // ambiguity surfaced on the OPEN path, which refuses a `.tml` and routes
        // here - through the entry that path recorded for this session. That hand-off
        // is why `adopt_at` above is the TRUE HEAD and not the caller-supplied
        // `latest_commit_sha`: the open recorded the answer against the topology tip,
        // so reading it back against `max(authored_date)` would never match and the
        // picker would re-ask forever.
        //
        // This classifier is adoption's own - it wants an Ariane entry and refuses a
        // `.stalx` with its own message - so the resolver's dating does not reach it,
        // and BOTH halves of that dating have to be repeated here or the whole
        // guarantee stops at the `.stalx` picker. An `ariane.tml` behaves exactly like
        // a `.stalx` under a collaborator's push: the canonical file moves, every other
        // entry stays where it was, so a backup chosen at A sails through membership at
        // B - and adoption then imports it and stamps BASE at B.
        let adopt_dump_at = DumpAt::from_sha(adopt_at.as_deref());
        let remembered = self.speleodb_recalled_dump_entry(&project_id, adopt_dump_at);
        let picked = entry_path
            .as_deref()
            // The fresh reply is gated exactly as the resolver gates one: honoured only
            // while it answers the revision its candidates were offered for. The recall
            // beside it is already dated, so a discarded reply correctly falls back to
            // a remembered answer that IS about this tree, and otherwise to a re-offer.
            .filter(|_| self.speleodb_dump_offer_answers(&project_id, adopt_dump_at))
            .or(remembered.as_deref())
            .filter(|chosen| {
                dump::chosen_candidate(&names, chosen) == Some(dump::ChosenKind::Ariane)
            });
        let tml_entry = match (picked, dump::classify(&names)) {
            (Some(chosen), _) => chosen.to_owned(),
            (None, DumpClassification::AdoptAriane(tml)) => tml,
            (None, DumpClassification::Stalx(_)) => {
                return Err(local_dto(SpeleoDbError::Parse(
                    "this project now has a Stalagmight file on the server; reopen it normally"
                        .to_owned(),
                )));
            }
            (None, DumpClassification::NothingToOpen) => {
                return Err(local_dto(SpeleoDbError::EmptyDump))
            }
            // Both ambiguities record the offer, for the same reason the resolver does:
            // these candidates are going to a user, and the reply arrives through a
            // separate call that resolves the tip again. The `.stalx` set is no
            // exception - the frontend routes it by kind to the OPEN verb, which reads
            // this same record.
            (None, DumpClassification::AmbiguousStalx(paths)) => {
                self.speleodb_note_dump_offer(&project_id, adopt_dump_at);
                return Err(local_dto(unopenable_to_error(
                    UnopenableDump::AmbiguousStalx(paths),
                    &mut dump,
                )));
            }
            (None, DumpClassification::AmbiguousAriane(paths)) => {
                self.speleodb_note_dump_offer(&project_id, adopt_dump_at);
                return Err(local_dto(unopenable_to_error(
                    UnopenableDump::AmbiguousAriane(paths),
                    &mut dump,
                )));
            }
        };

        // Extract the `ariane.tml` to a scratch file beside the cache `.stalx`, import
        // it, then remove the scratch file. The importer needs a path on disk.
        let dest = self.speleodb_cache_path(&project_id).map_err(local_dto)?;
        // The one cache replace that does NOT run through `replace_cache_stalx`:
        // `adopt_import_and_save` deletes `dest` and rebuilds it from the imported
        // `.tml`, so it needs the same data-safety gate. Re-adoption is reachable
        // (an adopted project is stamped dirty, and the server type flip is
        // best-effort - a failed flip leaves the project still offering Adopt), and
        // it would otherwise delete the adopted copy's un-pushed edits.
        //
        // Waived only for the caller that has already had exactly this loss
        // confirmed: "take the server copy and discard my local changes" on a
        // refused open, which lands here when the project is still Ariane. Refusing
        // that user again asks the same question twice and answers it with a dead
        // end, since re-adopting IS the only way to open the project at all.
        //
        // Written as the plain condition it is: adoption rebuilds `dest` itself
        // instead of going through `replace_cache_stalx_with`, so it has no
        // [`LocalEditsPolicy`] to pass on - the value used to be constructed here and
        // then only compared against, purely so a source-string tripwire in
        // `speleodb_cache` would count it. See that module's test for what pins the
        // waiver now.
        if !discard_local {
            self.guard_local_edits(&project_id, &dest)
                .map_err(local_dto)?;
        }
        let tml_scratch = dest.with_file_name("adopt-source.tml");
        dump.extract_entry_to(&tml_entry, &tml_scratch)
            .map_err(local_dto)?;
        let adopt = self.adopt_import_and_save(&tml_scratch, &dest, project_name.clone());
        // Best-effort scratch cleanup regardless of import outcome.
        let _ = std::fs::remove_file(&tml_scratch);
        adopt?;

        // BASE = the commit this project was actually built from, which is the one
        // already resolved above and downloaded by hash - NOT a second lookup here.
        //
        // A second lookup reintroduces the window the by-hash download closed, and on
        // the worst possible side of it. The import between them is slow (parse the
        // `.tml`, build the project, save it), so a revision landing during it is not
        // exotic; the copy would then be A-derived content stamped BASE = B, and
        // stamped `has_unpushed_edits` too. Start editing reads BASE == tip and calls
        // it UpToDate, so nothing ever fast-forwards, and the push then reads base ==
        // tip and plans a plain Upload - putting A over B with no divergence raised.
        // Silently overwriting the very revision that landed while we were importing.
        //
        // Keeping the original sha instead means BASE is A, so if B did land the copy
        // is honestly behind: the fence sees a commit that is not ours and raises the
        // divergence prompt, which is the outcome the user can act on.
        let PullDating { base: base_sha, .. } = pull_dating(adopt_at, latest_commit_sha);

        // Stamp the hand-off link onto the saved `.stalx`. `has_unpushed_edits = true`:
        // the adopted `.stalx` is content the server does not have yet, so the first
        // Start-editing → Done pushes it (BASE == tip → UpToDate, no false divergence).
        match crate::persistence::Database::open_existing(&dest) {
            Ok(db) => {
                let link = crate::models::SpeleoLink {
                    endpoint: endpoint.clone(),
                    project_id: project_id.clone(),
                    project_name,
                    base_commit_sha: base_sha,
                    has_unpushed_edits: true,
                    last_edit_at: None,
                    last_verify_at: None,
                };
                if let Err(e) = db.save_speleo_link(Some(&link)) {
                    tracing::warn!(
                        error = %e,
                        project_id = %project_id,
                        purpose = "stamp SpeleoDB hand-off link on adopt",
                        "speleodb_adopt_ariane: failed to stamp speleo_link; project will open local-only"
                    );
                }
            }
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    project_id = %project_id,
                    purpose = "stamp SpeleoDB hand-off link on adopt",
                    "speleodb_adopt_ariane: could not reopen adopted .stalx to stamp speleo_link"
                );
            }
        }

        // Best-effort flip the server project `type` ariane→other (READ_AND_WRITE).
        // Called directly (NOT via the auth handler) so a spurious 401/403 on this last
        // step can't auto-drop the session AFTER the project is already adopted locally.
        // A permission failure (READ_ONLY user) is the expected `type_flipped = false`.
        let type_flipped = match client::patch_project(
            &endpoint,
            &token,
            insecure_http,
            &project_id,
            r#"{"type":"other"}"#,
        ) {
            Ok(_) => true,
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    project_id = %project_id,
                    purpose = "flip SpeleoDB project type ariane->other on adopt",
                    "speleodb_adopt_ariane: type flip failed (likely no write access); adopted locally"
                );
                false
            }
        };

        // Concurrent same-account session notice (mirrors the pull, #193 b8).
        let concurrent_session = {
            let holder = self.speleodb_lock_holder(&endpoint, &token, insecure_http, &project_id);
            self.speleodb_my_email()
                .is_some_and(|me| sync::concurrent_session_notice(holder.as_deref(), &me))
        };

        Ok(SpeleoAdoptResult {
            local_path: dest.to_string_lossy().into_owned(),
            type_flipped,
            concurrent_session,
        })
    }

    /// Import an extracted `ariane.tml` into a fresh project and save it as a new
    /// `.stalx` at `dest`. Split out of [`Self::speleodb_adopt_ariane`] so the pure
    /// create → import → save pipeline is separable from the network/link steps.
    ///
    /// Reuses the existing importer defaults (`include_excluded = false`,
    /// `comments_on_stations = true`) - the same settings the collab `.tml`
    /// round-trip and the FE import dialog use, so adoption yields the identical
    /// survey a manual TML import would. Overwrites any stale cache `.stalx`
    /// (re-adoption is a clean re-pull, like the pull path).
    fn adopt_import_and_save(
        &self,
        tml_path: &Path,
        dest: &Path,
        project_name: String,
    ) -> Result<(), SpeleoErrorDto> {
        // Re-adoption overwrites: remove a stale cache `.stalx` so create reserves the
        // exact cache path (it auto-renames around an existing file otherwise).
        let _ = std::fs::remove_file(dest);

        self.do_create_project_full(project_name, None, None, Some(dest.to_path_buf()), true)
            .map_err(|e| local_dto(SpeleoDbError::Io(e.to_string())))?;

        let tml = crate::parsers::tml::parse_tml(tml_path)
            .map_err(|e| local_dto(SpeleoDbError::Parse(e.to_string())))?;
        let (sections, closures) =
            crate::parsers::tml::convert_tml_to_import_configs(&tml, false, true)
                .map_err(|e| local_dto(SpeleoDbError::Parse(e.to_string())))?;
        // Auto: adoption is an ordinary Ariane import with no dialog to carry a
        // per-file override, so its virtual shots get the chain rule (#27).
        let auto = VirtualShotMode::Auto;
        let imported =
            self.execute_import_sections(sections, closures, None, Vec::new(), Vec::new(), auto);

        if !imported.success {
            return Err(local_dto(SpeleoDbError::Parse(format!(
                "could not import the Ariane .tml: {}",
                imported.error.unwrap_or_else(|| "unknown error".to_owned())
            ))));
        }

        let saved =
            crate::commands::project::save_project_impl(self, Some(dest.to_path_buf()), false);
        if !saved.success {
            return Err(local_dto(SpeleoDbError::Io(format!(
                "could not save the adopted project: {}",
                saved.error.unwrap_or_else(|| "unknown error".to_owned())
            ))));
        }
        Ok(())
    }

    /// Fast-forward the open remote project to the server tip: re-pull the dump,
    /// re-stamp the link (`base = tip`, dirty cleared, `last_edit_at` reset), then
    /// reload the project in place (resetting undo/redo). Returns the reloaded
    /// `.stalx` path.
    ///
    /// `policy` because the two callers mean opposite things by the same mechanics:
    ///
    /// - `speleodb_start_editing` / `speleodb_update` reach the FF arm only on
    ///   [`ReconcileVerdict::FastForward`], which `sync::fence` yields exclusively
    ///   in its `!dirty` branch - so there are no un-pushed edits to lose and
    ///   `Protect` is a no-op there. It is passed anyway, as the assertion: if that
    ///   invariant ever breaks, the FF refuses instead of overwriting.
    /// - `speleodb_take_remote` is only ever reached WITH un-pushed edits and exists
    ///   to discard them, behind the frontend's second destroy-confirmation, so it
    ///   passes `Discard`.
    pub(super) fn speleodb_fast_forward(
        &self,
        endpoint: &str,
        token: &str,
        insecure_http: bool,
        link: &crate::models::SpeleoLink,
        tip: Option<&str>,
        policy: LocalEditsPolicy,
    ) -> Result<String, SpeleoDbError> {
        let project_id = &link.project_id;
        // [#258 review] Pinned to the sha this call is fast-forwarding TO, because that
        // sha is what dates the remembered choice below AND what stamps BASE. It used to
        // download plain HEAD and assert in a comment that the two agreed; they are two
        // requests, `tip` was resolved by the caller's fence, and `speleodb_update`
        // holds no lock while `speleodb_take_remote` releases before getting here - so a
        // push landing in between handed back commit B's tree labelled A. This is the
        // window the pull and adopt paths were both changed to close; the fast-forward
        // is the one that kept the claim without the fix.
        let pinned = usable_tip(tip.map(str::to_owned), project_id);
        let zip = self.speleodb_handle_auth(
            Endpoint::DownloadDump,
            match pinned.as_deref() {
                Some(sha) => {
                    client::download_dump_at_hash(endpoint, token, insecure_http, project_id, sha)
                }
                // No usable tip: take HEAD as before, and say so by dating it `Unknown`
                // rather than with a sha these bytes are not known to be.
                None => client::download_dump(endpoint, token, insecure_http, project_id),
            },
        )?;
        let mut dump = dump::Dump::open(&zip)?;
        // [#258] No `entryPath` reaches this verb - it honours whatever the session
        // already settled, and a miss still fails closed rather than guessing.
        // Adoption is reachable from here: this verb pulls the TIP, which is exactly
        // what adoption would import, so routing to it answers the same question.
        //
        // `tip` is what this whole call is fast-forwarding TO, so it is also what the
        // dump it just downloaded is - which makes it the right yardstick for a
        // remembered answer. A choice made at an earlier revision no longer applies,
        // and that is precisely the case this verb must not paper over: the entry it
        // names is still in the tree (a push leaves every non-canonical `.stalx`
        // alone), so membership would wave it through and extract pre-push bytes under
        // a BASE stamped at the new tip.
        //
        // And `Refuse`, because there is nowhere to ask: no picker is bound to Start
        // editing, Update or Take remote.
        let entry = self.speleodb_resolve_entry_remembering(
            project_id,
            &mut dump,
            None,
            ArianeRoute::Adopt,
            DumpAt::from_sha(pinned.as_deref()),
            StalxAmbiguity::Refuse,
        )?;
        let dest = self.speleodb_cache_path(project_id)?;
        // Capture the user's local view toggles BEFORE the download replaces the
        // file - they're stripped from the server copy, so they'd otherwise reset
        // to defaults on every fast-forward - and close the live handle to this
        // file before the replace. The reload below re-opens it and already resets
        // undo/redo, so hoisting the close ahead of the extract is behaviour-
        // preserving.
        let preserved_view =
            self.replace_cache_stalx_with(&mut dump, &entry, &dest, project_id, policy)?;

        // Re-stamp the hand-off link onto the refreshed file: BASE advances to the
        // server tip, the dirty bit clears, last_edit_at resets (clean checkout).
        match crate::persistence::Database::open_existing(&dest) {
            Ok(db) => {
                restore_display_settings(&db, &preserved_view);
                let new_link = crate::models::SpeleoLink {
                    endpoint: endpoint.to_owned(),
                    project_id: project_id.clone(),
                    project_name: link.project_name.clone(),
                    // The same sha the dump was fetched at, so BASE cannot name a
                    // commit these bytes did not come from.
                    base_commit_sha: pinned.clone(),
                    has_unpushed_edits: false,
                    last_edit_at: None,
                    // A fresh pull confirms BASE == the server tip as of now, so this
                    // IS a lock re-verify point (#202): stamp it so the 20-min lazy
                    // re-verify starts its window from the pull, not from acquire-time.
                    last_verify_at: Some(chrono::Utc::now().to_rfc3339()),
                };
                if let Err(e) = db.save_speleo_link(Some(&new_link)) {
                    tracing::warn!(
                        error = %e,
                        project_id = %project_id,
                        purpose = "re-stamp speleo_link after fast-forward",
                        "speleodb_fast_forward: failed to re-stamp speleo_link"
                    );
                }
            }
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    project_id = %project_id,
                    purpose = "re-stamp speleo_link after fast-forward",
                    "speleodb_fast_forward: could not reopen extracted .stalx to re-stamp"
                );
            }
        }

        // Reload from the refreshed cache file. close_project clears the in-memory
        // project so do_load_project_full's "already open" guard won't reject the
        // same path; do_load_project_full re-opens it. The pulled snapshot carries
        // NO undo/redo history (stripped on push by sanitize_push_snapshot, #194 b3),
        // so the reload starts the in-memory stacks empty - i.e. adopt-remote resets
        // undo/redo, never inheriting the pusher's edit history.
        let local_path = dest.to_string_lossy().into_owned();
        self.close_project();
        self.do_load_project_full(dest)
            .map_err(|e| SpeleoDbError::Io(format!("reload after fast-forward failed: {e}")))?;
        Ok(local_path)
    }
}

#[cfg(test)]
#[expect(clippy::expect_used, reason = "unit test fixtures")]
mod tests {
    use super::{
        classify_dump_entry, probe_inputs_valid, pull_dating, resolve_dump_entry, usable_tip,
        ArianeRoute, DumpAt, PullDating, StalxAmbiguity, UnopenableDump,
    };
    use crate::core::state::tests_support::speleodb_prod_matches;
    use crate::core::state::AppState;
    use crate::speleodb::dump::Dump;
    use crate::speleodb::SpeleoDbError;

    /// The revision the resolve tests pretend their dumps came from. Most of them
    /// are not about dating at all, so they use one sha throughout and let the recall
    /// behave as it did before choices carried a revision.
    const TIP: &str = "1111111111111111111111111111111111111111";
    /// A later revision, for the tests that ARE about dating.
    const NEXT: &str = "2222222222222222222222222222222222222222";

    /// A dump ZIP holding `entries`, for the resolve tests below.
    fn make_zip(entries: &[&str]) -> Vec<u8> {
        use std::io::Write as _;
        let mut writer = zip::write::ZipWriter::new(std::io::Cursor::new(Vec::<u8>::new()));
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for name in entries {
            writer.start_file(*name, opts).expect("start_file");
            writer.write_all(b"x").expect("write entry");
        }
        writer.finish().expect("finish zip").into_inner()
    }

    /// [#258] An automatic classification is NOT an answer, so it must not be
    /// recorded as one. Recording it made a sole `.stalx` a standing session choice:
    /// the moment a collaborator added a second one the recall still validated - the
    /// original file is still in the tree - so the picker never opened and every
    /// later pull, plus the push after it, silently kept using the file nobody chose.
    #[test]
    fn an_unambiguous_dump_records_no_choice_so_a_later_rival_still_asks() {
        let state = AppState::new().expect("state");
        let project = "11111111-1111-1111-1111-111111111111";

        // One `.stalx`: resolved without a question, so nothing is remembered.
        let sole = make_zip(&["backup/old.stalx"]);
        let mut dump = Dump::open(&sole).expect("open");
        assert_eq!(
            state
                .speleodb_resolve_entry_remembering(
                    project,
                    &mut dump,
                    None,
                    ArianeRoute::Adopt,
                    DumpAt::Revision(TIP),
                    StalxAmbiguity::Ask,
                )
                .expect("sole .stalx opens"),
            "backup/old.stalx"
        );
        assert_eq!(
            state.speleodb_recalled_dump_entry(project, DumpAt::Revision(TIP)),
            None,
            "an unasked question must leave no remembered answer"
        );

        // A rival appears. The old name is still a member, so a recorded choice would
        // have been silently reused; with none recorded the user is asked instead.
        let rivals = make_zip(&["backup/old.stalx", "project.stalx"]);
        let mut dump = Dump::open(&rivals).expect("open");
        assert!(
            matches!(
                state.speleodb_resolve_entry_remembering(
                    project,
                    &mut dump,
                    None,
                    ArianeRoute::Adopt,
                    DumpAt::Revision(TIP),
                    StalxAmbiguity::Ask,
                ),
                Err(SpeleoDbError::AmbiguousDump(_))
            ),
            "a second .stalx must raise the ambiguity, not resolve from a phantom choice"
        );
    }

    /// The other half of the same rule: an answer the user actually gave IS recorded,
    /// so the next flow in the session does not re-ask. A pick the archive refuses is
    /// not an answer and leaves nothing behind.
    #[test]
    fn an_explicit_pick_is_remembered_and_a_refused_one_is_not() {
        let state = AppState::new().expect("state");
        let project = "22222222-2222-2222-2222-222222222222";
        let zip = make_zip(&["a.stalx", "b.stalx"]);

        let mut dump = Dump::open(&zip).expect("open");
        let refused = state.speleodb_resolve_entry_remembering(
            project,
            &mut dump,
            Some("gone.stalx"),
            ArianeRoute::Adopt,
            DumpAt::Revision(TIP),
            StalxAmbiguity::Ask,
        );
        assert!(matches!(refused, Err(SpeleoDbError::AmbiguousDump(_))));
        assert_eq!(
            state.speleodb_recalled_dump_entry(project, DumpAt::Revision(TIP)),
            None,
            "a pick this archive does not offer is not an answer"
        );

        let mut dump = Dump::open(&zip).expect("open");
        assert_eq!(
            state
                .speleodb_resolve_entry_remembering(
                    project,
                    &mut dump,
                    Some("b.stalx"),
                    ArianeRoute::Adopt,
                    DumpAt::Revision(TIP),
                    StalxAmbiguity::Ask,
                )
                .expect("honoured"),
            "b.stalx"
        );
        assert_eq!(
            state
                .speleodb_recalled_dump_entry(project, DumpAt::Revision(TIP))
                .as_deref(),
            Some("b.stalx"),
            "the user's answer must survive to the next flow in this session"
        );
    }

    /// [#258] Adoption downloads the project TIP, so a revision swap that routed to
    /// it would answer a question about an old `hexsha` with today's contents. Both
    /// Ariane shapes therefore refuse under `Refuse` - offering a picker for the
    /// ambiguous one would only move the dead end one click later - and a refused
    /// pick leaves no remembered answer behind.
    #[test]
    fn a_revision_refuses_ariane_instead_of_routing_to_a_tip_only_adoption() {
        let state = AppState::new().expect("state");
        let project = "33333333-3333-3333-3333-333333333333";

        for entries in [vec!["ariane.tml"], vec!["one/ariane.tml", "two/ariane.tml"]] {
            let zip = make_zip(&entries);
            let mut dump = Dump::open(&zip).expect("open");
            let refusal = state.speleodb_resolve_entry_remembering(
                project,
                &mut dump,
                None,
                ArianeRoute::Refuse,
                DumpAt::Revision(TIP),
                StalxAmbiguity::Ask,
            );
            assert!(
                matches!(refusal, Err(SpeleoDbError::Parse(_))),
                "{entries:?} must refuse with a reason, not an adoption signal"
            );
        }

        // Even an explicit Ariane pick records nothing on a flow that refuses it.
        let zip = make_zip(&["one/ariane.tml", "two/ariane.tml"]);
        let mut dump = Dump::open(&zip).expect("open");
        let _ = state.speleodb_resolve_entry_remembering(
            project,
            &mut dump,
            Some("two/ariane.tml"),
            ArianeRoute::Refuse,
            DumpAt::Revision(TIP),
            StalxAmbiguity::Ask,
        );
        assert_eq!(
            state.speleodb_recalled_dump_entry(project, DumpAt::Revision(TIP)),
            None,
            "a pick the flow refuses must not be remembered as an answer"
        );
    }

    /// [#258] A push writes the canonical name and touches nothing else, so a
    /// remembered entry is pre-push data the instant the push lands. Left in place it
    /// was a silent rollback: the next same-session open or fast-forward extracted
    /// that stale database and stamped it with the new server revision, publishing a
    /// commit that claims to hold work it does not.
    #[test]
    fn a_landed_push_forgets_every_remembered_choice() {
        let state = AppState::new().expect("state");
        let project = "55555555-5555-5555-5555-555555555555";

        // A canonical BASENAME earns no exemption, and this is the case that proves
        // why: with two of them in the tree, the one the user picked may be the
        // backup, and the push updates the other. A name that only says "could be
        // the target" cannot license keeping it - the same conclusion
        // `Dump::entry_details` reaches about the same predicate.
        for entry in [
            "backup/old.stalx",
            "backup/project.stalx",
            "misc/project.stalx",
            "project.stalx",
        ] {
            state.speleodb_remember_dump_entry(project, entry, DumpAt::Revision(TIP));
            state.speleodb_forget_dump_entry(project);
            assert_eq!(
                state.speleodb_recalled_dump_entry(project, DumpAt::Revision(TIP)),
                None,
                "`{entry}` must not survive a push: nothing here proves it is the \
                 file the upload actually replaced"
            );
        }
    }

    /// [#258] The rollback the rule above prevents for OUR push has a second author:
    /// anyone else with write access. Their push updates the canonical entry and
    /// leaves the backup exactly where it is, so the remembered name still passes
    /// membership - the guard the recall used to rely on - while pointing at bytes
    /// from before their work. Extracting that and stamping BASE at the new tip
    /// leaves the copy looking current, and the next push replaces their revision
    /// with no divergence to stop it. Nothing local can observe their push, so the
    /// choice has to carry the revision it was an answer about.
    #[test]
    fn a_choice_is_an_answer_about_one_revision_and_not_the_next() {
        let state = AppState::new().expect("state");
        let project = "66666666-6666-6666-6666-666666666666";

        // The user picks the backup at TIP, and it is honoured there.
        let zip = make_zip(&["backup/old.stalx", "project.stalx"]);
        let mut dump = Dump::open(&zip).expect("open");
        assert_eq!(
            state
                .speleodb_resolve_entry_remembering(
                    project,
                    &mut dump,
                    Some("backup/old.stalx"),
                    ArianeRoute::Adopt,
                    DumpAt::Revision(TIP),
                    StalxAmbiguity::Ask,
                )
                .expect("an explicit pick is honoured"),
            "backup/old.stalx"
        );
        assert_eq!(
            state
                .speleodb_recalled_dump_entry(project, DumpAt::Revision(TIP))
                .as_deref(),
            Some("backup/old.stalx"),
            "the answer stands for the revision it was given about"
        );

        // A collaborator pushes. Same two entries in the tree, so membership is no
        // help at all - only the revision says the answer no longer describes it.
        assert_eq!(
            state.speleodb_recalled_dump_entry(project, DumpAt::Revision(NEXT)),
            None,
            "a choice made at an earlier revision must not be honoured at a later one"
        );
        let mut dump = Dump::open(&zip).expect("open");
        assert!(
            matches!(
                state.speleodb_resolve_entry_remembering(
                    project,
                    &mut dump,
                    None,
                    ArianeRoute::Adopt,
                    DumpAt::Revision(NEXT),
                    StalxAmbiguity::Ask,
                ),
                Err(SpeleoDbError::AmbiguousDump(_))
            ),
            "the tree moved under the choice, so the user has to be asked again \
             rather than handed the pre-push file"
        );
    }

    /// [#258] Adoption must resolve the server head ONCE and stamp BASE from that same
    /// sha - the commit it downloaded by hash - rather than looking it up again after
    /// the import.
    ///
    /// A second lookup reopens the window the by-hash download closed, on the worst
    /// side of it. The import between them is slow (parse, build, save), so a revision
    /// landing during it is ordinary; the copy is then A-derived content stamped
    /// BASE = B and `has_unpushed_edits`. Start editing reads BASE == tip and calls it
    /// UpToDate so nothing fast-forwards, and the push reads base == tip and plans a
    /// plain Upload - putting A over B with no divergence raised, which silently
    /// overwrites the very revision that landed during the import.
    ///
    /// Guarded by SOURCE, like the pull's guard-before-download ordering above and for
    /// the same reason: reaching the real thing needs a server that can advance its
    /// head mid-import. The live orchestration tests are where a behavioural version
    /// would go.
    #[test]
    fn adoption_stamps_base_from_the_commit_it_downloaded_not_a_later_lookup() {
        let src = prod_source();
        let start = src
            .find("fn speleodb_adopt_ariane")
            .expect("the adoption verb is present");
        let body = &src[start..];
        let body = &body[..body.find("\n    }\n").expect("fn body terminates")];

        assert_eq!(
            body.matches("client::get_revisions(").count()
                + body.matches("speleodb_server_head(").count(),
            1,
            "adoption must resolve the head exactly once; a second lookup after the \
             import is what lets an A-derived project be stamped BASE = B"
        );
        assert!(
            body.contains("pull_dating(adopt_at"),
            "BASE must come from the sha adoption downloaded by hash, through the same \
             split that keeps the advisory fallback off the choice dating"
        );
    }

    /// [#258] The tip that pins the by-hash download comes off the wire, and it lands
    /// in an authenticated request path - so it crosses the same boundary the restore
    /// and the probe cross before building one of those URLs. Server-derived is not
    /// trusted: it is only ever as trustworthy as the box we are pointed at.
    ///
    /// A rejection is a fallback, not a failure. `None` sends the caller to the plain
    /// HEAD download AND marks the result undatable, so no by-hash request is built
    /// and no choice can be recalled against it.
    #[test]
    fn a_tip_that_could_reshape_the_download_url_is_not_used_to_build_one() {
        let project = "99999999-9999-9999-9999-999999999999";

        assert_eq!(
            usable_tip(Some(TIP.to_owned()), project),
            Some(TIP.to_owned())
        );
        assert_eq!(
            usable_tip(Some("abc1234".to_owned()), project),
            Some("abc1234".to_owned()),
            "a short prefix is a legitimate git id and must still pin the download"
        );
        assert_eq!(usable_tip(None, project), None);

        for hostile in [
            "../../user",
            "abc1234?x=y",
            "abc1234#frag",
            "abc/1234",
            "abc 1234",
            "abc1234\n",
            "abc1234\u{0}",
            "abc123",  // 6 chars - under the floor, so not an id at all
            "abc123g", // non-hex
            "",
        ] {
            assert_eq!(
                usable_tip(Some(hostile.to_owned()), project),
                None,
                "`{hostile}` must never reach the by-hash URL; the caller falls back \
                 to plain HEAD and treats the dump as undatable"
            );
        }
    }

    /// [#258] BASE may fall back to the caller's advisory sha; a CHOICE DATE may not.
    /// Folding the two together is how the guarantee quietly dies: `latest_commit_sha`
    /// is `max(authored_date)`, so it can name the root commit and stay there while
    /// revision after revision lands - and a choice recorded under a sha that never
    /// changes goes on matching for as long as the session lasts, which is exactly the
    /// unscoped recall this replaced.
    #[test]
    fn only_an_authoritative_tip_may_date_a_choice() {
        let tip = || Some(TIP.to_owned());
        let advisory = || Some(NEXT.to_owned());

        // With a tip, both answers are that tip - the advisory sha is not consulted.
        assert_eq!(
            pull_dating(tip(), advisory()),
            PullDating {
                datable: tip(),
                base: tip(),
            }
        );

        // Without one, BASE takes the fallback and the dating does NOT.
        assert_eq!(
            pull_dating(None, advisory()),
            PullDating {
                datable: None,
                base: advisory(),
            },
            "an unresolvable head must leave the dump undatable even though BASE is \
             still worth a best-effort stamp"
        );

        assert_eq!(
            pull_dating(None, None),
            PullDating {
                datable: None,
                base: None,
            }
        );
    }

    /// [#258] The picker's reply is an answer about ONE tree. Confirming it replays the
    /// verb, which resolves the tip again - so if a revision landed while the dialog was
    /// open, the answer to A arrives against B. Membership is no defence at all here:
    /// the backup the user chose survives the push untouched, which is exactly why it
    /// still passes. The pick is discarded and the current candidates re-offered.
    #[test]
    fn a_pick_that_answers_an_earlier_revision_is_refused_and_re_offered() {
        let state = AppState::new().expect("state");
        let project = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
        let zip = make_zip(&["backup/old.stalx", "project.stalx"]);

        // Candidates offered for A. Recording that is the whole mechanism: it is what
        // later distinguishes an answer to this question from an answer to another.
        let mut dump = Dump::open(&zip).expect("open");
        assert!(matches!(
            state.speleodb_resolve_entry_remembering(
                project,
                &mut dump,
                None,
                ArianeRoute::Adopt,
                DumpAt::Revision(TIP),
                StalxAmbiguity::Ask,
            ),
            Err(SpeleoDbError::AmbiguousDump(_))
        ));

        // A collaborator pushes while the picker is open, then the user confirms. The
        // chosen entry is still in B's tree - untouched by their push - so nothing about
        // the archive objects.
        let mut dump = Dump::open(&zip).expect("open");
        let replayed = state.speleodb_resolve_entry_remembering(
            project,
            &mut dump,
            Some("backup/old.stalx"),
            ArianeRoute::Adopt,
            DumpAt::Revision(NEXT),
            StalxAmbiguity::Ask,
        );
        assert!(
            matches!(replayed, Err(SpeleoDbError::AmbiguousDump(_))),
            "an answer about an earlier revision must be refused, not extracted"
        );
        assert_eq!(
            state.speleodb_recalled_dump_entry(project, DumpAt::Revision(NEXT)),
            None,
            "and it must not be recorded on its way past either"
        );

        // The refusal re-offered B's candidates, so answering THAT question works and
        // the flow cannot loop.
        let mut dump = Dump::open(&zip).expect("open");
        assert_eq!(
            state
                .speleodb_resolve_entry_remembering(
                    project,
                    &mut dump,
                    Some("backup/old.stalx"),
                    ArianeRoute::Adopt,
                    DumpAt::Revision(NEXT),
                    StalxAmbiguity::Ask,
                )
                .expect("the re-offer is answerable"),
            "backup/old.stalx"
        );
    }

    /// [#258] The same question for Ariane. An `ariane.tml` behaves exactly like a
    /// `.stalx` under a collaborator's push - the canonical file moves, every other
    /// entry stays where it was - so a backup chosen at A still passes membership at B,
    /// and adoption would import it and stamp BASE at B. The gate is shared session
    /// state, so the offer an OPEN records is the one adoption's reply is measured
    /// against; this pins that hand-off, which is the half a structural scan cannot see.
    #[test]
    fn an_ariane_offer_is_dated_the_same_way_and_read_back_by_adoption() {
        let state = AppState::new().expect("state");
        let project = "dddddddd-dddd-dddd-dddd-dddddddddddd";
        let zip = make_zip(&["one/ariane.tml", "two/ariane.tml"]);

        // The OPEN path meets the ambiguity and offers the candidates for A.
        let mut dump = Dump::open(&zip).expect("open");
        assert!(matches!(
            state.speleodb_resolve_entry_remembering(
                project,
                &mut dump,
                None,
                ArianeRoute::Adopt,
                DumpAt::Revision(TIP),
                StalxAmbiguity::Ask,
            ),
            Err(SpeleoDbError::AmbiguousAriane(_))
        ));

        // Adoption reads that record back. An answer about A does not answer B...
        assert!(!state.speleodb_dump_offer_answers(project, DumpAt::Revision(NEXT)));
        // ...and does answer A, so the ordinary confirmation is untouched.
        assert!(state.speleodb_dump_offer_answers(project, DumpAt::Revision(TIP)));
    }

    /// [#258] Adoption classifies with its OWN matcher - it wants an Ariane entry and
    /// refuses a `.stalx` with its own message - so the resolver's dating never reaches
    /// it and both halves have to be repeated there. Missing either restored the
    /// overwrite for Ariane alone, which is exactly how it was missed the first time:
    /// the `.stalx` picker was bound and this one silently was not.
    ///
    /// Structural because the behavioural version needs a server - the gate itself is
    /// covered above, on the session state the two paths share.
    #[test]
    fn adoption_dates_its_own_picker_replies_too() {
        let src = prod_source();
        let start = src
            .find("fn speleodb_adopt_ariane")
            .expect("the adoption verb is present");
        let body = &src[start..];
        let body = &body[..body.find("\n    }\n").expect("fn body terminates")];

        assert_eq!(
            body.matches("speleodb_dump_offer_answers(").count(),
            1,
            "adoption must gate a FRESH `entry_path` on the revision its candidates \
             were offered for, exactly as the resolver gates one"
        );
        assert_eq!(
            body.matches("speleodb_note_dump_offer(").count(),
            2,
            "both ambiguities adoption reports - the Ariane set, and the `.stalx` set \
             the frontend routes by kind to the OPEN verb - must record the revision \
             they describe, or the reply has nothing to be measured against"
        );
    }

    /// The permissive halves of the same gate, both deliberate. An undatable dump has
    /// no revision to disagree with, and refusing there would re-offer an equally
    /// undatable question - the picker would ask forever. A pick with no offer behind
    /// it contradicts nothing, and is still membership-checked.
    #[test]
    fn a_pick_is_only_refused_when_the_offer_positively_disagrees() {
        let state = AppState::new().expect("state");
        let zip = make_zip(&["a.stalx", "b.stalx"]);

        for (project, at) in [
            ("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", DumpAt::Unknown),
            (
                "cccccccc-cccc-cccc-cccc-cccccccccccc",
                DumpAt::Revision(TIP),
            ),
        ] {
            let mut dump = Dump::open(&zip).expect("open");
            assert_eq!(
                state
                    .speleodb_resolve_entry_remembering(
                        project,
                        &mut dump,
                        Some("b.stalx"),
                        ArianeRoute::Adopt,
                        at,
                        StalxAmbiguity::Ask,
                    )
                    .expect("nothing here contradicts the pick"),
                "b.stalx"
            );
        }
    }

    /// [#258] A dump nobody can date cannot be shown to match any choice, so it
    /// neither honours one nor records one. Failing closed costs a question; the
    /// alternative is trusting a name on the strength of nothing, which is the whole
    /// bug.
    #[test]
    fn an_undatable_dump_neither_recalls_nor_records() {
        let state = AppState::new().expect("state");
        let project = "77777777-7777-7777-7777-777777777777";

        state.speleodb_remember_dump_entry(project, "a.stalx", DumpAt::Unknown);
        assert_eq!(
            state.speleodb_recalled_dump_entry(project, DumpAt::Revision(TIP)),
            None,
            "a choice with no revision on it must never have been stored"
        );

        state.speleodb_remember_dump_entry(project, "a.stalx", DumpAt::Revision(TIP));
        assert_eq!(
            state.speleodb_recalled_dump_entry(project, DumpAt::Unknown),
            None,
            "a dated choice is still no answer for a dump we cannot date"
        );
    }

    /// [#258] The fast-forward verbs accept no `entryPath` and no picker is bound to
    /// them, so reporting candidates to Start editing / Update / Take remote offers a
    /// question that reaches a frontend with no way to ask it - it surfaced as a bare
    /// "more than one Stalagmight file". They get the way out named instead. The
    /// asking callers are unaffected: the candidate list IS their answer.
    #[test]
    fn only_a_caller_that_can_ask_is_handed_the_candidates() {
        let state = AppState::new().expect("state");
        let project = "88888888-8888-8888-8888-888888888888";
        let zip = make_zip(&["a.stalx", "b.stalx"]);

        let mut dump = Dump::open(&zip).expect("open");
        let refused = state.speleodb_resolve_entry_remembering(
            project,
            &mut dump,
            None,
            ArianeRoute::Adopt,
            DumpAt::Revision(TIP),
            StalxAmbiguity::Refuse,
        );
        // Folded to one assertion rather than a match arm that panics: any other
        // outcome debug-prints into `got`, which cannot contain the phrase, so the
        // wrong-variant case fails here too and says what it got.
        let got = match refused {
            Err(SpeleoDbError::Parse(msg)) => msg,
            other => format!("{other:?}"),
        };
        assert!(
            got.contains("re-open"),
            "a caller with no picker must be refused with a message naming the flow \
             that CAN ask, or this is just the dead end it replaces; got: {got}"
        );

        let mut dump = Dump::open(&zip).expect("open");
        assert!(
            matches!(
                state.speleodb_resolve_entry_remembering(
                    project,
                    &mut dump,
                    None,
                    ArianeRoute::Adopt,
                    DumpAt::Revision(TIP),
                    StalxAmbiguity::Ask,
                ),
                Err(SpeleoDbError::AmbiguousDump(_))
            ),
            "a caller that hosts the picker must still get the candidates"
        );

        // [#258 review] And the OTHER ambiguity, which slipped between the two flags:
        // the fast-forward passes `ArianeRoute::Adopt` (it CAN route a lone `.tml` to
        // adoption) with `StalxAmbiguity::Refuse` (it CANNOT ask), so an ambiguous
        // Ariane set matched neither refusing arm and shipped candidates to a verb with
        // no picker bound to it.
        let ariane = make_zip(&["one/ariane.tml", "two/ariane.tml"]);
        let mut dump = Dump::open(&ariane).expect("open");
        let refused_ariane = state.speleodb_resolve_entry_remembering(
            project,
            &mut dump,
            None,
            ArianeRoute::Adopt,
            DumpAt::Revision(TIP),
            StalxAmbiguity::Refuse,
        );
        let got = match refused_ariane {
            Err(SpeleoDbError::Parse(msg)) => msg,
            other => format!("{other:?}"),
        };
        assert!(
            got.contains("re-open"),
            "an Ariane ambiguity must be refused with directions for a caller that \
             cannot ask, not answered with a candidate list; got: {got}"
        );

        // A LONE `ariane.tml` stays a routing signal even here - the frontend does act
        // on it - so the refusal above must be the ambiguous set only.
        let sole = make_zip(&["ariane.tml"]);
        let mut dump = Dump::open(&sole).expect("open");
        assert!(
            matches!(
                state.speleodb_resolve_entry_remembering(
                    project,
                    &mut dump,
                    None,
                    ArianeRoute::Adopt,
                    DumpAt::Revision(TIP),
                    StalxAmbiguity::Refuse,
                ),
                Err(SpeleoDbError::AdoptAriane)
            ),
            "a single .tml is an adoption route, not an unanswerable question"
        );
    }

    /// [#258 review] The fast-forward must fetch the commit it dates and stamps. It
    /// downloaded plain HEAD while dating with a `tip` its caller resolved in an earlier
    /// request, and asserted in a comment that the two agreed - which is the same
    /// two-request window the pull and adopt paths were changed to close. `Update` holds
    /// no lock and `Take remote` releases before getting here, so nothing prevents a
    /// push landing inside it.
    ///
    /// Source-order, because reaching the real thing needs a server that can advance its
    /// head between two requests; the live orchestration tests are where a behavioural
    /// version belongs.
    #[test]
    fn the_fast_forward_downloads_the_commit_it_dates_and_stamps() {
        let src = prod_source();
        let start = src
            .find("fn speleodb_fast_forward")
            .expect("the fast-forward verb is present");
        let body = &src[start..];
        let body = &body[..body.find("\n    }\n").expect("fn body terminates")];

        assert!(
            body.contains("usable_tip(tip.map(str::to_owned)"),
            "the caller's tip must cross the by-hash validation boundary before it can \
             pin a download"
        );
        assert_eq!(
            body.matches("download_dump_at_hash(").count(),
            1,
            "the fast-forward must fetch BY HASH when it has a usable tip"
        );
        assert!(
            body.contains("DumpAt::from_sha(pinned.as_deref())"),
            "the choice must be dated with the sha the bytes were fetched at, not one \
             resolved by a separate request"
        );
        assert!(
            body.contains("base_commit_sha: pinned.clone()"),
            "and BASE must name that same sha, so it cannot claim a commit these bytes \
             did not come from"
        );
    }

    /// [#258 review] Adoption's best-effort head resolve must not be able to delete the
    /// user's credential. `speleodb_server_head` wraps the call in `speleodb_handle_auth`,
    /// which `forget()`s the token on a 401 - keychain entry included - and this
    /// failure is deliberately swallowed, so a spurious 401 signed the user out with no
    /// signal while the adopt went on to succeed. The pull states the rule for exactly
    /// this shape of call, and adoption itself restates it for the type flip.
    #[test]
    fn adoptions_best_effort_head_resolve_stays_off_the_auth_drop() {
        let src = prod_source();
        let start = src
            .find("fn speleodb_adopt_ariane")
            .expect("the adoption verb is present");
        let body = &src[start..];
        let body = &body[..body.find("\n    }\n").expect("fn body terminates")];

        assert_eq!(
            body.matches("speleodb_server_head(").count(),
            0,
            "the head resolve must not route through the 401 auto-drop: its failure is \
             swallowed, so the drop is invisible and takes the keychain entry with it"
        );
        assert_eq!(
            body.matches("client::get_revisions(").count(),
            1,
            "it calls the client directly instead, as the pull path does"
        );
    }

    /// The rule above is only worth anything if every landing path applies it, and
    /// "landed" is not the same set as "returned Confirmed". A source scan because
    /// reaching the real thing needs a server; the failure being guarded is someone
    /// adding - or quietly un-routing - a push arm, which is structural.
    #[test]
    fn every_landing_push_arm_invalidates_the_remembered_entry() {
        // Definition plus the three arms that conclude a revision exists AND return an
        // outcome: the 200, the 304 (our content is already there - the upload that
        // put it there is what made the recall stale, whichever attempt returns), and
        // the late-recognised `AdoptConfirmed`. A count below this means an arm stopped
        // invalidating, which silently restores the stale-recall rollback.
        assert_eq!(
            speleodb_prod_matches("speleodb_revision_landed(", &[]),
            4,
            "expected one definition plus the three landing arms that return an \
             outcome (200, 304, AdoptConfirmed)"
        );
        // BOTH adoption plans conclude a prior push landed, and counting only the ones
        // that return an outcome missed the reachable one: `AdoptThenUpload` adopts the
        // tip and CONTINUES to push on top, so it has no outcome to hand back - while
        // `AdoptConfirmed` is documented as forward-compatible only. Enumerating them
        // separately is what stops a "landing" arm being overlooked because of the
        // shape of its return.
        assert_eq!(
            speleodb_prod_matches("speleodb_note_prior_push_landed(", &[]),
            3,
            "expected one definition, the `speleodb_revision_landed` wrapper, and \
             `AdoptThenUpload` - the adoption plan that concludes a landing without \
             returning one"
        );
        // And that the invalidation itself has exactly one caller - the primitive
        // above - so concluding a landing and dropping the recall cannot drift apart.
        assert_eq!(
            speleodb_prod_matches("speleodb_forget_dump_entry(", &[]),
            2,
            "the recall must be dropped through `speleodb_note_prior_push_landed` \
             alone; a second caller means some path invalidates without concluding a \
             landing (or vice versa)"
        );
    }

    /// Invalidating is not enough on its own - it has to happen BEFORE the fallible
    /// link write each arm performs, or a disk/db failure returns while a choice we
    /// already know is stale stays standing (and the next discarding open extracts
    /// that pre-push entry and re-stamps it). Inlining the call into the arm's return
    /// expression is exactly what puts it last, so require every arm to bind it to a
    /// local instead: the binding cannot sit after the `?` and still be returned.
    #[test]
    fn no_landing_arm_defers_the_invalidation_behind_its_link_write() {
        assert_eq!(
            speleodb_prod_matches("Ok(self.speleodb_revision_landed(", &[]),
            0,
            "a landing arm is returning `speleodb_revision_landed` inline, which \
             places the invalidation AFTER its `speleodb_mutate_link(..)?`. Bind it \
             to a local before the write and return that local instead."
        );
    }

    /// [#258] The probe's answer is advisory, but the request that produces it is
    /// authenticated: `hexsha` lands in the URL path, so anything that could reshape
    /// that path is rejected before the request is built - the same guard the restore
    /// path applies. Tested on the pure helper because inside the command every
    /// rejection is indistinguishable from the "not logged in" `None`.
    #[test]
    fn the_probe_validates_both_ids_before_building_an_authenticated_url() {
        let project = "44444444-4444-4444-4444-444444444444";
        assert!(probe_inputs_valid(project, None));
        assert!(probe_inputs_valid(project, Some("abc1234")));

        for bad in [
            "../../admin",
            "abc/../../x",
            "abc1234/../../projects",
            "not-hex",
            "abc",
            "",
        ] {
            assert!(
                !probe_inputs_valid(project, Some(bad)),
                "`{bad}` must never reach the download-at-hash URL"
            );
        }
        assert!(
            !probe_inputs_valid("../../etc", Some("abc1234")),
            "a bad project id is refused on the same boundary"
        );
    }

    #[test]
    fn resolve_honours_a_pick_the_archive_actually_offers() {
        // [#258] The picker's whole contract: having chosen, the user's next attempt
        // opens THAT file rather than hitting the same refusal again.
        let zip = make_zip(&["a.stalx", "b.stalx"]);
        let mut dump = Dump::open(&zip).expect("open");
        assert_eq!(
            resolve_dump_entry(&mut dump, Some("b.stalx")).expect("honoured"),
            "b.stalx"
        );
    }

    #[test]
    fn resolve_refuses_a_pick_this_archive_does_not_offer_and_re_offers_the_real_ones() {
        // A stale pick (the dump moved on while the picker sat open) and a hostile
        // one are the same case here, and neither may reach the extract. Crucially
        // the user is re-offered what the dump holds NOW rather than being told
        // their choice was invalid - the second attempt is the useful one.
        let zip = make_zip(&["a.stalx", "b.stalx", "notes.txt"]);
        let mut dump = Dump::open(&zip).expect("open");
        for hostile in ["notes.txt", "gone.stalx", "../../etc/passwd"] {
            let offered: Vec<String> = match resolve_dump_entry(&mut dump, Some(hostile)) {
                Err(SpeleoDbError::AmbiguousDump(candidates)) => {
                    candidates.iter().map(|c| c.entry_path.clone()).collect()
                }
                _ => Vec::new(),
            };
            assert_eq!(
                offered,
                vec!["a.stalx".to_owned(), "b.stalx".to_owned()],
                "`{hostile}` must be refused and the archive's real candidates re-offered"
            );
        }
    }

    #[test]
    fn every_classify_site_goes_through_the_remembering_resolver() {
        // [#258] Structural, like the guard-order tripwire above, and for the same
        // reason: the behaviour needs an `AppState`, whose construction latches the
        // process-wide app dirs into every other test in this binary.
        //
        // What it protects: the ambiguity is normally settled when the project is
        // OPENED, which takes no lock. Restore must CONSULT that answer, not merely
        // record it - it did only the latter once, so the revert composite asked
        // again while holding the write lock and had to hand it back to do so. A new
        // classify site that reaches for the bare resolver would silently reintroduce
        // that, since the bare one still works and just forgets.
        // Family-wide, not this file: the restore site lives in `speleodb_revisions`,
        // and a scan that cannot see it is a tripwire that cannot guard it.
        assert_eq!(
            speleodb_prod_matches("resolve_dump_entry(", &[]),
            2,
            "resolve_dump_entry must have exactly one definition and one caller - the \
             remembering wrapper. A direct call skips both the recall and the record."
        );
        assert_eq!(
            speleodb_prod_matches("speleodb_resolve_entry_remembering(", &[]),
            5,
            "expected one definition plus the four classify sites (pull, fast-forward, \
             restore, and the lock-free probe); a change here means a site was added or \
             one stopped remembering"
        );
    }

    #[test]
    fn a_chosen_ariane_entry_is_never_handed_to_the_cache_replace() {
        // [#258] Every caller passes this result to `replace_cache_stalx_with`, so
        // returning a `.tml` path here wrote TML bytes into the cache `.stalx` - a
        // file that cannot be opened, written over whatever clean copy was there.
        // The choice is honoured, but by the adoption flow, which imports.
        let zip = make_zip(&["ariane.tml", "misc/ariane.tml"]);
        let mut dump = Dump::open(&zip).expect("open");
        assert!(matches!(
            resolve_dump_entry(&mut dump, Some("misc/ariane.tml")),
            Err(SpeleoDbError::AdoptAriane)
        ));
    }

    #[test]
    fn resolve_ignores_a_pick_when_the_dump_is_not_ambiguous() {
        // A chosen path must never be able to steer an open that had no question to
        // answer - otherwise the picker's arg becomes a way to extract an arbitrary
        // entry of any dump.
        let zip = make_zip(&["misc/project.stalx", "notes.txt"]);
        let mut dump = Dump::open(&zip).expect("open");
        assert_eq!(
            resolve_dump_entry(&mut dump, Some("notes.txt")).expect("resolves normally"),
            "misc/project.stalx"
        );
    }

    /// The production region of this file, split out of the test module so the
    /// source-level tripwire below cannot match its own assertions.
    fn prod_source() -> &'static str {
        include_str!("speleodb_pull.rs")
            .split("#[cfg(test)]")
            .next()
            .expect("production region precedes the test module")
    }

    #[test]
    fn the_pull_runs_the_local_guard_before_it_downloads_the_dump() {
        // The guard is purely LOCAL (it reads the cached copy's link row), but it ran
        // only inside the replace - i.e. after `download_dump` had pulled the entire
        // working tree over the wire and into memory, to be thrown away. That is a long
        // wait and a large buffered allocation spent to reach a decision that was
        // available before the first byte, and it costs more the larger the dump.
        //
        // Guarded by ORDER in the source: a behavioural version would have to latch the
        // process-wide app dirs to resolve a cache path (`app_dirs::init_for_test`),
        // which leaks into every other test in the binary. The in-replace call is
        // deliberately left in place as the backstop no call site can forget, so an
        // assertion on the outcome alone cannot distinguish the two orderings anyway.
        let src = prod_source();
        let start = src
            .find("fn speleodb_pull_project")
            .expect("the shared pull body is present");
        let body = &src[start..];
        let body = &body[..body.find("\n    }\n").expect("fn body terminates")];
        let guard = body
            .find("self.guard_local_edits(")
            .expect("the pull must run the local guard itself, not only via the replace");
        let download = body
            .find("client::download_dump(")
            .expect("the pull downloads the dump");
        assert!(
            guard < download,
            "the local un-pushed-edits guard must run BEFORE the download, not after it"
        );
    }

    #[test]
    fn classify_dump_entry_maps_each_arm() {
        assert_eq!(
            classify_dump_entry(&["misc/project.stalx".to_owned()]).expect("single stalx"),
            "misc/project.stalx"
        );
        assert!(matches!(
            classify_dump_entry(&["ariane.tml".to_owned()]),
            Err(UnopenableDump::Adopt)
        ));
        assert!(matches!(
            classify_dump_entry(&["notes.txt".to_owned()]),
            Err(UnopenableDump::Empty)
        ));
        assert_eq!(
            classify_dump_entry(&["a.stalx".to_owned(), "b.stalx".to_owned()]),
            Err(UnopenableDump::AmbiguousStalx(vec![
                "a.stalx".to_owned(),
                "b.stalx".to_owned()
            ])),
            "the ambiguity must carry BOTH paths, in order - the picker renders them"
        );
        // [#258] Two ariane.tml with no .stalx used to take the first silently.
        assert_eq!(
            classify_dump_entry(&["ariane.tml".to_owned(), "misc/ariane.tml".to_owned()]),
            Err(UnopenableDump::AmbiguousAriane(vec![
                "ariane.tml".to_owned(),
                "misc/ariane.tml".to_owned()
            ]))
        );
        // A .stalx alongside any number of .tml is NOT ambiguous: the .tml is a
        // derived render sidecar and is disregarded whenever a .stalx exists.
        assert_eq!(
            classify_dump_entry(&[
                "misc/project.stalx".to_owned(),
                "ariane.tml".to_owned(),
                "misc/ariane.tml".to_owned()
            ])
            .expect("stalx wins"),
            "misc/project.stalx"
        );
    }
}
