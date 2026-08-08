//! Project exporters (CSV, JSON, Ariane TML, SVG/PNG/PDF map images, dive
//! profiles) extracted from the root crate. The root re-exports [`export`]
//! under its old `crate::export` path, so dependents keep compiling unchanged.

pub mod export;

/// The moved tree reaches the shared data model through `crate::models::*`
/// exactly as it did in the root crate; alias the models member under the same
/// name so those paths keep resolving.
pub use stalagmight_models as models;

/// Same deal for `crate::parsers::*` (dive_profile's `FEET_TO_METERS` and the
/// tml round-trip tests): re-export the parsers member's module under the old
/// name.
pub use stalagmight_parsers::parsers;
