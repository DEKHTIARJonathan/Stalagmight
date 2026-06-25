//! Gas & route-planning engine (issue #38).
//!
//! Phase 0 (this commit) ships the pure foundations: [`physics`] (`ata` / `gas_rate` /
//! `edge_gas` / SAC→RMV) and the [`model`] (divers, cylinders, teams), golden-tested in
//! [`tests`]. The graph-coupled engine — a gas-weighted Dijkstra over the survey graph —
//! lands in Phase 1 as `impl Project` methods *here*, reaching the `pub(super)` graph
//! primitives (`build_survey_graph` / `dijkstra` / `zero_datum_roots`) exactly as the
//! sibling `distance` module already does.

mod model;
mod physics;

#[cfg(test)]
mod tests;
