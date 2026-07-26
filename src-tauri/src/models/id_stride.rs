// Shared stride for encoding section-scoped IDs into globally unique IDs.
// Keep in sync with the frontend FEATURE_ID_STRIDE.
pub const FEATURE_ID_STRIDE: u32 = 100_000;

/// Largest section id whose whole shot-id band survives every representation the
/// id passes through.
///
/// A section's shot ids run `[id * FEATURE_ID_STRIDE, (id + 1) * FEATURE_ID_STRIDE)`
/// (see `Section::new`). Two ceilings apply, and the tighter one wins:
///
/// - **`u32`** (backend): past `u32::MAX` the multiply wraps and two sections
///   silently share a band. Shot ids are immutable FKs for merges, closures and
///   comments, so that is data corruption, not a display glitch.
/// - **`i32`** (frontend): the binary loader stores shot ids in an `Int32Array`
///   and applies `| 0` (`src/utils/loadProjectBinary.ts`), and `SurveyData.shotIds`
///   is `Int32Array`. A band above `i32::MAX` reads back NEGATIVE in the UI, so
///   selections and edit commands stop matching the backend's `u32` ids.
///
/// `i32::MAX` is the binding constraint, so the bound is derived from it. Section
/// ids come off disk unvalidated (`persistence::sqlite::read`), so this is an
/// untrusted-input bound as well as an internal one.
pub const MAX_SECTION_ID: u32 = (i32::MAX as u32 / FEATURE_ID_STRIDE) - 1;
