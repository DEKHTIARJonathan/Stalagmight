use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::config::PlacementSuggestionConfig;

use super::{SectionId, Shot, ShotData};

/// Direction of match between import and existing shots.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum MatchDirection {
    /// Import shots match existing shots in the same order.
    Forward,
    /// Import shots retrace existing shots backwards.
    Reverse,
}

/// Confidence tier for a placement suggestion.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum SuggestionConfidence {
    High,
    Medium,
    Low,
}

/// A suggested placement for an import section based on reference shot overlap.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PlacementSuggestion {
    /// The existing section that the import overlaps with.
    pub existing_section_id: SectionId,
    /// Station index in the existing section to merge with.
    pub existing_station_index: usize,
    /// Station index in the import section (0 = first, N = last).
    pub import_station_index: usize,
    /// Aggregate match score (higher = better).
    pub score: f64,
    /// Number of shots that matched.
    pub matched_shots: usize,
    /// Number of existing/target shots consumed by the match.
    #[serde(default)]
    pub existing_matched_shots: usize,
    /// Preferred import-side merge offset within the overlap.
    #[serde(default)]
    pub preferred_merge_offset: usize,
    /// Direction of match.
    pub direction: MatchDirection,
    /// Whether the last matched shot was a partial (shorter) match.
    pub is_partial: bool,
    /// Confidence tier based on score.
    pub confidence: SuggestionConfidence,
    /// Human-readable name of the existing section.
    pub existing_section_name: String,
}

/// Whether the target of a cross-section suggestion is an existing project
/// section or another section being imported in the same batch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum TargetType {
    Existing,
    Importing,
}

/// A placement suggestion that includes source/target metadata for cross-section
/// matching (import-to-existing AND import-to-import).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CrossSectionSuggestion {
    /// Station index in the existing/target section to merge with.
    pub existing_station_index: usize,
    /// Station index in the import section (0 = first, N = last).
    pub import_station_index: usize,
    /// Aggregate match score (higher = better).
    pub score: f64,
    /// Number of shots that matched.
    pub matched_shots: usize,
    /// Number of existing/target shots consumed by the match.
    #[serde(default)]
    pub existing_matched_shots: usize,
    /// Preferred import-side merge offset within the overlap.
    #[serde(default)]
    pub preferred_merge_offset: usize,
    /// Direction of match.
    pub direction: MatchDirection,
    /// Whether the last matched shot was a partial (shorter) match.
    pub is_partial: bool,
    /// Confidence tier based on score.
    pub confidence: SuggestionConfidence,
    /// Human-readable name of the target section.
    pub existing_section_name: String,
    /// Index of the import section this suggestion is for.
    pub import_section_index: u32,
    /// Name of the import section.
    pub import_section_name: String,
    /// Whether the target is an existing project section or another import.
    pub target_type: TargetType,
    /// For existing targets: the section ID.
    pub existing_section_id: Option<SectionId>,
    /// For importing targets: the index of the target import section.
    pub target_import_index: Option<u32>,
}

/// A suggestion for connecting an orphaned section leaf to a newly imported section.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OrphanPlacementSuggestion {
    /// The orphan section ID
    pub orphan_section_id: SectionId,
    /// Human-readable name of the orphan section
    pub orphan_section_name: String,
    /// Station index on the orphan section's leaf end
    pub orphan_station_index: usize,
    /// The target (newly imported) section ID
    pub target_section_id: SectionId,
    /// Human-readable name of the target section
    pub target_section_name: String,
    /// Station index on the target section to merge with
    pub target_station_index: usize,
    /// Aggregate match score (higher = better)
    pub score: f64,
    /// Number of shots that matched
    pub matched_shots: usize,
    /// Number of target shots consumed by the match
    #[serde(default)]
    pub existing_matched_shots: usize,
    /// Preferred import-side merge offset within the overlap
    #[serde(default)]
    pub preferred_merge_offset: usize,
    /// Direction of match
    pub direction: MatchDirection,
    /// Whether the last matched shot was a partial (shorter) match
    pub is_partial: bool,
    /// Confidence tier based on score
    pub confidence: SuggestionConfidence,
}

/// Minimal per-section data needed for the cross-section suggestion algorithm.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ImportSectionForSuggestion {
    pub index: u32,
    pub name: String,
    pub shots: Vec<ShotData>,
}

/// Suggest placements for ALL import sections against BOTH existing project
/// sections AND each other. Returns a flat list sorted by score descending.
pub fn suggest_all_placements(
    import_sections: &[ImportSectionForSuggestion],
    existing_sections: &[ExistingSection],
    ps_config: &PlacementSuggestionConfig,
) -> Vec<CrossSectionSuggestion> {
    let mut all: Vec<CrossSectionSuggestion> = Vec::new();

    // Use high IDs for import sections so they don't collide with real section IDs.
    // Map: fake_id = FAKE_ID_BASE + import.index
    const FAKE_ID_BASE: SectionId = 0x8000_0000;

    let import_as_existing: Vec<ExistingSection> = import_sections
        .iter()
        .map(|s| ExistingSection {
            id: FAKE_ID_BASE + SectionId::from(s.index),
            name: s.name.clone(),
            shots: s
                .shots
                .iter()
                .enumerate()
                .map(|(i, sd)| Shot::new(i as u32, sd.clone()))
                .collect(),
        })
        .collect();

    for import in import_sections {
        if import.shots.is_empty() {
            continue;
        }

        let fake_self_id = FAKE_ID_BASE + SectionId::from(import.index);

        // Match against existing project sections
        let existing_suggestions = suggest_placements(&import.shots, existing_sections, ps_config);
        for s in existing_suggestions {
            all.push(CrossSectionSuggestion {
                existing_station_index: s.existing_station_index,
                import_station_index: s.import_station_index,
                score: s.score,
                matched_shots: s.matched_shots,
                existing_matched_shots: s.existing_matched_shots,
                preferred_merge_offset: s.preferred_merge_offset,
                direction: s.direction,
                is_partial: s.is_partial,
                confidence: s.confidence,
                existing_section_name: s.existing_section_name,
                import_section_index: import.index,
                import_section_name: import.name.clone(),
                target_type: TargetType::Existing,
                existing_section_id: Some(s.existing_section_id),
                target_import_index: None,
            });
        }

        // Match against other import sections (exclude self)
        let other_imports: Vec<ExistingSection> = import_as_existing
            .iter()
            .filter(|e| e.id != fake_self_id)
            .cloned()
            .collect();

        if !other_imports.is_empty() {
            let import_suggestions = suggest_placements(&import.shots, &other_imports, ps_config);
            for s in import_suggestions {
                // Decode the fake ID back to an import index
                let target_idx = (s.existing_section_id - FAKE_ID_BASE) as u32;
                let target_name = import_sections
                    .iter()
                    .find(|is| is.index == target_idx)
                    .map(|is| is.name.clone())
                    .unwrap_or_default();

                all.push(CrossSectionSuggestion {
                    existing_station_index: s.existing_station_index,
                    import_station_index: s.import_station_index,
                    score: s.score,
                    matched_shots: s.matched_shots,
                    existing_matched_shots: s.existing_matched_shots,
                    preferred_merge_offset: s.preferred_merge_offset,
                    direction: s.direction,
                    is_partial: s.is_partial,
                    confidence: s.confidence,
                    existing_section_name: target_name,
                    import_section_index: import.index,
                    import_section_name: import.name.clone(),
                    target_type: TargetType::Importing,
                    existing_section_id: None,
                    target_import_index: Some(target_idx),
                });
            }
        }
    }

    // Sort by score descending
    all.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));

    all
}

/// Internal configuration for the suggestion algorithm.
struct SuggestionConfig {
    /// Sigma for azimuth error (degrees).
    azimuth_sigma: f64,
    /// Sigma for length error (meters).
    length_sigma: f64,
    /// Sigma for depth error (meters).
    depth_sigma: f64,
    /// Weight for azimuth score component.
    azimuth_weight: f64,
    /// Weight for length score component.
    length_weight: f64,
    /// Weight for depth_in score component.
    depth_in_weight: f64,
    /// Weight for depth_out score component.
    depth_out_weight: f64,
    /// Minimum per-shot score to continue matching.
    min_shot_score: f64,
    /// Minimum aggregate score to include a suggestion.
    min_aggregate_score: f64,
    /// Maximum number of reference shots to try from each leaf.
    max_reference_shots: usize,
    /// Maximum number of suggestions to return.
    max_suggestions: usize,
    /// Short shot threshold (meters) — shots below this get reduced weight.
    short_shot_threshold: f64,
    /// Penalty multiplier for single-shot matches (0.0–1.0).
    single_shot_penalty: f64,
    /// Hard cutoff: max azimuth error for full shots (degrees).
    max_azimuth_error_full: f64,
    /// Hard cutoff: max depth error per measurement point (meters).
    max_depth_error: f64,
    /// Length error fraction for dynamic cutoff.
    max_length_error_fraction: f64,
    /// Length error floor for dynamic cutoff (meters).
    max_length_error_floor: f64,
    /// Base length error fraction for one-shot overlaps.
    sequence_length_error_base_fraction: f64,
    /// Additional length error fraction allowed for each extra matched shot.
    sequence_length_error_step_fraction: f64,
    /// Maximum length error fraction allowed while exploring longer runs.
    sequence_length_error_max_fraction: f64,
    /// Minimum unpenalized score required for one-shot suggestions.
    single_shot_min_raw_score: f64,
    /// Stricter one-shot azimuth cutoff (degrees).
    single_shot_max_azimuth_error: f64,
    /// Stricter one-shot depth cutoff per measurement point (meters).
    single_shot_max_depth_error: f64,
    /// Stricter one-shot length error fraction.
    single_shot_max_length_error_fraction: f64,
    /// Stricter one-shot length error floor (meters).
    single_shot_max_length_error_floor: f64,
}

