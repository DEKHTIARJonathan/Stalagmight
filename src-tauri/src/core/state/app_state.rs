use anyhow::Result;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex};
use tauri::AppHandle;

use crate::cache::TileCache;
use crate::config::{ClosureAdjustmentConfig, Config, GasConfig};
use crate::models::{
    AlongLineResult, Cylinder, DistanceField, Diver, GasReachField, Project, RulerEndpoint,
    Station, StationAnchor, StationRef,
};
use crate::persistence::Database;
use crate::tilemap_cache::TilemapCache;
use crate::TileFetchStats;

use crate::core::{CommandResult, UndoStack};

/// Trait for types that can represent project lock errors.
/// Enables `with_project_mut` and `with_project` to work with different return types.
pub(super) trait FromProjectLockError {
    fn lock_failed() -> Self;
    fn no_project() -> Self;
}

impl FromProjectLockError for CommandResult {
    fn lock_failed() -> Self {
        CommandResult::failure("Failed to lock project".to_string())
    }
    fn no_project() -> Self {
        CommandResult::failure("No project open".to_string())
    }
}

impl<T> FromProjectLockError for Result<T, String> {
    fn lock_failed() -> Self {
        Err("Failed to lock project".to_string())
    }
    fn no_project() -> Self {
        Err("No project open".to_string())
    }
}

/// Transient, never-persisted cache of the closure-adjusted station coordinates
/// for the current project. Keyed on the project's `modified_at` (nanoseconds)
/// plus a hash of the closure-adjustment config, and cleared on every
/// command/undo/redo so the adjusted display view always re-derives from
/// current measured data.
pub(super) struct AdjustedStationsCache {
    pub(super) version: i64,
    pub(super) config_hash: u64,
    pub(super) stations: Vec<Station>,
}

/// Hash the closure-adjustment config fields that affect the solve, for the
/// adjusted-stations cache key. Shared by `get_adjusted_stations` and
/// `distance_field` so both derive the same key.
fn adjusted_config_hash(ca: &ClosureAdjustmentConfig) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    ca.base_sigma_length_m.to_bits().hash(&mut h);
    ca.base_sigma_azimuth_deg.to_bits().hash(&mut h);
    ca.base_sigma_depth_m.to_bits().hash(&mut h);
    h.finish()
}

/// Application state managed by Tauri
pub struct AppState {
    /// Current project (if any)
    pub(super) project: Mutex<Option<Project>>,
    /// Database connection (if project is open)
    pub(super) database: Mutex<Option<Database>>,
    /// True while the open project's initial save is still deferred — created with
    /// no save path and never written to disk, so it has no `.stalx` and no Recent
    /// Projects entry yet. Tracked explicitly rather than inferred from
    /// `database.is_none()` (ambiguous for dropped handles) or file existence
    /// (ambiguous for reserved-path collisions), so the first import can durably
    /// persist it exactly once (#92 / PR #104).
    pub(super) initial_save_deferred: AtomicBool,
    /// Undo/redo stack
    pub(super) undo_stack: Mutex<UndoStack>,
    /// Application configuration
    pub(super) config: Mutex<Config>,
    /// Recent projects list
    pub(super) recent_projects: Mutex<Vec<PathBuf>>,
    /// SpeleoDB per-session connection state (endpoint, email, token store).
    /// Read-only spike (#183); the token never crosses into the webview.
    pub(super) speleodb: Mutex<super::speleodb::SpeleoDbSession>,
    /// Whether the open project may be edited. TRANSIENT, never persisted,
    /// DEFAULT-TRUE; `false` ONLY for a remote SpeleoDB project opened without a
    /// write lock (#191). Reset to `true` on every open/close so a previously
    /// read-only project can't leave the flag stuck. The mutation chokepoint
    /// (`guard_mutation`) reads it.
    pub(super) edit_enabled: AtomicBool,
    /// In-memory display settings cache (used when no DB is open, e.g., new unsaved project)
    pub(super) display_settings_cache: Mutex<HashMap<String, String>>,
    /// Serialization lock for command execution.
    /// Held for the entire duration of execute(), undo(), and redo() to prevent
    /// concurrent commands from interleaving (especially with batch sub-commands).
    pub(super) command_lock: Mutex<()>,
    /// Tile cache for offline satellite imagery.
    ///
    /// Note: Uses Arc<Mutex<...>> rather than plain Mutex<...> because the protocol handler
    /// runs in a separate async task/thread that outlives the closure scope, requiring
    /// owned/cloneable access to the cache. This is a deliberate deviation from the spec
    /// for thread-safety requirements.
    ///
    /// Note: Changes to CacheConfig at runtime (via update_config) do NOT re-initialize
    /// this cache. Users must restart the app for cache config changes to take effect.
    pub(super) tile_cache: Arc<Mutex<Option<TileCache>>>,
    /// In-memory cache for ArcGIS tilemap API responses.
    /// Used to efficiently check tile availability before fetching.
    pub(super) tilemap_cache: Arc<Mutex<TilemapCache>>,
    /// Lock-free tile fetch statistics (in-flight count, latency, errors).
    /// Uses Arc because the protocol handler needs a cloneable reference.
    pub(super) tile_fetch_stats: Arc<TileFetchStats>,
    /// Tauri app handle for emitting events (set during app setup)
    pub(super) app_handle: Mutex<Option<AppHandle>>,
    /// Active loading cancellation token (if any load operation is in progress)
    pub(super) active_loading: Mutex<Option<Arc<AtomicBool>>>,
    /// Memoized closure-adjusted station coordinates for the display-mode toggle.
    /// See [`AdjustedStationsCache`]. Transient; never persisted.
    pub(super) adjusted_cache: Mutex<Option<AdjustedStationsCache>>,
    /// Bumped on every adjusted-cache invalidation. Captured before the lock-free
    /// solve so a result computed against a since-invalidated project is not
    /// written back (covers mutations that don't bump `modified_at`, e.g. repair).
    pub(super) adjusted_cache_generation: AtomicU64,
}

