mod app_state;
mod commands;
mod config;
mod display_settings;
mod import_tracking;
mod project_io;
mod recent_projects;
mod undo;
mod warnings;

#[cfg(test)]
#[expect(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests;
#[cfg(test)]
mod tests_support;

pub use app_state::AppState;