impl Default for SuggestionConfig {
    fn default() -> Self {
        Self::from(&PlacementSuggestionConfig::default())
    }
}

impl From<&PlacementSuggestionConfig> for SuggestionConfig {
    fn from(c: &PlacementSuggestionConfig) -> Self {
        Self {
            azimuth_sigma: c.azimuth_sigma,
            length_sigma: c.length_sigma,
            depth_sigma: c.depth_sigma,
            azimuth_weight: c.azimuth_weight,
            length_weight: c.length_weight,
            depth_in_weight: c.depth_in_weight,
            depth_out_weight: c.depth_out_weight,
            min_shot_score: c.min_shot_score,
            min_aggregate_score: c.min_aggregate_score,
            max_reference_shots: c.max_reference_shots as usize,
            max_suggestions: c.max_suggestions as usize,
            short_shot_threshold: c.short_shot_threshold,
            single_shot_penalty: c.single_shot_penalty,
            max_azimuth_error_full: c.max_azimuth_error_full,
            max_depth_error: c.max_depth_error,
            max_length_error_fraction: c.max_length_error_fraction.min(0.03),
            max_length_error_floor: c.max_length_error_floor.min(0.40),
            sequence_length_error_base_fraction: 0.03,
            sequence_length_error_step_fraction: 0.02,
            sequence_length_error_max_fraction: 0.11,
            single_shot_min_raw_score: 0.95,
            single_shot_max_azimuth_error: 8.0,
            single_shot_max_depth_error: 0.25,
            single_shot_max_length_error_fraction: 0.075,
            single_shot_max_length_error_floor: 0.50,
        }
    }
}

/// Minimal shot data needed for matching.
#[derive(Clone, Copy)]
struct MatchShot {
    avg_azimuth: f64,
    length: f64,
    depth_in: f64,
    depth_out: f64,
}

impl MatchShot {
    fn from_shot(shot: &Shot) -> Self {
        Self {
            avg_azimuth: shot.average_azimuth(),
            length: shot.length,
            depth_in: shot.depth_in,
            depth_out: shot.depth_out,
        }
    }

    fn from_shot_data(shot: &ShotData) -> Self {
        Self {
            avg_azimuth: average_azimuth(shot.azimuth_in, shot.azimuth_out),
            length: shot.length,
            depth_in: shot.depth_in,
            depth_out: shot.depth_out,
        }
    }

    /// Reverse this shot (flip azimuth 180°, swap depth_in/depth_out).
    fn reversed(&self) -> Self {
        Self {
            avg_azimuth: (self.avg_azimuth + 180.0) % 360.0,
            length: self.length,
            depth_in: self.depth_out,
            depth_out: self.depth_in,
        }
    }

}

/// Compute average azimuth from two readings, handling 360° wraparound.
fn average_azimuth(azimuth_in: f64, azimuth_out: f64) -> f64 {
    let diff = (azimuth_out - azimuth_in + 540.0) % 360.0 - 180.0;
    (azimuth_in + diff / 2.0 + 360.0) % 360.0
}

/// Compute the angular difference between two azimuths in [0, 180].
fn angular_difference(a: f64, b: f64) -> f64 {
    let diff = (a - b).rem_euclid(360.0);
    if diff > 180.0 { 360.0 - diff } else { diff }
}

/// Gaussian falloff: exp(-(error / sigma)^2).
fn gaussian(error: f64, sigma: f64) -> f64 {
    (-((error / sigma).powi(2))).exp()
}

/// Dynamic length cutoff: 3% of existing length, floored at 0.4m.
fn max_length_error(existing_length: f64, config: &SuggestionConfig) -> f64 {
    (config.max_length_error_fraction * existing_length).max(config.max_length_error_floor)
}

fn sequence_length_error_fraction(matched_count: usize, config: &SuggestionConfig) -> f64 {
    let extra = matched_count.saturating_sub(1) as f64;
    (config.sequence_length_error_base_fraction + config.sequence_length_error_step_fraction * extra)
        .min(config.sequence_length_error_max_fraction)
}

fn max_sequence_length_error(existing_length: f64, matched_count: usize, config: &SuggestionConfig) -> f64 {
    (sequence_length_error_fraction(matched_count, config) * existing_length)
        .max(config.max_length_error_floor)
}

fn max_single_shot_length_error(existing_length: f64, config: &SuggestionConfig) -> f64 {
    (config.single_shot_max_length_error_fraction * existing_length)
        .max(config.single_shot_max_length_error_floor)
}

/// Compute score comparing two shots in a given direction.
fn compute_shot_score(
    import: &MatchShot,
    existing: &MatchShot,
    direction: MatchDirection,
    config: &SuggestionConfig,
) -> f64 {
    let (existing_az, existing_depth_in, existing_depth_out) = match direction {
        MatchDirection::Forward => (existing.avg_azimuth, existing.depth_in, existing.depth_out),
        MatchDirection::Reverse => (
            (existing.avg_azimuth + 180.0) % 360.0,
            existing.depth_out,
            existing.depth_in,
        ),
    };

    let az_error = angular_difference(import.avg_azimuth, existing_az);
    let len_error = (import.length - existing.length).abs();
    let depth_in_error = (import.depth_in - existing_depth_in).abs();
    let depth_out_error = (import.depth_out - existing_depth_out).abs();

    // Hard cutoffs — reject physically implausible matches outright
    if az_error > config.max_azimuth_error_full
        || depth_in_error > config.max_depth_error
        || depth_out_error > config.max_depth_error
        || len_error > max_length_error(existing.length, config)
    {
        return 0.0;
    }

    let az_score = gaussian(az_error, config.azimuth_sigma);
    let len_score = gaussian(len_error, config.length_sigma);
    let depth_in_score = gaussian(depth_in_error, config.depth_sigma);
    let depth_out_score = gaussian(depth_out_error, config.depth_sigma);

    config.azimuth_weight * az_score
        + config.length_weight * len_score
        + config.depth_in_weight * depth_in_score
        + config.depth_out_weight * depth_out_score
}

fn compute_sequence_shot_score(
    import: &MatchShot,
    existing: &MatchShot,
    direction: MatchDirection,
    matched_count: usize,
    config: &SuggestionConfig,
) -> f64 {
    let (existing_az, existing_depth_in, existing_depth_out) = match direction {
        MatchDirection::Forward => (existing.avg_azimuth, existing.depth_in, existing.depth_out),
        MatchDirection::Reverse => (
            (existing.avg_azimuth + 180.0) % 360.0,
            existing.depth_out,
            existing.depth_in,
        ),
    };

    let az_error = angular_difference(import.avg_azimuth, existing_az);
    let len_error = (import.length - existing.length).abs();
    let depth_in_error = (import.depth_in - existing_depth_in).abs();
    let depth_out_error = (import.depth_out - existing_depth_out).abs();

    if az_error > config.max_azimuth_error_full
        || depth_in_error > config.max_depth_error
        || depth_out_error > config.max_depth_error
        || len_error > max_sequence_length_error(existing.length, matched_count, config)
    {
        return 0.0;
    }

    let az_score = gaussian(az_error, config.azimuth_sigma);
    let len_score = gaussian(len_error, config.length_sigma);
    let depth_in_score = gaussian(depth_in_error, config.depth_sigma);
    let depth_out_score = gaussian(depth_out_error, config.depth_sigma);

    config.azimuth_weight * az_score
        + config.length_weight * len_score
        + config.depth_in_weight * depth_in_score
        + config.depth_out_weight * depth_out_score
}

fn compute_exploratory_shot_score(
    import: &MatchShot,
    existing: &MatchShot,
    direction: MatchDirection,
    config: &SuggestionConfig,
) -> f64 {
    compute_sequence_shot_score(
        import,
        existing,
        direction,
        config.max_reference_shots.max(1),
        config,
    )
}