impl AppState {
    /// Create a new application state
    pub fn new() -> Result<Self> {
        let config = Config::load().unwrap_or_default();
        // Load recent projects from config
        let recent = config.general.recent_projects.clone();
        let undo_limit = config.general.undo_history_limit;

        // Initialize tile cache if enabled
        let tile_cache = if config.cache.tile_cache_enabled {
            match Self::init_tile_cache(&config) {
                Ok(cache) => Some(cache),
                Err(e) => {
                    tracing::warn!(
                        error = %e,
                        purpose = "enable offline tiles at startup",
                        "Failed to initialize tile cache; offline tile access will be unavailable"
                    );
                    None
                }
            }
        } else {
            tracing::info!(
                purpose = "respect user cache settings",
                "Tile cache disabled in configuration"
            );
            None
        };

        Ok(Self {
            project: Mutex::new(None),
            database: Mutex::new(None),
            initial_save_deferred: AtomicBool::new(false),
            undo_stack: Mutex::new(UndoStack::new_with_limit(undo_limit)),
            config: Mutex::new(config),
            recent_projects: Mutex::new(recent),
            speleodb: Mutex::new(super::speleodb::SpeleoDbSession::default()),
            // Default-true: editing is enabled unless a remote project is opened
            // read-only (#191). Reset on open/close.
            edit_enabled: AtomicBool::new(true),
            display_settings_cache: Mutex::new(HashMap::new()),
            command_lock: Mutex::new(()),
            tile_cache: Arc::new(Mutex::new(tile_cache)),
            tilemap_cache: Arc::new(Mutex::new(TilemapCache::new())),
            tile_fetch_stats: Arc::new(TileFetchStats::new()),
            app_handle: Mutex::new(None),
            active_loading: Mutex::new(None),
            adjusted_cache: Mutex::new(None),
            adjusted_cache_generation: AtomicU64::new(0),
        })
    }

    /// Initialize the tile cache based on config
    pub(super) fn init_tile_cache(config: &Config) -> Result<TileCache> {
        let cache_dir = crate::app_dirs::cache_dir()
            .ok_or_else(|| anyhow::anyhow!("Could not determine app cache directory"))?;
        TileCache::open(
            cache_dir,
            config.cache.tile_cache_max_mb,
            config.cache.tile_ttl_days,
        )
    }

