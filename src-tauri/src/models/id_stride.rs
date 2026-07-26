// Shared stride for encoding section-scoped IDs into globally unique IDs.
// Keep in sync with the frontend FEATURE_ID_STRIDE.
pub const FEATURE_ID_STRIDE: u32 = 100_000;

/// Largest section id whose whole shot-id band fits in a `u32`.
///
/// A section's shot ids run `[id * FEATURE_ID_STRIDE, (id + 1) * FEATURE_ID_STRIDE)`
/// (see `Section::new`), so the band's last id must not exceed `u32::MAX`. Beyond
/// this the multiply wraps, and two sections silently share a shot-id band - shot
/// ids are immutable FKs for merges, closures and comments, so that is data
/// corruption, not a display glitch. Section ids come off disk unvalidated
/// (`persistence::sqlite::read`), so this is an untrusted-input bound.
pub const MAX_SECTION_ID: u32 = (u32::MAX / FEATURE_ID_STRIDE) - 1;