fn compute_single_shot_score(
    import: &MatchShot,
    existing: &MatchShot,
    direction: MatchDirection,
    config: &SuggestionConfig,
) -> f64 {
    let (existing_az, existing_depth_in, existing_depth_out) = match direction {
        MatchDirection::Forward => (existing.avg_azimuth, existing.depth_in, existing.depth_out),
        MatchDirection::Reverse => (
            (existing.avg_azimuth + 180.0) % 360.0,
            existing.depth_out,
            existing.depth_in,
        ),
    };

    let az_error = angular_difference(import.avg_azimuth, existing_az);
    let len_error = (import.length - existing.length).abs();
    let depth_in_error = (import.depth_in - existing_depth_in).abs();
    let depth_out_error = (import.depth_out - existing_depth_out).abs();

    if az_error > config.single_shot_max_azimuth_error
        || depth_in_error > config.single_shot_max_depth_error
        || depth_out_error > config.single_shot_max_depth_error
        || len_error > max_single_shot_length_error(existing.length, config)
    {
        return 0.0;
    }

    let score = compute_shot_score(import, existing, direction, config);
    if score >= config.single_shot_min_raw_score { score } else { 0.0 }
}

/// Result of trying to match a sequence of import shots against existing shots.
struct SequenceMatch {
    score: f64,
    matched_count: usize,
    existing_matched_count: usize,
    is_partial: bool,
}

#[derive(Clone, Copy)]
struct DpCell {
    score_sum: f64,
    weight_sum: f64,
    import_count: usize,
    existing_count: usize,
}

fn oriented_existing_shots(
    existing_shots: &[MatchShot],
    start_idx: usize,
    direction: MatchDirection,
) -> Vec<MatchShot> {
    match direction {
        MatchDirection::Forward => existing_shots[start_idx..].to_vec(),
        MatchDirection::Reverse => existing_shots[..=start_idx]
            .iter()
            .rev()
            .map(MatchShot::reversed)
            .collect(),
    }
}

fn shot_weight(shot: &MatchShot, config: &SuggestionConfig) -> f64 {
    if shot.length < config.short_shot_threshold {
        shot.length / config.short_shot_threshold
    } else {
        1.0
    }
}

fn cell_final_score(cell: DpCell, config: &SuggestionConfig) -> f64 {
    if cell.import_count == 0 || cell.weight_sum <= 0.0 {
        return 0.0;
    }
    let raw_score = cell.score_sum / cell.weight_sum;
    let match_bonus = 1.0 + 0.15 * cell.weight_sum.ln();
    let single_penalty = if cell.import_count == 1 { config.single_shot_penalty } else { 1.0 };
    raw_score * match_bonus.max(1.0) * single_penalty
}

fn single_front_overlap_key(suggestion: &PlacementSuggestion) -> Option<(usize, usize)> {
    if suggestion.import_station_index != 0
        || suggestion.matched_shots != 1
    {
        return None;
    }

    let existing_shot_index = match suggestion.direction {
        MatchDirection::Forward => suggestion.existing_station_index,
        MatchDirection::Reverse => suggestion.existing_station_index.checked_sub(1)?,
    };

    Some((0, existing_shot_index))
}

fn suggestion_endpoint_key(suggestion: &PlacementSuggestion) -> Option<(SectionId, usize, usize, usize, usize)> {
    if suggestion.is_partial || suggestion.matched_shots != suggestion.existing_matched_shots {
        return None;
    }

    let import_a = suggestion.import_station_index;
    let import_b = if suggestion.import_station_index == 0 {
        suggestion.matched_shots
    } else {
        suggestion.import_station_index.checked_sub(suggestion.matched_shots)?
    };

    let existing_b = match suggestion.direction {
        MatchDirection::Forward => suggestion.existing_station_index.checked_add(suggestion.matched_shots)?,
        MatchDirection::Reverse => suggestion.existing_station_index.checked_sub(suggestion.matched_shots)?,
    };
    let existing_a = suggestion.existing_station_index;

    let (import_lo, import_hi) = if import_a <= import_b {
        (import_a, import_b)
    } else {
        (import_b, import_a)
    };
    let (existing_lo, existing_hi) = if existing_a <= existing_b {
        (existing_a, existing_b)
    } else {
        (existing_b, existing_a)
    };

    Some((suggestion.existing_section_id, import_lo, import_hi, existing_lo, existing_hi))
}

fn suppress_equivalent_single_front_reverses(suggestions: &mut Vec<PlacementSuggestion>) {
    const SCORE_EPSILON: f64 = 0.02;

    let forward_keys: Vec<(SectionId, (usize, usize), f64)> = suggestions
        .iter()
        .filter(|suggestion| suggestion.direction == MatchDirection::Forward)
        .filter_map(|suggestion| {
            single_front_overlap_key(suggestion)
                .map(|key| (suggestion.existing_section_id, key, suggestion.score))
        })
        .collect();

    suggestions.retain(|candidate| {
        if candidate.direction != MatchDirection::Reverse {
            return true;
        }

        let Some(key) = single_front_overlap_key(candidate) else {
            return true;
        };

        !forward_keys.iter().any(|(section_id, other_key, other_score)| {
            *section_id == candidate.existing_section_id
                && *other_key == key
                && *other_score + SCORE_EPSILON >= candidate.score
        })
    });
}

fn suppress_duplicate_endpoint_pairs(suggestions: &mut Vec<PlacementSuggestion>) {
    let mut kept: Vec<PlacementSuggestion> = Vec::with_capacity(suggestions.len());

    for suggestion in suggestions.drain(..) {
        let Some(key) = suggestion_endpoint_key(&suggestion) else {
            kept.push(suggestion);
            continue;
        };

        if let Some(existing) = kept
            .iter_mut()
            .find(|candidate| suggestion_endpoint_key(candidate) == Some(key))
        {
            if suggestion.score > existing.score {
                *existing = suggestion;
            }
        } else {
            kept.push(suggestion);
        }
    }

    *suggestions = kept;
}

fn outward_runs(shots: &[MatchShot], station_index: usize) -> Vec<(bool, Vec<MatchShot>)> {
    let mut runs = Vec::new();

    if station_index >= 1 {
        runs.push((false, vec![shots[station_index - 1].reversed()]));
    }

    if station_index < shots.len() {
        runs.push((true, vec![shots[station_index]]));
    }

    runs
}

fn station_context_multiplier(
    import_shots: &[MatchShot],
    existing_shots: &[MatchShot],
    import_station_index: usize,
    existing_station_index: usize,
    config: &SuggestionConfig,
) -> f64 {
    if import_station_index > import_shots.len() || existing_station_index > existing_shots.len() {
        return 0.75;
    }

    let import_runs = outward_runs(import_shots, import_station_index);
    let existing_runs = outward_runs(existing_shots, existing_station_index);
    if import_runs.is_empty() || existing_runs.is_empty() {
        return 1.0;
    }

    let mut scored: Vec<(f64, bool, bool)> = Vec::new();
    for (import_forward, import_run) in &import_runs {
        for (existing_forward, existing_run) in &existing_runs {
            let (Some(import_shot), Some(existing_shot)) = (import_run.first(), existing_run.first()) else {
                continue;
            };
            let score = compute_shot_score(import_shot, existing_shot, MatchDirection::Forward, config);
            if score >= config.min_shot_score {
                scored.push((score, *import_forward, *existing_forward));
            }
        }
    }

    if scored.is_empty() {
        return 0.65;
    }

    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let best = scored[0];
    let has_second_side = scored.iter().skip(1).any(|(_, import_forward, existing_forward)| {
        *import_forward != best.1 && *existing_forward != best.2
    });

    let import_leaf = import_station_index == 0 || import_station_index == import_shots.len();
    let existing_leaf = existing_station_index == 0 || existing_station_index == existing_shots.len();

    if has_second_side {
        1.18
    } else if import_leaf || existing_leaf {
        1.0
    } else if best.0 >= 0.85 {
        0.86
    } else {
        0.72
    }
}

fn merge_offset_pairs(suggestion: &PlacementSuggestion) -> Vec<(usize, usize)> {
    let import_max_offset = if suggestion.is_partial {
        suggestion.matched_shots.saturating_sub(1)
    } else {
        suggestion.matched_shots
    };
    (0..=import_max_offset).map(|k| (k, k)).collect()
}

fn merge_station_pair_for_offsets(
    import_shot_count: usize,
    existing_shot_count: usize,
    suggestion: &PlacementSuggestion,
    import_offset: usize,
    existing_offset: usize,
) -> Option<(usize, usize)> {
    let import_station = if suggestion.import_station_index == 0 {
        import_offset
    } else {
        suggestion.import_station_index.checked_sub(import_offset)?
    };
    let existing_station = match suggestion.direction {
        MatchDirection::Forward => suggestion.existing_station_index.checked_add(existing_offset)?,
        MatchDirection::Reverse => suggestion.existing_station_index.checked_sub(existing_offset)?,
    };

    if import_station <= import_shot_count && existing_station <= existing_shot_count {
        Some((import_station, existing_station))
    } else {
        None
    }
}