    /// Get a clone of the tile cache Arc for sharing across threads
    pub fn tile_cache(&self) -> Arc<Mutex<Option<TileCache>>> {
        Arc::clone(&self.tile_cache)
    }

    /// Get a clone of the tilemap cache Arc for sharing across threads
    pub fn tilemap_cache(&self) -> Arc<Mutex<TilemapCache>> {
        Arc::clone(&self.tilemap_cache)
    }

    /// Get a clone of the tile fetch stats Arc for sharing across threads
    pub fn tile_fetch_stats(&self) -> Arc<TileFetchStats> {
        Arc::clone(&self.tile_fetch_stats)
    }

    /// Set the app handle (called during app setup)
    pub fn set_app_handle(&self, handle: AppHandle) {
        if let Ok(mut h) = self.app_handle.lock() {
            *h = Some(handle);
        }
    }

    /// Get the app handle
    pub fn get_app_handle(&self) -> Option<AppHandle> {
        self.app_handle.lock().ok().and_then(|h| h.clone())
    }

    /// Start a new loading operation, cancelling any existing one.
    /// Returns the cancellation token for the new operation.
    pub fn start_new_load(&self) -> Arc<AtomicBool> {
        let mut guard = self
            .active_loading
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);

        // Cancel any existing load
        if let Some(old_token) = guard.take() {
            old_token.store(true, std::sync::atomic::Ordering::SeqCst);
        }

