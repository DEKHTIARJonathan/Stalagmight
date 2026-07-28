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

use super::speleodb::{local_dto, validate_project_id};
use super::speleodb_cache::{restore_display_settings, LocalEditsPolicy};
use super::{AppState, VirtualShotMode};
use crate::speleodb::contract::{dto_for_error, Endpoint};
use crate::speleodb::dump::{self, DumpClassification};
use crate::speleodb::models::SpeleoProjectSummary;
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
        if dump::candidate_is_member(&names, chosen) {
            return Ok(chosen.to_owned());
        }
    }
    classify_dump_entry(&names).map_err(|reason| unopenable_to_error(reason, dump))
}

impl AppState {
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
        let zip = self
            .speleodb_handle_auth(
                Endpoint::DownloadDump,
                client::download_dump(&endpoint, &token, insecure_http, &project_id),
            )
            .map_err(|e| dto_for_error(Endpoint::DownloadDump, &e))?;

        // Open the dump once: list entries (to classify) and extract the chosen
        // `.stalx` from the same parsed archive.
        let mut dump = dump::Dump::open(&zip).map_err(local_dto)?;
        let entry = resolve_dump_entry(&mut dump, entry_path.as_deref()).map_err(local_dto)?;
        // [#258] Remember the resolved entry for THIS session so the fast-forward
        // verbs (Start editing / Update / Take remote), which carry no entryPath of
        // their own, do not re-raise the picker on every action.
        self.speleodb_remember_dump_entry(&project_id, &entry);

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

        // Stamp BASE = the server's TRUE HEAD (the revision-topology leaf), NOT the
        // list/get_project `latest_commit` field, which is `max(authored_date)` and
        // ties to the root creation commit (see speleodb_server_head). The dump we
        // just downloaded IS this HEAD's working tree, so BASE must match it - else
        // the first Start editing would needlessly fast-forward. Best-effort: fall
        // back to the caller-supplied SHA if the history can't be fetched (Start
        // editing then fast-forwards to reconcile).
        // Fetch the revision history DIRECTLY here (NOT via speleodb_handle_auth) so
        // a transient/spurious 401 on this best-effort BASE-stamp cannot auto-drop the
        // whole session mid-open: the dump download above already authenticated with
        // this token, and the fence simply falls back to latest_commit_sha. Start
        // editing / Done DO route revisions through the auto-drop (a dead token there
        // must force re-login). (#197 review.)
        let base_sha = match client::get_revisions(&endpoint, &token, insecure_http, &project_id) {
            Ok(history) => sync::tip_of(&history.commits)
                .map(str::to_owned)
                .or(latest_commit_sha),
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    project_id = %project_id,
                    purpose = "resolve server HEAD on pull",
                    "speleodb_open_project: could not resolve server HEAD; using list latest_commit"
                );
                latest_commit_sha
            }
        };

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
    ) -> Result<SpeleoAdoptResult, SpeleoErrorDto> {
        validate_project_id(&project_id).map_err(local_dto)?;
        let (endpoint, token) = self.speleodb_active_token().map_err(local_dto)?;
        let insecure_http = self.speleodb_insecure_http();

        // Download the dump (routed through the auth handler like the pull, so a dead
        // token forces re-login).
        let zip = self
            .speleodb_handle_auth(
                Endpoint::DownloadDump,
                client::download_dump(&endpoint, &token, insecure_http, &project_id),
            )
            .map_err(|e| dto_for_error(Endpoint::DownloadDump, &e))?;

        // Classify authoritatively. Only proceed for a genuine Ariane-only dump; if a
        // `.stalx` has since appeared (a stale `type_tag`, a TOCTOU race with another
        // writer), refuse and tell the user to reopen normally rather than clobber it.
        let mut dump = dump::Dump::open(&zip).map_err(local_dto)?;
        let tml_entry = match dump::classify(&dump.entry_paths().map_err(local_dto)?) {
            DumpClassification::AdoptAriane(tml) => tml,
            DumpClassification::Stalx(_) => {
                return Err(local_dto(SpeleoDbError::Parse(
                    "this project now has a Stalagmight file on the server; reopen it normally"
                        .to_owned(),
                )));
            }
            DumpClassification::NothingToOpen => return Err(local_dto(SpeleoDbError::EmptyDump)),
            DumpClassification::AmbiguousStalx(paths) => {
                return Err(local_dto(unopenable_to_error(
                    UnopenableDump::AmbiguousStalx(paths),
                    &mut dump,
                )));
            }
            DumpClassification::AmbiguousAriane(paths) => {
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

        // Stamp BASE = the server's TRUE HEAD (revision-topology leaf), mirroring the
        // pull (see `speleodb_open_project`): fetch revisions directly (NOT via the
        // auth handler) so a spurious 401 on this best-effort stamp can't auto-drop the
        // session mid-adopt; fall back to the caller-supplied SHA on failure.
        let base_sha = match client::get_revisions(&endpoint, &token, insecure_http, &project_id) {
            Ok(history) => sync::tip_of(&history.commits)
                .map(str::to_owned)
                .or(latest_commit_sha),
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    project_id = %project_id,
                    purpose = "resolve server HEAD on adopt",
                    "speleodb_adopt_ariane: could not resolve server HEAD; using list latest_commit"
                );
                latest_commit_sha
            }
        };

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
        let zip = self.speleodb_handle_auth(
            Endpoint::DownloadDump,
            client::download_dump(endpoint, token, insecure_http, project_id),
        )?;
        let mut dump = dump::Dump::open(&zip)?;
        // [#258] No `entryPath` reaches this verb, so honour a choice the user
        // already made this session; a miss still fails closed rather than guessing.
        let recalled = self.speleodb_recalled_dump_entry(project_id);
        let entry = resolve_dump_entry(&mut dump, recalled.as_deref())?;
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
                    base_commit_sha: tip.map(str::to_owned),
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
    use super::{classify_dump_entry, resolve_dump_entry, UnopenableDump};
    use crate::speleodb::dump::Dump;
    use crate::speleodb::SpeleoDbError;

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