fn sequence_match_passes_final_cutoffs(
    import_shots: &[MatchShot],
    existing_oriented: &[MatchShot],
    cell: DpCell,
    config: &SuggestionConfig,
) -> bool {
    if cell.import_count == 0
        || cell.existing_count == 0
        || cell.import_count != cell.existing_count
        || cell.import_count > import_shots.len()
        || cell.existing_count > existing_oriented.len()
    {
        return false;
    }

    if cell.import_count == 1 {
        return compute_single_shot_score(
            &import_shots[0],
            &existing_oriented[0],
            MatchDirection::Forward,
            config,
        ) >= config.min_shot_score;
    }

    for idx in 0..cell.import_count {
        let score = compute_sequence_shot_score(
            &import_shots[idx],
            &existing_oriented[idx],
            MatchDirection::Forward,
            cell.import_count,
            config,
        );
        if score < config.min_shot_score {
            return false;
        }
    }

    true
}

/// Try matching a sequence of import shots against existing shots starting at `start_idx`.
fn try_match_sequence(
    import_shots: &[MatchShot],
    existing_shots: &[MatchShot],
    start_idx: usize,
    direction: MatchDirection,
    config: &SuggestionConfig,
) -> SequenceMatch {
    if import_shots.is_empty() || existing_shots.is_empty() || start_idx >= existing_shots.len() {
        return SequenceMatch { score: 0.0, matched_count: 0, existing_matched_count: 0, is_partial: false };
    }

    let existing_oriented = oriented_existing_shots(existing_shots, start_idx, direction);
    let n = import_shots.len();
    let m = existing_oriented.len();
    let mut dp: Vec<Vec<Option<DpCell>>> = vec![vec![None; m + 1]; n + 1];
    dp[0][0] = Some(DpCell {
        score_sum: 0.0,
        weight_sum: 0.0,
        import_count: 0,
        existing_count: 0,
    });

    for i in 0..=n {
        for j in 0..=m {
            let Some(cell) = dp[i][j] else { continue };
            if i + 1 > n || j + 1 > m {
                continue;
            }
            let import_shot = &import_shots[i];
            let existing_shot = &existing_oriented[j];
            let score = compute_exploratory_shot_score(import_shot, existing_shot, MatchDirection::Forward, config);
            if score < config.min_shot_score {
                continue;
            }
            let weight = shot_weight(import_shot, config);
            let next = DpCell {
                score_sum: cell.score_sum + score * weight,
                weight_sum: cell.weight_sum + weight,
                import_count: cell.import_count + 1,
                existing_count: cell.existing_count + 1,
            };
            let target = &mut dp[i + 1][j + 1];
            let replace = target
                .map(|old| cell_final_score(next, config) > cell_final_score(old, config))
                .unwrap_or(true);
            if replace {
                *target = Some(next);
            }
        }
    }

    let mut candidates: Vec<DpCell> = Vec::new();
    for row in dp.iter().skip(1) {
        for cell in row.iter().flatten() {
            candidates.push(*cell);
        }
    }

    candidates.sort_by(|a, b| {
        cell_final_score(*b, config)
            .partial_cmp(&cell_final_score(*a, config))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.import_count.cmp(&a.import_count))
    });

    let Some(best) = candidates
        .into_iter()
        .find(|cell| {
            cell.import_count > 0
                && cell.weight_sum > 0.0
                && sequence_match_passes_final_cutoffs(import_shots, &existing_oriented, *cell, config)
        })
    else {
        return SequenceMatch { score: 0.0, matched_count: 0, existing_matched_count: 0, is_partial: false };
    };

    SequenceMatch {
        score: cell_final_score(best, config),
        matched_count: best.import_count,
        existing_matched_count: best.existing_count,
        is_partial: false,
    }
}

/// Existing section data needed for matching.
#[derive(Clone)]
pub struct ExistingSection {
    pub id: SectionId,
    pub name: String,
    pub shots: Vec<Shot>,
}

