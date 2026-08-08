//! Telemetry + logging, extracted from the root crate as the
//! `stalagmight-telemetry` workspace member. The module layout is preserved
//! (`telemetry`, `logging`) so the root crate can re-export both under their
//! old paths and every `crate::telemetry::*` / `crate::logging::*` caller
//! keeps compiling unchanged.

pub mod logging;
pub mod telemetry;

// The moved modules resolve their `crate::app_dirs::*` paths through this
// alias, exactly as they did in the root crate (which re-exports the same
// module from `stalagmight-models`).
pub use stalagmight_models::app_dirs;