        // Create new token
        let token = Arc::new(AtomicBool::new(false));
        *guard = Some(Arc::clone(&token));
        token
    }

    /// Clear the active loading token (called when load completes or fails).
    /// Identity-safe: only clears if the provided token matches the current active token.
    /// This prevents a stale load from clearing a newer load's token.
    pub fn clear_active_load(&self, expected_token: &Arc<AtomicBool>) {
        if let Ok(mut guard) = self.active_loading.lock() {
            if let Some(ref current) = *guard {
                if Arc::ptr_eq(current, expected_token) {
                    *guard = None;
                }
            }
        }
    }

    // === Read-only edit gate + dirty bit (#191) ===

    /// Whether the open project may currently be edited (transient; #191).
    pub(super) fn edit_enabled(&self) -> bool {
        self.edit_enabled.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Set the transient edit-enabled flag. `false` only for a remote SpeleoDB
    /// project opened without a write lock; reset to `true` on every open/close.
    pub(crate) fn set_edit_enabled(&self, v: bool) {
        self.edit_enabled
            .store(v, std::sync::atomic::Ordering::Relaxed);
    }

    /// THE mutation chokepoint (#191, D-B6). Every SURVEY-CONTENT mutation entry
    /// (`execute` + all its `execute_*` siblings, `undo`/`redo`/`undo_to`/`redo_to`,
    /// the collab toggles, `set_project_name_for_path`) calls this FIRST, after
    /// taking `command_lock` and before mutating. `Err` aborts the mutation when
    /// the open project is a remote SpeleoDB project opened read-only. No-op (`Ok`)
    /// for local-only (default-true `edit_enabled`) projects and non-mutating reads.
    ///
    /// Non-survey project-DB writes are handled deliberately (the exemption the
    /// push/release flow #197 had to revisit):
    /// - `resolve_warning`/`unresolve_warning` ARE gated as of #197 (via
    ///   `save_resolved_warning_gated`/`delete_resolved_warning_gated`): a resolved
    ///   warning PROLIFERATES to the server (it is NOT stripped from the push
    ///   snapshot), so it is a real remote-dirtying edit — gate it AND
    ///   `mark_remote_dirty` so a read-only project rejects it and an edit-session
    ///   resolve is pushed by `Done` rather than silently dropped on the next pull.
    /// - `save_display_setting` (view prefs) stays UNGATED and that is correct:
    ///   `display_settings` is stripped from the push snapshot and re-applied locally
    ///   across pull/FF — purely local view state that never proliferates, never lost.
    /// - `track_imported_file`/`track_section_hashes` import-dedup bookkeeping stays
    ///   UNGATED for now: the in-import path gates + dirties, but the standalone
    ///   `track_imported_file` command does not — a deferred follow-up, lower-impact
    ///   than a lost annotation (re-import is the worst case, not silent data loss).
    ///
    /// `MUTATION_ENTRYPOINTS` (tests.rs) enumerates the gated set (incl. the two
    /// warning verbs).
    pub(super) fn guard_mutation(&self, what: &str) -> Result<(), CommandResult> {
        if self.edit_enabled() {
            return Ok(());
        }
        Err(CommandResult::failure(format!(
            "{}: {what} is disabled: this SpeleoDB project is open read-only. \
             Acquire the lock to edit.",
            crate::core::command::EDIT_DISABLED_CODE
        )))
    }

    /// Flip `has_unpushed_edits` `false → true` AND refresh `last_edit_at` on a
    /// successful edit of a remote project (#191, D-B16; v10 last_edit_at). No-op
    /// for local-only (`load_speleo_link → None`). The dirty bit is SET-ONLY in
    /// #191 — local save/autosave NEVER clears it; only a successful server push
    /// (Sync/Release) does. `last_edit_at` is refreshed on EVERY accepted
    /// mutation (not idempotent) because guardrail-7 compares it to push-start to
    /// decide whether a landed-by-ancestry push may clear the dirty bit.
    pub(super) fn mark_remote_dirty(&self) {
        let Ok(db_guard) = self.database.lock() else {
            return;
        };
        let Some(db) = db_guard.as_ref() else {
            return; // no open database (e.g. unsaved project) — nothing to stamp
        };
        // One targeted UPDATE: set the dirty bit + refresh last_edit_at (the g7
        // push-start comparison needs the LATEST edit time, so this runs every edit,
        // not idempotently). A local-only project has no link row → 0 rows → no-op,
        // so this stays cheap on the hot edit path (no SELECT, no DDL, no full upsert).
        let now = chrono::Utc::now().to_rfc3339();
        if let Err(e) = db.touch_speleo_link_dirty(&now) {
            tracing::warn!(
                error = %e,
                purpose = "flip SpeleoDB dirty bit after a remote edit",
                "mark_remote_dirty: failed to persist has_unpushed_edits"
            );
        }
    }

    /// Cancel any active loading operation (idempotent - safe to call anytime)
    pub fn cancel_loading(&self) {
        if let Ok(guard) = self.active_loading.lock() {
            if let Some(token) = guard.as_ref() {
                token.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }
        // No error if no active load - cancel_loading is idempotent
    }

    /// Lock the project mutex and pass a mutable reference to the callback.
    /// Returns the callback's result, or an error if the lock fails or no project is open.
    pub(super) fn with_project_mut<F, R>(&self, f: F) -> R
    where
        F: FnOnce(&mut Project) -> R,
        R: FromProjectLockError,
    {
        let Ok(mut guard) = self.project.lock() else {
            return R::lock_failed();
        };
        let Some(project) = guard.as_mut() else {
            return R::no_project();
        };
        f(project)
    }

    /// Lock the project mutex and pass an immutable reference to the callback.
    /// Returns the callback's result, or an error if the lock fails or no project is open.
    pub(super) fn with_project<F, R>(&self, f: F) -> R
    where
        F: FnOnce(&Project) -> R,
        R: FromProjectLockError,
    {
        let Ok(guard) = self.project.lock() else {
            return R::lock_failed();
        };
        let Some(project) = guard.as_ref() else {
            return R::no_project();
        };
        f(project)
    }

    // === Closure-adjusted geometry (non-destructive derived view) ===

    /// Compute (or return cached) closure-adjusted station coordinates for the
    /// current project. Non-destructive: the measured project is never mutated —
    /// the adjustment runs on the project clone this method already takes (see
    /// [`Project::into_adjusted_station_coordinates`]) and only the resulting
    /// coordinates are returned.
    ///
    /// The result is memoized in a transient cache keyed on the project's
    /// `modified_at` + closure-adjustment config and cleared on every
    /// command/undo/redo, so repeatedly toggling to the adjusted display view is
    /// cheap while any edit forces a fresh re-solve from intact measured data.
    /// Returns `None` if no project is open.
    pub fn get_adjusted_stations(&self) -> Option<Vec<Station>> {
        let config = self.get_config();
        let config_hash = adjusted_config_hash(&config.closure_adjustment);

        // Cheap project-version read under a short lock.
        let version = {
            let guard = self.project.lock().ok()?;
            guard
                .as_ref()?
                .modified_at
                .timestamp_nanos_opt()
                .unwrap_or(0)
        };

        if let Ok(cache) = self.adjusted_cache.lock() {
            if let Some(entry) = cache.as_ref() {
                if entry.version == version && entry.config_hash == config_hash {
                    return Some(entry.stations.clone());
                }
            }
        }

        // Miss: clone the project out, then solve without holding any lock (the
        // solve is CPU-heavy and runs on a blocking thread). The clone is taken
        // under `command_lock` so it is serialized with `execute()`/undo/redo:
        // those hold `command_lock` across both the mutation *and* the
        // `reconcile_geometry()` epilogue, which repairs derived offsets without
        // bumping `modified_at`. Cloning outside that lock could capture a project
        // after the mutation but before reconcile and then cache that partially
        // reconciled solve under the final version. Re-read the version from the
        // clone so the cache key matches exactly the data solved, and hand the
        // clone to the by-value solver so it isn't cloned a second time.
        let (project, generation) = {
            let _cmd_guard = self.command_lock.lock().ok()?;
            // Capture the invalidation generation alongside the (reconciled) clone,
            // under command_lock, so it reflects exactly the data being solved.
            let generation = self
                .adjusted_cache_generation
                .load(std::sync::atomic::Ordering::SeqCst);
            (self.get_project_state()?, generation)
        };
        let solved_version = project.modified_at.timestamp_nanos_opt().unwrap_or(0);
        let stations = project.into_adjusted_station_coordinates(&config.closure_adjustment);

        if let Ok(mut cache) = self.adjusted_cache.lock() {
            // Only store if nothing invalidated the cache while command_lock was
            // released for the heavy, lock-free solve. Otherwise an edit/open/repair
            // that ran during the solve — including a repair that doesn't bump
            // modified_at — could be clobbered by this now-stale result.
            if self
                .adjusted_cache_generation
                .load(std::sync::atomic::Ordering::SeqCst)
                == generation
            {
                *cache = Some(AdjustedStationsCache {
                    version: solved_version,
                    config_hash,
                    stations: stations.clone(),
                });
            }
        }
        Some(stations)
    }

    /// Per-station distance field for the distance-gradient overlay (#34),
    /// computed on the closure-adjusted geometry. Takes ONE reconciled project
    /// snapshot under `command_lock` (so the graph topology and the adjusted
    /// coordinates come from the same version — no read-skew between two separate
    /// state reads), and reuses the memoized adjusted-stations cache read-only
    /// when it matches that snapshot (keeps re-root instant in the adjusted view).
    pub fn distance_field(&self, from: Option<&StationRef>) -> Option<DistanceField> {
        let project = self.get_project_state()?;
        // Distance uses MEASURED geometry (surveyed shot lengths via the plain
        // coordinate walk) — instant. The closure-adjusted solve is intentionally
        // NOT used: it dominated the latency (~2s release / ~40s debug on a 6k-
        // station survey; ~O(n^2)) for a sub-meter difference, and reachability is
        // identical either way (it's topological — shots/merges/closures — not
        // coordinate-dependent). Closure-solve perf is tracked separately (#81).
        let stations = project.compute_station_coordinates();
        Some(project.distance_field_from(&stations, from))
    }

    /// Single-diver open-circuit gas reachability field (#38). Like [`distance_field`], the
    /// engine consumes the instant MEASURED geometry (reachability is coordinate-independent —
    /// never the slow closure-adjusted solve). `None` when no project is open. The diver /
    /// cylinders are assumed already validated and `gas_config` normalized by the command.
    pub fn gas_reach_field(
        &self,
        origin: Option<&StationRef>,
        endpoint: Option<&StationRef>,
        diver: &Diver,
        cylinders: &[Cylinder],
        gas_config: &GasConfig,
    ) -> Option<GasReachField> {
        let project = self.get_project_state()?;
        Some(project.compute_gas_reach_field(origin, endpoint, diver, cylinders, gas_config))
    }

    /// Shortest along-cave-line distance + traversed shots between two ruler
    /// endpoints (#26). The distance sums the CLOSURE-ADJUSTED shot lengths, so it
    /// uses the memoized adjusted-stations cache (`get_adjusted_stations`): warm
    /// while the adjusted view is in use, and on a cold cache it pays one closure
    /// solve (then repeat measurements are instant). Falls back to measured
    /// coordinates only if the adjusted solve is unavailable — without loop
    /// closures the two coincide anyway.
    pub fn along_line_between(
        &self,
        a: RulerEndpoint,
        b: RulerEndpoint,
    ) -> Option<AlongLineResult> {
        let project = self.get_project_state()?;
        // `project` (topology) and `stations` (adjusted coords) are two independent
        // locked reads, so a concurrent edit between them could yield a slightly
        // skewed snapshot. That's safe here — `along_line_between` looks everything
        // up by `StationRef` through guarded `idx.get(..)` and indexes coords only
        // via those resolved indices, so a mismatch drops an edge at worst (never
        // panics) and the ruler re-queries. We deliberately avoid a single
        // command-locked snapshot to keep reusing the adjusted-stations cache.
        let stations = self
            .get_adjusted_stations()
            .unwrap_or_else(|| project.compute_station_coordinates());
        Some(project.along_line_between(&stations, a, b))
    }

    /// Drop any cached closure-adjusted coordinates. Called from every
    /// command/undo/redo path so the adjusted view never serves stale geometry.
    pub(super) fn invalidate_adjusted_cache(&self) {
        if let Ok(mut cache) = self.adjusted_cache.lock() {
            // Bump the generation under the cache lock so an in-flight solve's
            // generation check (also under this lock) reliably observes it.
            self.adjusted_cache_generation
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            *cache = None;
        }
    }

    // === Snapshot helpers for snapshot-based undo ===

    /// Capture a JSON snapshot of the current project for undo.
    /// Returns the serialized JSON, or a `CommandResult` failure if unavailable.
    pub(super) fn capture_project_snapshot(&self) -> Result<String, CommandResult> {
        let Ok(guard) = self.project.lock() else {
            return Err(CommandResult::failure("Failed to lock project".to_string()));
        };
        let Some(p) = guard.as_ref() else {
            return Err(CommandResult::failure("No project open".to_string()));
        };
        serde_json::to_string(p)
            .map_err(|e| CommandResult::failure(format!("Failed to serialize project: {e}")))
    }

    /// Deserialize a project snapshot and install it into `slot`, rebuilding the
    /// transient lookup caches (`section_index_cache`, `merge_adjacency_cache`)
    /// that serde skips. THE single place a restored project enters the live slot:
    /// every rollback/undo/redo path routes through here so none can forget to
    /// rebuild a cache and leave a half-populated / stale map behind (which would
    /// silently mis-resolve sections or merge groups) — see catalog #14/#39.
    /// Returns false and leaves `slot` untouched if the snapshot can't be parsed.
    #[must_use]
    pub(super) fn restore_snapshot_into(slot: &mut Option<Project>, snapshot: &str) -> bool {
        // A snapshot persisted by a build predating the per-project `validation`
        // field (#57) has no "validation" key, so serde (the field is
        // #[serde(default)]) fills ValidationConfig::default() — silently changing
        // the project's thresholds and its warnings when an undo/redo of a legacy
        // persisted entry is restored. Detect that legacy blob and carry the CURRENT
        // project's validation across instead. Undo of a real settings change always
        // serializes the key, so it still restores the intended thresholds (Codex).
        let snapshot_has_validation = snapshot.contains("\"validation\":");
        let current_validation = slot.as_ref().map(|p| p.validation.clone());
        match serde_json::from_str::<Project>(snapshot) {
            Ok(mut restored) => {
                if !snapshot_has_validation {
                    if let Some(validation) = current_validation {
                        restored.validation = validation;
                    }
                }
                restored.rebuild_section_index();
                restored.rebuild_merge_adjacency();
                restored.rebuild_shot_uuid_index();
                // A snapshot blob persisted by a PRE-ANCHOR build can carry
                // transitional positional `Index` cross-reference anchors (undo/redo
                // history is persisted to SQLite and reloaded across sessions, and the
                // back-compat StationKey deserializer accepts the legacy
                // `{section_id, station_index}` shape). The live-model invariant is
                // "no Index anchors": a later shot insert/delete only shifts
                // AfterShot/SectionStart refs, so a live Index ref would silently start
                // resolving to the wrong station. Canonicalize such a snapshot — the
                // same step the load path runs — to AfterShot/SectionStart.
                //
                // CRITICALLY, gate this on the snapshot actually being LEGACY (an Index
                // anchor is present). A CURRENT same-session snapshot is already
                // canonical, so mint/reanchor would be no-ops — but ensure_unique would
                // RE-MINT intentional duplicate UUIDs, e.g. the pre-repair state that an
                // undo of a duplicate_shot_uuid Repair must restore EXACTLY. Skipping
                // the block when there is no Index anchor keeps current snapshots
                // byte-for-byte (so undo/redo is a true before/after pair) while legacy
                // snapshots are still fully canonicalized. (For a legacy snapshot,
                // ensure_shot_uuids runs FIRST: a pre-v6 blob can have uuid:null shots,
                // and ensure_unique only dedups existing UUIDs — without minting nulls,
                // reanchor can't canonicalize the Index anchor of a null-uuid station.)
                let has_legacy_index = {
                    let mut found = false;
                    restored.for_each_station_ref(|_, key| {
                        if matches!(key.anchor, StationAnchor::Index(_)) {
                            found = true;
                        }
                    });
                    found
                };
                if has_legacy_index {
                    restored.ensure_shot_uuids();
                    restored.ensure_unique_shot_uuids();
                    restored.reanchor_station_refs();
                }
                *slot = Some(restored);
                true
            }
            Err(e) => {
                tracing::error!(
                    purpose = "restore project snapshot",
                    reason = %e,
                    "Failed to deserialize project snapshot; slot left unchanged"
                );
                false
            }
        }
    }

    /// Rollback the project to a previously captured snapshot.
    /// Handles poisoned mutex gracefully (recovery is more important than panic).
    pub(super) fn rollback_project(&self, snapshot: &str) {
        let mut proj = match self.project.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        if Self::restore_snapshot_into(&mut proj, snapshot) {
            tracing::info!(
                purpose = "restore project after failed command",
                "Successfully rolled back to pre-mutation snapshot"
            );
        }
    }

    /// Capture an "after" snapshot of the project, rolling back on failure.
    /// Returns the serialized JSON, or rolls back and returns a `CommandResult` failure.
    pub(super) fn capture_after_snapshot_or_rollback(
        &self,
        before_snapshot: &str,
    ) -> Result<String, CommandResult> {
        let mut proj_guard = match self.project.lock() {
            Ok(g) => g,
            Err(poisoned) => {
                tracing::warn!(
                    purpose = "finalize undo snapshot",
                    "Project mutex poisoned during after-snapshot; recovering"
                );
                poisoned.into_inner()
            }
        };
        let Some(p) = proj_guard.as_ref() else {
            tracing::error!(
                purpose = "restore project after mutation error",
                "Project became None after mutation; rolling back"
            );
            let _ = Self::restore_snapshot_into(&mut proj_guard, before_snapshot);
            return Err(CommandResult::failure(
                "No project for after snapshot".to_string(),
            ));
        };
        match serde_json::to_string(p) {
            Ok(json) => Ok(json),
            Err(e) => {
                tracing::error!(
                    purpose = "finalize undo snapshot",
                    reason = %e,
                    "Failed to serialize after snapshot; rolling back"
                );
                if Self::restore_snapshot_into(&mut proj_guard, before_snapshot) {
                    tracing::info!(
                        purpose = "restore project after snapshot failure",
                        "Successfully rolled back after serialization failure"
                    );
                }
                Err(CommandResult::failure(format!(
                    "Failed to serialize after snapshot: {e}"
                )))
            }
        }
    }

    /// Push a snapshot-pair undo entry onto the undo stack.
    pub(super) fn push_snapshot_undo(
        &self,
        cmd: crate::core::Command,
        before: String,
        after: String,
    ) {
        if let Ok(mut undo_stack) = self.undo_stack.lock() {
            undo_stack.push_with_data(
                cmd,
                crate::core::UndoData::ProjectSnapshotPair { before, after },
            );
        }
    }
}