/// Suggest placements for an import section against existing sections.
pub fn suggest_placements(
    import_shots: &[ShotData],
    existing_sections: &[ExistingSection],
    ps_config: &PlacementSuggestionConfig,
) -> Vec<PlacementSuggestion> {
    let config = &SuggestionConfig::from(ps_config);

    if import_shots.is_empty() || existing_sections.is_empty() {
        return Vec::new();
    }

    let max_ref = config.max_reference_shots.min(import_shots.len());

    // Build import match shots for station 0 (first N shots, natural order)
    let import_from_0: Vec<MatchShot> = import_shots[..max_ref]
        .iter()
        .map(MatchShot::from_shot_data)
        .collect();

    let import_match_shots: Vec<MatchShot> = import_shots
        .iter()
        .map(MatchShot::from_shot_data)
        .collect();

    // Build import match shots for station N (last N shots, reversed)
    let import_from_n: Vec<MatchShot> = import_shots[import_shots.len().saturating_sub(max_ref)..]
        .iter()
        .rev()
        .map(|s| MatchShot::from_shot_data(s).reversed())
        .collect();

    let import_station_n = import_shots.len(); // station index for last station

    let mut suggestions: Vec<PlacementSuggestion> = Vec::new();

    for existing in existing_sections {
        if existing.shots.is_empty() {
            continue;
        }

        let existing_match_shots: Vec<MatchShot> =
            existing.shots.iter().map(MatchShot::from_shot).collect();

        // Try from both leaves of the import section
        let leaf_configs: &[(&[MatchShot], usize)] = &[
            (&import_from_0, 0),
            (&import_from_n, import_station_n),
        ];

        for &(ref_shots, import_station) in leaf_configs {
            if ref_shots.is_empty() {
                continue;
            }

            // Try all starting positions in the existing section
            for start_idx in 0..existing_match_shots.len() {
                // Try both forward and reverse directions
                for &direction in &[MatchDirection::Forward, MatchDirection::Reverse] {
                    let result = try_match_sequence(
                        ref_shots,
                        &existing_match_shots,
                        start_idx,
                        direction,
                        config,
                    );

                    if result.matched_count == 0 || result.score < config.min_aggregate_score {
                        continue;
                    }

                    // Compute the existing station index for the merge point
                    let existing_station_index = match direction {
                        MatchDirection::Forward => start_idx,
                        MatchDirection::Reverse => start_idx + 1,
                    };

                    let mut suggestion = PlacementSuggestion {
                        existing_section_id: existing.id,
                        existing_station_index,
                        import_station_index: import_station,
                        score: result.score,
                        matched_shots: result.matched_count,
                        existing_matched_shots: result.existing_matched_count,
                        preferred_merge_offset: if result.is_partial {
                            result.matched_count.saturating_sub(1)
                        } else {
                            result.matched_count
                        },
                        direction,
                        is_partial: result.is_partial,
                        confidence: SuggestionConfidence::Low,
                        existing_section_name: existing.name.clone(),
                    };

                    let mut best_context: Option<(f64, usize)> = None;
                    for (import_offset, existing_offset) in merge_offset_pairs(&suggestion) {
                        let Some((merge_import_station, merge_existing_station)) =
                            merge_station_pair_for_offsets(
                                import_match_shots.len(),
                                existing_match_shots.len(),
                                &suggestion,
                                import_offset,
                                existing_offset,
                            )
                        else {
                            continue;
                        };
                        let context_multiplier = station_context_multiplier(
                            &import_match_shots,
                            &existing_match_shots,
                            merge_import_station,
                            merge_existing_station,
                            config,
                        );
                        if best_context
                            .map(|(best, _)| context_multiplier > best)
                            .unwrap_or(true)
                        {
                            best_context = Some((context_multiplier, import_offset));
                        }
                    }
                    let (context_multiplier, preferred_offset) = best_context.unwrap_or((1.0, suggestion.preferred_merge_offset));
                    suggestion.preferred_merge_offset = preferred_offset;
                    suggestion.score *= context_multiplier;

                    if suggestion.score < config.min_aggregate_score {
                        continue;
                    }

                    suggestion.confidence = if suggestion.score >= 0.90 {
                        SuggestionConfidence::High
                    } else if suggestion.score >= 0.70 {
                        SuggestionConfidence::Medium
                    } else {
                        SuggestionConfidence::Low
                    };

                    // Check for duplicates
                    let is_dup = suggestions.iter().any(|s| {
                        s.existing_section_id == suggestion.existing_section_id
                            && s.existing_station_index == suggestion.existing_station_index
                            && s.import_station_index == suggestion.import_station_index
                            && s.direction == suggestion.direction
                    });
                    if is_dup {
                        // Keep the better score
                        if let Some(existing_suggestion) = suggestions.iter_mut().find(|s| {
                            s.existing_section_id == suggestion.existing_section_id
                                && s.existing_station_index == suggestion.existing_station_index
                                && s.import_station_index == suggestion.import_station_index
                                && s.direction == suggestion.direction
                        }) {
                            if suggestion.score > existing_suggestion.score {
                                *existing_suggestion = suggestion;
                            }
                        }
                        continue;
                    }

                    suggestions.push(suggestion);
                }
            }
        }
    }

    suppress_equivalent_single_front_reverses(&mut suggestions);
    suppress_duplicate_endpoint_pairs(&mut suggestions);

    // Sort by score descending
    suggestions.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));

    // Keep top N
    suggestions.truncate(config.max_suggestions);

    suggestions
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_shot_data(az_in: f64, az_out: f64, length: f64, depth_in: f64, depth_out: f64) -> ShotData {
        ShotData {
            azimuth_in: az_in,
            azimuth_out: az_out,
            length,
            depth_in,
            depth_out,
            ..Default::default()
        }
    }

    fn make_shot(id: u32, az_in: f64, az_out: f64, length: f64, depth_in: f64, depth_out: f64) -> Shot {
        Shot::new(id, make_shot_data(az_in, az_out, length, depth_in, depth_out))
    }

    fn make_section(id: SectionId, name: &str, shots: Vec<Shot>) -> ExistingSection {
        ExistingSection {
            id,
            name: name.to_string(),
            shots,
        }
    }

    // ========================================================================
    // angular_difference tests
    // ========================================================================

    #[test]
    fn angular_difference_basic() {
        assert!((angular_difference(10.0, 20.0) - 10.0).abs() < 1e-6);
        assert!((angular_difference(20.0, 10.0) - 10.0).abs() < 1e-6);
    }

    #[test]
    fn angular_difference_wraparound() {
        assert!((angular_difference(350.0, 10.0) - 20.0).abs() < 1e-6);
        assert!((angular_difference(10.0, 350.0) - 20.0).abs() < 1e-6);
    }

    #[test]
    fn angular_difference_opposite() {
        assert!((angular_difference(0.0, 180.0) - 180.0).abs() < 1e-6);
        assert!((angular_difference(90.0, 270.0) - 180.0).abs() < 1e-6);
    }

    #[test]
    fn angular_difference_same() {
        assert!((angular_difference(45.0, 45.0)).abs() < 1e-6);
    }

    // ========================================================================
    // Shot scoring tests
    // ========================================================================

    #[test]
    fn identical_shots_score_perfectly() {
        let config = SuggestionConfig::default();
        let shot = MatchShot {
            avg_azimuth: 90.0,
            length: 5.0,
            depth_in: 3.0,
            depth_out: 4.0,
        };
        let score = compute_shot_score(&shot, &shot, MatchDirection::Forward, &config);
        assert!((score - 1.0).abs() < 1e-6, "identical shots should score 1.0, got {score}");
    }

    #[test]
    fn reversed_shots_score_perfectly() {
        let config = SuggestionConfig::default();
        let import = MatchShot {
            avg_azimuth: 270.0, // 90 + 180
            length: 5.0,
            depth_in: 4.0, // swapped
            depth_out: 3.0,
        };
        let existing = MatchShot {
            avg_azimuth: 90.0,
            length: 5.0,
            depth_in: 3.0,
            depth_out: 4.0,
        };
        let score = compute_shot_score(&import, &existing, MatchDirection::Reverse, &config);
        assert!((score - 1.0).abs() < 1e-6, "reversed identical shots should score 1.0, got {score}");
    }

    #[test]
    fn very_different_shots_score_low() {
        let config = SuggestionConfig::default();
        let import = MatchShot {
            avg_azimuth: 0.0,
            length: 1.0,
            depth_in: 0.0,
            depth_out: 0.5,
        };
        let existing = MatchShot {
            avg_azimuth: 180.0,
            length: 20.0,
            depth_in: 50.0,
            depth_out: 55.0,
        };
        let score = compute_shot_score(&import, &existing, MatchDirection::Forward, &config);
        assert!(score == 0.0, "very different shots should be hard-rejected, got {score}");
    }

    #[test]
    fn small_azimuth_error_high_score() {
        let config = SuggestionConfig::default();
        let import = MatchShot {
            avg_azimuth: 92.0, // 2° off
            length: 5.0,
            depth_in: 3.0,
            depth_out: 4.0,
        };
        let existing = MatchShot {
            avg_azimuth: 90.0,
            length: 5.0,
            depth_in: 3.0,
            depth_out: 4.0,
        };
        let score = compute_shot_score(&import, &existing, MatchDirection::Forward, &config);
        assert!(score > 0.9, "small azimuth error should still score high, got {score}");
    }

    #[test]
    fn length_deviation_is_hard_rejected() {
        let config = SuggestionConfig::default();
        let import = MatchShot {
            avg_azimuth: 90.0,
            length: 10.0,
            depth_in: 3.0,
            depth_out: 5.0,
        };
        let existing = MatchShot {
            avg_azimuth: 90.0,
            length: 5.0,
            depth_in: 3.0,
            depth_out: 4.0,
        };
        let score = compute_shot_score(&import, &existing, MatchDirection::Forward, &config);
        assert_eq!(score, 0.0, "large length deviation should be hard-rejected");
    }

    // ========================================================================
    // Sequence matching tests
    // ========================================================================

    #[test]
    fn multi_shot_forward_match() {
        let config = SuggestionConfig::default();
        let import = vec![
            MatchShot { avg_azimuth: 90.0, length: 5.0, depth_in: 3.0, depth_out: 4.0 },
            MatchShot { avg_azimuth: 45.0, length: 3.0, depth_in: 4.0, depth_out: 4.5 },
        ];
        let existing = vec![
            MatchShot { avg_azimuth: 90.0, length: 5.0, depth_in: 3.0, depth_out: 4.0 },
            MatchShot { avg_azimuth: 45.0, length: 3.0, depth_in: 4.0, depth_out: 4.5 },
            MatchShot { avg_azimuth: 180.0, length: 7.0, depth_in: 4.5, depth_out: 6.0 },
        ];
        let result = try_match_sequence(&import, &existing, 0, MatchDirection::Forward, &config);
        assert_eq!(result.matched_count, 2);
        assert!(result.score > 0.9, "perfect forward match should score high, got {}", result.score);
        assert!(!result.is_partial);
    }

    #[test]
    fn multi_shot_reverse_match() {
        let config = SuggestionConfig::default();
        // Import shots retrace existing shots backwards
        let import = vec![
            // Reversed version of existing[1]: az 45+180=225, depth swapped
            MatchShot { avg_azimuth: 225.0, length: 3.0, depth_in: 4.5, depth_out: 4.0 },
            // Reversed version of existing[0]: az 90+180=270, depth swapped
            MatchShot { avg_azimuth: 270.0, length: 5.0, depth_in: 4.0, depth_out: 3.0 },
        ];
        let existing = vec![
            MatchShot { avg_azimuth: 90.0, length: 5.0, depth_in: 3.0, depth_out: 4.0 },
            MatchShot { avg_azimuth: 45.0, length: 3.0, depth_in: 4.0, depth_out: 4.5 },
            MatchShot { avg_azimuth: 180.0, length: 7.0, depth_in: 4.5, depth_out: 6.0 },
        ];
        // Start at shot 1, matching backwards
        let result = try_match_sequence(&import, &existing, 1, MatchDirection::Reverse, &config);
        assert_eq!(result.matched_count, 2);
        assert!(result.score > 0.9, "perfect reverse match should score high, got {}", result.score);
    }

    #[test]
    fn sequence_stops_before_length_deviation() {
        let config = SuggestionConfig::default();
        let import = vec![
            MatchShot { avg_azimuth: 90.0, length: 5.0, depth_in: 3.0, depth_out: 4.0 },
            MatchShot { avg_azimuth: 45.0, length: 0.6, depth_in: 4.0, depth_out: 4.1 },
        ];
        let existing = vec![
            MatchShot { avg_azimuth: 90.0, length: 5.0, depth_in: 3.0, depth_out: 4.0 },
            MatchShot { avg_azimuth: 45.0, length: 3.0, depth_in: 4.0, depth_out: 4.5 },
        ];
        let result = try_match_sequence(&import, &existing, 0, MatchDirection::Forward, &config);
        assert_eq!(result.matched_count, 1);
        assert!(!result.is_partial, "length-deviating shot should not become a partial match");
        assert!(result.score > config.min_aggregate_score, "score should be above minimum");
    }

    #[test]
    fn no_match_when_shots_differ() {
        let config = SuggestionConfig::default();
        let import = vec![
            MatchShot { avg_azimuth: 0.0, length: 1.0, depth_in: 0.0, depth_out: 0.5 },
        ];
        let existing = vec![
            MatchShot { avg_azimuth: 180.0, length: 20.0, depth_in: 50.0, depth_out: 55.0 },
        ];
        let result = try_match_sequence(&import, &existing, 0, MatchDirection::Forward, &config);
        assert_eq!(result.matched_count, 0);
    }

    #[test]
    fn single_shot_match_penalized() {
        let config = SuggestionConfig::default();
        let import = vec![
            MatchShot { avg_azimuth: 90.0, length: 5.0, depth_in: 3.0, depth_out: 4.0 },
        ];
        let existing = vec![
            MatchShot { avg_azimuth: 90.0, length: 5.0, depth_in: 3.0, depth_out: 4.0 },
            MatchShot { avg_azimuth: 45.0, length: 3.0, depth_in: 4.0, depth_out: 4.5 },
        ];
        let result = try_match_sequence(&import, &existing, 0, MatchDirection::Forward, &config);
        assert_eq!(result.matched_count, 1);
        // Perfect single shot: raw_score=1.0, match_bonus=1.0, penalty=0.6 → 0.6
        assert!(
            (result.score - config.single_shot_penalty).abs() < 1e-6,
            "single shot should be penalized to {}, got {}",
            config.single_shot_penalty,
            result.score,
        );
    }

    #[test]
    fn single_shot_match_requires_strict_fit() {
        let config = SuggestionConfig::default();
        let import = vec![
            MatchShot { avg_azimuth: 99.0, length: 5.0, depth_in: 3.0, depth_out: 4.0 },
        ];
        let existing = vec![
            MatchShot { avg_azimuth: 90.0, length: 5.0, depth_in: 3.0, depth_out: 4.0 },
            MatchShot { avg_azimuth: 45.0, length: 3.0, depth_in: 4.0, depth_out: 4.5 },
        ];

        assert!(
            compute_shot_score(&import[0], &existing[0], MatchDirection::Forward, &config)
                >= config.min_shot_score,
            "fixture should remain inside normal shot tolerances",
        );

        let result = try_match_sequence(&import, &existing, 0, MatchDirection::Forward, &config);

        assert_eq!(result.matched_count, 0, "loose one-shot matches should be rejected");
    }

    #[test]
    fn multi_shot_match_uses_normal_first_shot_tolerance() {
        let config = SuggestionConfig::default();
        let import = vec![
            MatchShot { avg_azimuth: 99.0, length: 5.0, depth_in: 3.0, depth_out: 4.0 },
            MatchShot { avg_azimuth: 45.0, length: 3.0, depth_in: 4.0, depth_out: 4.5 },
        ];
        let existing = vec![
            MatchShot { avg_azimuth: 90.0, length: 5.0, depth_in: 3.0, depth_out: 4.0 },
            MatchShot { avg_azimuth: 45.0, length: 3.0, depth_in: 4.0, depth_out: 4.5 },
        ];

        let result = try_match_sequence(&import, &existing, 0, MatchDirection::Forward, &config);

        assert_eq!(result.matched_count, 2, "multi-shot matches should keep normal shot tolerances");
    }

    #[test]
    fn marker_station_split_does_not_match_single_target_shot() {
        let config = SuggestionConfig::default();
        let import = vec![
            MatchShot { avg_azimuth: 90.0, length: 4.0, depth_in: 3.0, depth_out: 3.4 },
            MatchShot { avg_azimuth: 90.5, length: 6.0, depth_in: 3.4, depth_out: 4.0 },
            MatchShot { avg_azimuth: 45.0, length: 3.0, depth_in: 4.0, depth_out: 4.5 },
        ];
        let existing = vec![
            MatchShot { avg_azimuth: 90.2, length: 10.0, depth_in: 3.0, depth_out: 4.0 },
            MatchShot { avg_azimuth: 45.0, length: 3.0, depth_in: 4.0, depth_out: 4.5 },
        ];

        let result = try_match_sequence(&import, &existing, 0, MatchDirection::Forward, &config);

        assert_eq!(result.matched_count, 0, "split import shots must not collapse onto one target shot");
    }

    #[test]
    fn slight_kissoff_split_does_not_match_single_target_shot() {
        let config = SuggestionConfig::default();
        let import = vec![
            MatchShot { avg_azimuth: 82.0, length: 5.0, depth_in: 3.0, depth_out: 3.45 },
            MatchShot { avg_azimuth: 98.0, length: 5.0, depth_in: 3.45, depth_out: 4.0 },
            MatchShot { avg_azimuth: 45.0, length: 3.0, depth_in: 4.0, depth_out: 4.5 },
        ];
        let existing = vec![
            MatchShot { avg_azimuth: 90.0, length: 10.0, depth_in: 3.0, depth_out: 4.0 },
            MatchShot { avg_azimuth: 45.0, length: 3.0, depth_in: 4.0, depth_out: 4.5 },
        ];

        let result = try_match_sequence(&import, &existing, 0, MatchDirection::Forward, &config);

        assert_eq!(result.matched_count, 0, "kiss-off splits must not collapse onto one target shot");
    }

    #[test]
    fn station_context_does_not_boost_station_density_mismatch() {
        let config = SuggestionConfig::default();
        let import = vec![
            MatchShot { avg_azimuth: 90.0, length: 10.0, depth_in: 3.0, depth_out: 4.0 },
        ];
        let existing = vec![
            MatchShot { avg_azimuth: 89.5, length: 4.0, depth_in: 3.0, depth_out: 3.4 },
            MatchShot { avg_azimuth: 90.5, length: 6.0, depth_in: 3.4, depth_out: 4.0 },
        ];

        let multiplier = station_context_multiplier(&import, &existing, 0, 0, &config);

        assert!(multiplier <= 1.0, "station-density mismatch should not boost 1:1 matches, got {multiplier}");
    }

    #[test]
    fn station_context_penalizes_one_sided_interior_match() {
        let config = SuggestionConfig::default();
        let import = vec![
            MatchShot { avg_azimuth: 90.0, length: 5.0, depth_in: 3.0, depth_out: 4.0 },
            MatchShot { avg_azimuth: 180.0, length: 5.0, depth_in: 4.0, depth_out: 5.0 },
        ];
        let existing = vec![
            MatchShot { avg_azimuth: 90.0, length: 5.0, depth_in: 3.0, depth_out: 4.0 },
            MatchShot { avg_azimuth: 270.0, length: 5.0, depth_in: 4.0, depth_out: 5.0 },
        ];

        let multiplier = station_context_multiplier(&import, &existing, 1, 1, &config);

        assert!(multiplier < 1.0, "unsupported interior match should be penalized, got {multiplier}");
    }

    // ========================================================================
    // suggest_placements integration tests
    // ========================================================================

    #[test]
    fn suggest_forward_match_from_station_0() {
        let import_shots = vec![
            make_shot_data(88.0, 92.0, 5.0, 3.0, 4.0),
            make_shot_data(43.0, 47.0, 3.0, 4.0, 4.5),
            make_shot_data(130.0, 135.0, 8.0, 4.5, 7.0),
        ];

        let existing = vec![
            make_section(1, "Main Passage", vec![
                make_shot(0, 88.0, 92.0, 5.0, 3.0, 4.0),
                make_shot(1, 43.0, 47.0, 3.0, 4.0, 4.5),
                make_shot(2, 200.0, 205.0, 10.0, 4.5, 10.0),
                make_shot(3, 270.0, 275.0, 4.0, 10.0, 11.0),
            ]),
        ];

        let suggestions = suggest_placements(&import_shots, &existing, &PlacementSuggestionConfig::default());
        assert!(!suggestions.is_empty(), "should find at least one suggestion");

        let best = &suggestions[0];
        assert_eq!(best.existing_section_id, 1);
        assert_eq!(best.existing_station_index, 0);
        assert_eq!(best.import_station_index, 0);
        assert_eq!(best.direction, MatchDirection::Forward);
        assert!(best.score >= 0.45);
        assert!(best.matched_shots >= 2);
    }

    #[test]
    fn suggest_reverse_match() {
        // Import shots retrace existing shots backwards
        let import_shots = vec![
            // Reversed version of existing shot 1: az 45+180=225, depth swapped
            make_shot_data(223.0, 227.0, 3.0, 4.5, 4.0),
            // Reversed version of existing shot 0: az 90+180=270, depth swapped
            make_shot_data(268.0, 272.0, 5.0, 4.0, 3.0),
            // New shots continuing from here
            make_shot_data(130.0, 135.0, 8.0, 3.0, 5.0),
        ];

        let existing = vec![
            make_section(1, "Main Passage", vec![
                make_shot(0, 88.0, 92.0, 5.0, 3.0, 4.0),
                make_shot(1, 43.0, 47.0, 3.0, 4.0, 4.5),
                make_shot(2, 200.0, 205.0, 10.0, 4.5, 10.0),
            ]),
        ];

        let suggestions = suggest_placements(&import_shots, &existing, &PlacementSuggestionConfig::default());
        assert!(!suggestions.is_empty(), "should find reverse match");

        let best = &suggestions[0];
        assert_eq!(best.existing_section_id, 1);
        assert_eq!(best.direction, MatchDirection::Reverse);
        assert_eq!(best.import_station_index, 0);
        // Reverse from shot 1: existing_station_index = 1 + 1 = 2
        assert_eq!(best.existing_station_index, 2);
    }

    #[test]
    fn suggest_match_from_station_n() {
        // Reference shots at the END of the import section
        let import_shots = vec![
            // New shots first
            make_shot_data(130.0, 135.0, 8.0, 4.5, 7.0),
            make_shot_data(300.0, 305.0, 6.0, 7.0, 9.0),
            // Then reference shots matching existing section (forward)
            make_shot_data(88.0, 92.0, 5.0, 3.0, 4.0),
            make_shot_data(43.0, 47.0, 3.0, 4.0, 4.5),
        ];

        let existing = vec![
            make_section(1, "Main Passage", vec![
                make_shot(0, 88.0, 92.0, 5.0, 3.0, 4.0),
                make_shot(1, 43.0, 47.0, 3.0, 4.0, 4.5),
                make_shot(2, 200.0, 205.0, 10.0, 4.5, 10.0),
            ]),
        ];

        let suggestions = suggest_placements(&import_shots, &existing, &PlacementSuggestionConfig::default());

        // Should find a match from station N (= 4, last station)
        let station_n_suggestion = suggestions.iter().find(|s| s.import_station_index == 4);
        assert!(station_n_suggestion.is_some(), "should find match from station N; got suggestions: {:?}", suggestions.iter().map(|s| (s.import_station_index, s.existing_station_index, s.direction, s.score)).collect::<Vec<_>>());
    }

    #[test]
    fn no_suggestions_for_empty_project() {
        let import_shots = vec![
            make_shot_data(90.0, 90.0, 5.0, 3.0, 4.0),
        ];
        let suggestions = suggest_placements(&import_shots, &[], &PlacementSuggestionConfig::default());
        assert!(suggestions.is_empty());
    }

    #[test]
    fn no_suggestions_for_empty_import() {
        let existing = vec![
            make_section(1, "Test", vec![
                make_shot(0, 90.0, 90.0, 5.0, 3.0, 4.0),
            ]),
        ];
        let suggestions = suggest_placements(&[], &existing, &PlacementSuggestionConfig::default());
        assert!(suggestions.is_empty());
    }

    #[test]
    fn no_match_for_unrelated_sections() {
        let import_shots = vec![
            make_shot_data(0.0, 0.0, 1.0, 0.0, 0.5),
            make_shot_data(0.0, 0.0, 1.0, 0.5, 1.0),
        ];
        let existing = vec![
            make_section(1, "Different", vec![
                make_shot(0, 180.0, 180.0, 20.0, 50.0, 55.0),
                make_shot(1, 90.0, 90.0, 15.0, 55.0, 60.0),
            ]),
        ];
        let suggestions = suggest_placements(&import_shots, &existing, &PlacementSuggestionConfig::default());
        // Should have no good suggestions
        assert!(
            suggestions.is_empty() || suggestions[0].score < 0.45,
            "unrelated sections should not match well"
        );
    }

    #[test]
    fn multiple_existing_sections_finds_best() {
        // Reference shots match section 2, not section 1
        let import_shots = vec![
            make_shot_data(175.0, 185.0, 7.0, 10.0, 12.0),
            make_shot_data(260.0, 265.0, 4.0, 12.0, 13.0),
        ];

        let existing = vec![
            make_section(1, "Wrong Section", vec![
                make_shot(0, 90.0, 90.0, 5.0, 3.0, 4.0),
                make_shot(1, 45.0, 45.0, 3.0, 4.0, 4.5),
            ]),
            make_section(2, "Right Section", vec![
                make_shot(0, 175.0, 185.0, 7.0, 10.0, 12.0),
                make_shot(1, 260.0, 265.0, 4.0, 12.0, 13.0),
                make_shot(2, 300.0, 305.0, 9.0, 13.0, 16.0),
            ]),
        ];

        let suggestions = suggest_placements(&import_shots, &existing, &PlacementSuggestionConfig::default());
        assert!(!suggestions.is_empty());
        assert_eq!(suggestions[0].existing_section_id, 2, "should match section 2");
    }

    #[test]
    fn confidence_tiers() {
        // Perfect match should be High confidence
        let import_shots = vec![
            make_shot_data(90.0, 90.0, 5.0, 3.0, 4.0),
            make_shot_data(45.0, 45.0, 3.0, 4.0, 4.5),
        ];
        let existing = vec![
            make_section(1, "Test", vec![
                make_shot(0, 90.0, 90.0, 5.0, 3.0, 4.0),
                make_shot(1, 45.0, 45.0, 3.0, 4.0, 4.5),
                make_shot(2, 180.0, 180.0, 10.0, 4.5, 10.0),
            ]),
        ];

        let suggestions = suggest_placements(&import_shots, &existing, &PlacementSuggestionConfig::default());
        assert!(!suggestions.is_empty());
        assert_eq!(suggestions[0].confidence, SuggestionConfidence::High);
    }

    #[test]
    fn single_shot_section_can_match() {
        let import_shots = vec![
            make_shot_data(90.0, 90.0, 5.0, 3.0, 4.0),
        ];
        let existing = vec![
            make_section(1, "Test", vec![
                make_shot(0, 90.0, 90.0, 5.0, 3.0, 4.0),
                make_shot(1, 45.0, 45.0, 3.0, 4.0, 4.5),
            ]),
        ];

        let suggestions = suggest_placements(&import_shots, &existing, &PlacementSuggestionConfig::default());
        // A single matching shot should still produce a suggestion, but penalized
        assert!(!suggestions.is_empty(), "single shot should still match");
        assert!(suggestions[0].score < 0.7, "single shot should be penalized, got {}", suggestions[0].score);
    }

    #[test]
    fn length_deviation_does_not_become_partial_in_integration() {
        let import_shots = vec![
            make_shot_data(90.0, 90.0, 5.0, 3.0, 4.0),
            make_shot_data(45.0, 45.0, 0.6, 4.0, 4.1),
        ];
        let existing = vec![
            make_section(1, "Test", vec![
                make_shot(0, 90.0, 90.0, 5.0, 3.0, 4.0),
                make_shot(1, 45.0, 45.0, 3.0, 4.0, 4.5),
            ]),
        ];

        let suggestions = suggest_placements(&import_shots, &existing, &PlacementSuggestionConfig::default());
        assert!(!suggestions.is_empty());
        let best = &suggestions[0];
        assert!(!best.is_partial, "partial matches should not be emitted");
        assert_eq!(best.matched_shots, 1);
    }

    #[test]
    fn multi_shot_length_mismatch_is_rejected_even_when_azimuths_match() {
        let import_shots = vec![
            make_shot_data(275.3, 285.2, 0.95, 21.40, 21.20),
            make_shot_data(263.6, 262.7, 3.02, 21.17, 21.63),
        ];
        let existing = vec![
            make_section(1, "AA1", vec![
                make_shot(0, 300.0, 291.1, 2.23, 21.43, 21.70),
                make_shot(1, 269.9, 271.3, 4.47, 21.67, 21.49),
            ]),
        ];

        let suggestions = suggest_placements(&import_shots, &existing, &PlacementSuggestionConfig::default());

        assert!(
            suggestions.is_empty(),
            "AA2-style length mismatch should not be a valid candidate: {suggestions:?}",
        );
    }

    #[test]
    fn length_tolerance_scales_with_matched_shot_count() {
        let config = SuggestionConfig::default();
        let existing = vec![
            MatchShot { avg_azimuth: 90.0, length: 20.0, depth_in: 3.0, depth_out: 4.0 },
            MatchShot { avg_azimuth: 45.0, length: 20.0, depth_in: 4.0, depth_out: 5.0 },
            MatchShot { avg_azimuth: 120.0, length: 20.0, depth_in: 5.0, depth_out: 6.0 },
        ];

        let single_import = vec![
            MatchShot { length: 20.9, ..existing[0] },
        ];
        let single = try_match_sequence(&single_import, &existing, 0, MatchDirection::Forward, &config);
        assert_eq!(single.matched_count, 0, "single-shot match should keep the strict 3% length gate");

        let two_import = vec![
            MatchShot { length: 20.9, ..existing[0] },
            MatchShot { length: 20.9, ..existing[1] },
        ];
        let two = try_match_sequence(&two_import, &existing, 0, MatchDirection::Forward, &config);
        assert_eq!(two.matched_count, 2, "two-shot match should allow a 5%-class length error");

        let too_loose_for_two = vec![
            MatchShot { length: 21.2, ..existing[0] },
            MatchShot { length: 21.2, ..existing[1] },
        ];
        let rejected_two = try_match_sequence(&too_loose_for_two, &existing, 0, MatchDirection::Forward, &config);
        assert_eq!(rejected_two.matched_count, 0, "two-shot match should still reject a 7%-class length error");

        let three_import = vec![
            MatchShot { length: 21.2, ..existing[0] },
            MatchShot { length: 21.2, ..existing[1] },
            MatchShot { length: 21.2, ..existing[2] },
        ];
        let three = try_match_sequence(&three_import, &existing, 0, MatchDirection::Forward, &config);
        assert_eq!(three.matched_count, 3, "three-shot match should allow a 7%-class length error");
    }

    // ========================================================================
    // Hard cutoff boundary tests
    // ========================================================================

    #[test]
    fn full_shot_azimuth_cutoff_boundary() {
        let config = SuggestionConfig::default();
        let base = MatchShot { avg_azimuth: 90.0, length: 5.0, depth_in: 3.0, depth_out: 4.0 };

        // 24.9° — just under cutoff (max_azimuth_error_full=25.0), should pass
        let import_pass = MatchShot { avg_azimuth: 90.0 + 24.9, ..base };
        let score = compute_shot_score(&import_pass, &base, MatchDirection::Forward, &config);
        assert!(score > 0.0, "24.9° azimuth error should pass cutoff, got {score}");

        // 25.1° — just over cutoff, should be rejected
        let import_fail = MatchShot { avg_azimuth: 90.0 + 25.1, ..base };
        let score = compute_shot_score(&import_fail, &base, MatchDirection::Forward, &config);
        assert!(score == 0.0, "25.1° azimuth error should be hard-rejected, got {score}");
    }

    #[test]
    fn full_shot_length_cutoff_boundary() {
        let config = SuggestionConfig::default();
        let existing = MatchShot { avg_azimuth: 90.0, length: 5.0, depth_in: 3.0, depth_out: 4.0 };

        let import_pass = MatchShot { length: 5.39, ..existing };
        let score = compute_shot_score(&import_pass, &existing, MatchDirection::Forward, &config);
        assert!(score > 0.0, "0.39m length error should pass cutoff, got {score}");

        let import_fail = MatchShot { length: 5.41, ..existing };
        let score = compute_shot_score(&import_fail, &existing, MatchDirection::Forward, &config);
        assert!(score == 0.0, "0.41m length error should be hard-rejected, got {score}");
    }

    #[test]
    fn depth_cutoff_boundary() {
        let config = SuggestionConfig::default();
        let base = MatchShot { avg_azimuth: 90.0, length: 5.0, depth_in: 3.0, depth_out: 4.0 };

        // 0.49m depth_in error — just under cutoff (max_depth_error=0.50)
        let import_pass = MatchShot { depth_in: 3.49, ..base };
        let score = compute_shot_score(&import_pass, &base, MatchDirection::Forward, &config);
        assert!(score > 0.0, "0.49m depth error should pass cutoff, got {score}");

        // 0.51m depth_in error — just over cutoff
        let import_fail = MatchShot { depth_in: 3.51, ..base };
        let score = compute_shot_score(&import_fail, &base, MatchDirection::Forward, &config);
        assert!(score == 0.0, "0.51m depth error should be hard-rejected, got {score}");
    }

    #[test]
    fn length_cutoff_uses_floor_for_short_shots() {
        let config = SuggestionConfig::default();
        // Short existing shot (2.0m): 3% = 0.06m, but floor is 0.4m
        let existing = MatchShot { avg_azimuth: 90.0, length: 2.0, depth_in: 3.0, depth_out: 4.0 };

        // 0.39m error — under the 0.4m floor
        let import_pass = MatchShot { length: 2.39, ..existing };
        let score = compute_shot_score(&import_pass, &existing, MatchDirection::Forward, &config);
        assert!(score > 0.0, "0.39m length error should pass floor cutoff, got {score}");

        // 0.41m error — over the 0.4m floor
        let import_fail = MatchShot { length: 2.41, ..existing };
        let score = compute_shot_score(&import_fail, &existing, MatchDirection::Forward, &config);
        assert!(score == 0.0, "0.41m length error should be hard-rejected by floor, got {score}");
    }

    #[test]
    fn length_cutoff_scales_for_long_shots() {
        let config = SuggestionConfig::default();
        // Long existing shot (20.0m): 3% = 0.6m > 0.4m floor
        let existing = MatchShot { avg_azimuth: 90.0, length: 20.0, depth_in: 3.0, depth_out: 4.0 };

        // 0.59m error — under the 0.6m (3%) cutoff
        let import_pass = MatchShot { length: 20.59, ..existing };
        let score = compute_shot_score(&import_pass, &existing, MatchDirection::Forward, &config);
        assert!(score > 0.0, "0.59m length error should pass 3% cutoff for 20m shot, got {score}");

        // 0.61m error — over the 0.6m (3%) cutoff
        let import_fail = MatchShot { length: 20.61, ..existing };
        let score = compute_shot_score(&import_fail, &existing, MatchDirection::Forward, &config);
        assert!(score == 0.0, "0.61m length error should be hard-rejected by 3% cutoff, got {score}");
    }

    #[test]
    fn deduplication_keeps_best_score() {
        // Two sequences might match the same position — should keep only the best
        let import_shots = vec![
            make_shot_data(90.0, 90.0, 5.0, 3.0, 4.0),
        ];
        let existing = vec![
            make_section(1, "Test", vec![
                make_shot(0, 90.0, 90.0, 5.0, 3.0, 4.0),
            ]),
        ];

        let suggestions = suggest_placements(&import_shots, &existing, &PlacementSuggestionConfig::default());
        // Should not have duplicate entries for the same position
        let count = suggestions
            .iter()
            .filter(|s| {
                s.existing_section_id == 1
                    && s.existing_station_index == 0
                    && s.import_station_index == 0
                    && s.direction == MatchDirection::Forward
            })
            .count();
        assert!(count <= 1, "should not have duplicate suggestions");
    }

    #[test]
    fn equivalent_single_front_reverse_is_suppressed() {
        let forward = PlacementSuggestion {
            existing_section_id: 1,
            existing_station_index: 10,
            import_station_index: 0,
            score: 0.580,
            matched_shots: 1,
            existing_matched_shots: 1,
            preferred_merge_offset: 1,
            direction: MatchDirection::Forward,
            is_partial: false,
            confidence: SuggestionConfidence::Low,
            existing_section_name: "AA1".to_string(),
        };
        let reverse = PlacementSuggestion {
            existing_section_id: 1,
            existing_station_index: 11,
            import_station_index: 0,
            score: 0.581,
            matched_shots: 1,
            existing_matched_shots: 1,
            preferred_merge_offset: 1,
            direction: MatchDirection::Reverse,
            is_partial: true,
            confidence: SuggestionConfidence::Low,
            existing_section_name: "AA1".to_string(),
        };
        let mut suggestions = vec![reverse, forward.clone()];

        suppress_equivalent_single_front_reverses(&mut suggestions);

        assert_eq!(suggestions.len(), 1);
        assert_eq!(suggestions[0].direction, MatchDirection::Forward);
        assert_eq!(suggestions[0].existing_station_index, forward.existing_station_index);
    }

    #[test]
    fn duplicate_endpoint_pairs_keep_best_score() {
        let forward = PlacementSuggestion {
            existing_section_id: 1,
            existing_station_index: 10,
            import_station_index: 0,
            score: 0.8,
            matched_shots: 2,
            existing_matched_shots: 2,
            preferred_merge_offset: 2,
            direction: MatchDirection::Forward,
            is_partial: false,
            confidence: SuggestionConfidence::Medium,
            existing_section_name: "AA1".to_string(),
        };
        let reverse = PlacementSuggestion {
            existing_section_id: 1,
            existing_station_index: 12,
            import_station_index: 0,
            score: 0.9,
            matched_shots: 2,
            existing_matched_shots: 2,
            preferred_merge_offset: 2,
            direction: MatchDirection::Reverse,
            is_partial: false,
            confidence: SuggestionConfidence::High,
            existing_section_name: "AA1".to_string(),
        };
        let mut suggestions = vec![forward, reverse.clone()];

        suppress_duplicate_endpoint_pairs(&mut suggestions);

        assert_eq!(suggestions.len(), 1);
        assert_eq!(suggestions[0].direction, MatchDirection::Reverse);
        assert_eq!(suggestions[0].score, reverse.score);
    }
}
