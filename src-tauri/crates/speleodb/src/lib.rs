//! SpeleoDB integration (HTTP client, token storage, sync engine, dump
//! handling, per-endpoint metrics) extracted from the root crate. The root
//! re-exports [`speleodb`] under its old `crate::speleodb` path, so dependents
//! keep compiling unchanged.

pub mod speleodb;

/// The moved tree reaches the shared data model through `crate::models::*`
/// exactly as it did in the root crate; alias the models member under the same
/// name so those paths keep resolving.
pub use stalagmight_models as models;

// auth.rs resolves its `crate::app_dirs::*` path through this alias, exactly
// as it did in the root crate (which re-exports the same module from
// `stalagmight-models`).
pub use stalagmight_models::app_dirs;

/// Same deal for `crate::telemetry::*` (metrics.rs): re-export the telemetry
/// member's module under the old name.
pub use stalagmight_telemetry::telemetry;
