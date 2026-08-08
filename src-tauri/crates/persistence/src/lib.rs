//! Project persistence (sqlite `.stalx` files, plnx import, undo history
//! limits) plus the tile caches, extracted from the root crate. The root
//! re-exports [`persistence`], [`cache`] and [`tilemap_cache`] under their old
//! `crate::…` paths, so dependents keep compiling unchanged.

pub mod cache;
pub mod persistence;
pub mod tilemap_cache;

/// The moved trees reach the shared data model through `crate::models::*`
/// exactly as they did in the root crate; alias the models member under the
/// same name so those paths keep resolving.
pub use stalagmight_models as models;
