mod app_state;
mod collab;
mod commands;
mod config;
mod display_settings;
mod import_tracking;
mod project_io;
mod recent_projects;
mod undo;
mod warnings;

#[cfg(test)]
#[expect(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::float_cmp)]
mod tests;
#[cfg(test)]
mod tests_support;

pub use app_state::AppState;
#[cfg(test)]
pub(crate) use collab::apply_changeset;
