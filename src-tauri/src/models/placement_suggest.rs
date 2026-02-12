use serde::{Deserialize, Serialize};
use ts_rs::TS;

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
        let existing_suggestions = suggest_placements(&import.shots, existing_sections);
        for s in existing_suggestions {
            all.push(CrossSectionSuggestion {
                existing_station_index: s.existing_station_index,
                import_station_index: s.import_station_index,
                score: s.score,
                matched_shots: s.matched_shots,
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
            let import_suggestions = suggest_placements(&import.shots, &other_imports);
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
    /// Minimum partial shot length ratio.
    min_partial_ratio: f64,
    /// Short shot threshold (meters) — shots below this get reduced weight.
    short_shot_threshold: f64,
    /// Penalty multiplier for single-shot matches (0.0–1.0).
    single_shot_penalty: f64,
    /// Hard cutoff: max azimuth error for full shots (degrees).
    max_azimuth_error_full: f64,
    /// Hard cutoff: max azimuth error for partial shots (degrees).
    max_azimuth_error_partial: f64,
    /// Hard cutoff: max depth error per measurement point (meters).
    max_depth_error: f64,
    /// Length error fraction for dynamic cutoff.
    max_length_error_fraction: f64,
    /// Length error floor for dynamic cutoff (meters).
    max_length_error_floor: f64,
}

impl Default for SuggestionConfig {
    fn default() -> Self {
        Self {
            azimuth_sigma: 18.0,
            length_sigma: 0.8,
            depth_sigma: 0.35,
            azimuth_weight: 0.35,
            length_weight: 0.25,
            depth_in_weight: 0.20,
            depth_out_weight: 0.20,
            min_shot_score: 0.15,
            min_aggregate_score: 0.45,
            max_reference_shots: 5,
            max_suggestions: 10,
            min_partial_ratio: 0.15,
            short_shot_threshold: 0.5,
            single_shot_penalty: 0.6,
            max_azimuth_error_full: 25.0,
            max_azimuth_error_partial: 35.0,
            max_depth_error: 0.50,
            max_length_error_fraction: 0.15,
            max_length_error_floor: 2.0,
        }
    }
}

/// Minimal shot data needed for matching.
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

    fn depth_change(&self) -> f64 {
        self.depth_out - self.depth_in
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

/// Dynamic length cutoff: 5% of existing length, floored at 0.6m.
fn max_length_error(existing_length: f64, config: &SuggestionConfig) -> f64 {
    (config.max_length_error_fraction * existing_length).max(config.max_length_error_floor)
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

/// Try partial match: import shot covers only part of existing shot.
/// Returns `Some((score, length_ratio))` if partial match detected,
/// trying both same-direction and opposite-direction.
fn try_partial_match(
    import: &MatchShot,
    existing: &MatchShot,
    direction: MatchDirection,
    config: &SuggestionConfig,
) -> Option<(f64, f64)> {
    // Determine the effective existing shot in the match direction
    let (eff_length, eff_depth_in, eff_depth_out, eff_az) = match direction {
        MatchDirection::Forward => (
            existing.length,
            existing.depth_in,
            existing.depth_out,
            existing.avg_azimuth,
        ),
        MatchDirection::Reverse => (
            existing.length,
            existing.depth_out,
            existing.depth_in,
            (existing.avg_azimuth + 180.0) % 360.0,
        ),
    };

    if import.length >= eff_length {
        return None;
    }
    let length_ratio = import.length / eff_length;
    if length_ratio < config.min_partial_ratio {
        return None;
    }

    // Try same-direction partial
    let same_score = try_partial_one_direction(
        import,
        eff_az,
        eff_length,
        eff_depth_in,
        eff_depth_out,
        length_ratio,
        config,
    );

    // Try opposite-direction partial (surveyor turned around partway)
    let opp_import = import.reversed();
    let opp_score = try_partial_one_direction(
        &opp_import,
        eff_az,
        eff_length,
        eff_depth_in,
        eff_depth_out,
        length_ratio,
        config,
    );

    let best_score = same_score.max(opp_score);
    if best_score >= config.min_shot_score {
        Some((best_score, length_ratio))
    } else {
        None
    }
}

/// Score a partial match in one direction (helper).
fn try_partial_one_direction(
    import: &MatchShot,
    eff_az: f64,
    eff_length: f64,
    eff_depth_in: f64,
    eff_depth_out: f64,
    length_ratio: f64,
    config: &SuggestionConfig,
) -> f64 {
    let az_error = angular_difference(import.avg_azimuth, eff_az);

    // Depth_in should match the start of the existing shot
    let depth_in_error = (import.depth_in - eff_depth_in).abs();

    // Depth proportionality check
    let eff_dz = eff_depth_out - eff_depth_in;
    let import_dz = import.depth_change();
    let expected_dz = eff_dz * length_ratio;
    let dz_error = (import_dz - expected_dz).abs();

    // Hard cutoffs — relaxed azimuth threshold for partial matches,
    // no length cutoff (surveyor's stopping point is arbitrary)
    if az_error > config.max_azimuth_error_partial
        || depth_in_error > config.max_depth_error
        || dz_error > config.max_depth_error
    {
        return 0.0;
    }

    let az_score = gaussian(az_error, config.azimuth_sigma);
    let depth_in_score = gaussian(depth_in_error, config.depth_sigma);
    let dz_score = gaussian(dz_error, config.depth_sigma);

    // Length doesn't carry signal for partial matches — the surveyor stopped at
    // an arbitrary point, so length_ratio is definitional, not diagnostic.
    let len_score = 1.0;

    config.azimuth_weight * az_score
        + config.length_weight * len_score
        + config.depth_in_weight * depth_in_score
        + config.depth_out_weight * dz_score
}

/// Result of trying to match a sequence of import shots against existing shots.
struct SequenceMatch {
    score: f64,
    matched_count: usize,
    is_partial: bool,
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
        return SequenceMatch { score: 0.0, matched_count: 0, is_partial: false };
    }

    let mut total_weight = 0.0;
    let mut weighted_score = 0.0;
    let mut matched = 0;
    let mut is_partial = false;

    for (i, import_shot) in import_shots.iter().enumerate() {
        let existing_idx = match direction {
            MatchDirection::Forward => start_idx + i,
            MatchDirection::Reverse => {
                if start_idx < i {
                    break;
                }
                start_idx - i
            }
        };

        if existing_idx >= existing_shots.len() {
            break;
        }

        let existing_shot = &existing_shots[existing_idx];
        let is_last_import = i == import_shots.len() - 1;

        let full_score = compute_shot_score(import_shot, existing_shot, direction, config);

        // For the last import shot, also try partial match if import is shorter
        let partial_result = if is_last_import {
            try_partial_match(import_shot, existing_shot, direction, config)
        } else {
            None
        };

        // Decide between full and partial match
        let use_partial = match partial_result {
            Some((partial_score, _)) if partial_score > full_score => true,
            Some(_) if full_score < config.min_shot_score => true,
            _ => full_score < config.min_shot_score,
        };

        if use_partial {
            if let Some((partial_score, length_ratio)) = partial_result {
                let weight = length_ratio
                    * if import_shot.length < config.short_shot_threshold {
                        import_shot.length / config.short_shot_threshold
                    } else {
                        1.0
                    };
                weighted_score += partial_score * weight;
                total_weight += weight;
                matched += 1;
                is_partial = true;
            }
            // Stop extending after last shot or failed match
            break;
        } else if full_score >= config.min_shot_score {
            let weight = if import_shot.length < config.short_shot_threshold {
                import_shot.length / config.short_shot_threshold
            } else {
                1.0
            };
            weighted_score += full_score * weight;
            total_weight += weight;
            matched += 1;
        } else {
            // Full match failed and no partial — stop
            break;
        }
    }

    if matched == 0 || total_weight == 0.0 {
        return SequenceMatch { score: 0.0, matched_count: 0, is_partial: false };
    }

    let raw_score = weighted_score / total_weight;
    let match_bonus = 1.0 + 0.15 * total_weight.ln();
    let single_penalty = if matched == 1 { config.single_shot_penalty } else { 1.0 };
    let final_score = raw_score * match_bonus.max(1.0) * single_penalty;

    SequenceMatch {
        score: final_score,
        matched_count: matched,
        is_partial,
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
) -> Vec<PlacementSuggestion> {
    let config = &SuggestionConfig::default();

    if import_shots.is_empty() || existing_sections.is_empty() {
        return Vec::new();
    }

    let max_ref = config.max_reference_shots.min(import_shots.len());

    // Build import match shots for station 0 (first N shots, natural order)
    let import_from_0: Vec<MatchShot> = import_shots[..max_ref]
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

                    let confidence = if result.score >= 0.90 {
                        SuggestionConfidence::High
                    } else if result.score >= 0.70 {
                        SuggestionConfidence::Medium
                    } else {
                        SuggestionConfidence::Low
                    };

                    // Check for duplicates
                    let is_dup = suggestions.iter().any(|s| {
                        s.existing_section_id == existing.id
                            && s.existing_station_index == existing_station_index
                            && s.import_station_index == import_station
                            && s.direction == direction
                    });
                    if is_dup {
                        // Keep the better score
                        if let Some(existing_suggestion) = suggestions.iter_mut().find(|s| {
                            s.existing_section_id == existing.id
                                && s.existing_station_index == existing_station_index
                                && s.import_station_index == import_station
                                && s.direction == direction
                        }) {
                            if result.score > existing_suggestion.score {
                                existing_suggestion.score = result.score;
                                existing_suggestion.matched_shots = result.matched_count;
                                existing_suggestion.is_partial = result.is_partial;
                                existing_suggestion.confidence = confidence;
                            }
                        }
                        continue;
                    }

                    suggestions.push(PlacementSuggestion {
                        existing_section_id: existing.id,
                        existing_station_index,
                        import_station_index: import_station,
                        score: result.score,
                        matched_shots: result.matched_count,
                        direction,
                        is_partial: result.is_partial,
                        confidence,
                        existing_section_name: existing.name.clone(),
                    });
                }
            }
        }
    }

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

    // ========================================================================
    // Partial match tests
    // ========================================================================

    #[test]
    fn partial_match_shorter_import() {
        let config = SuggestionConfig::default();
        // Import shot covers half of the existing shot
        let import = MatchShot {
            avg_azimuth: 90.0,
            length: 2.5,
            depth_in: 3.0,
            depth_out: 3.5, // half the depth change
        };
        let existing = MatchShot {
            avg_azimuth: 90.0,
            length: 5.0,
            depth_in: 3.0,
            depth_out: 4.0,
        };
        let result = try_partial_match(&import, &existing, MatchDirection::Forward, &config);
        assert!(result.is_some(), "should detect partial match");
        let (score, ratio) = result.unwrap();
        assert!((ratio - 0.5).abs() < 1e-6, "ratio should be 0.5, got {ratio}");
        assert!(score > 0.5, "partial match score should be reasonable, got {score}");
    }

    #[test]
    fn partial_match_too_short() {
        let config = SuggestionConfig::default();
        // Import shot is only 10% of existing — below min_partial_ratio (15%)
        let import = MatchShot {
            avg_azimuth: 90.0,
            length: 0.5,
            depth_in: 3.0,
            depth_out: 3.1,
        };
        let existing = MatchShot {
            avg_azimuth: 90.0,
            length: 5.0,
            depth_in: 3.0,
            depth_out: 4.0,
        };
        let result = try_partial_match(&import, &existing, MatchDirection::Forward, &config);
        assert!(result.is_none(), "too-short partial should not match");
    }

    #[test]
    fn partial_match_opposite_direction() {
        let config = SuggestionConfig::default();
        // Import shot is reversed (surveyor turned around partway)
        let import = MatchShot {
            avg_azimuth: 270.0, // 90 + 180
            length: 2.5,
            depth_in: 3.5,     // swapped
            depth_out: 3.0,
        };
        let existing = MatchShot {
            avg_azimuth: 90.0,
            length: 5.0,
            depth_in: 3.0,
            depth_out: 4.0,
        };
        let result = try_partial_match(&import, &existing, MatchDirection::Forward, &config);
        assert!(result.is_some(), "opposite-direction partial should match");
    }

    #[test]
    fn no_partial_when_import_longer() {
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
        let result = try_partial_match(&import, &existing, MatchDirection::Forward, &config);
        assert!(result.is_none(), "import longer than existing should not be partial");
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
    fn sequence_with_partial_last_shot() {
        let config = SuggestionConfig::default();
        let import = vec![
            MatchShot { avg_azimuth: 90.0, length: 5.0, depth_in: 3.0, depth_out: 4.0 },
            // Partial: 20% the length of existing[1] (0.6m vs 3.0m).
            // The large length error (2.4m / sigma=0.5) makes the full-match score
            // drop below min_shot_score, triggering partial detection.
            MatchShot { avg_azimuth: 45.0, length: 0.6, depth_in: 4.0, depth_out: 4.1 },
        ];
        let existing = vec![
            MatchShot { avg_azimuth: 90.0, length: 5.0, depth_in: 3.0, depth_out: 4.0 },
            MatchShot { avg_azimuth: 45.0, length: 3.0, depth_in: 4.0, depth_out: 4.5 },
        ];
        let result = try_match_sequence(&import, &existing, 0, MatchDirection::Forward, &config);
        assert_eq!(result.matched_count, 2);
        assert!(result.is_partial, "last shot should be partial");
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

        let suggestions = suggest_placements(&import_shots, &existing);
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

        let suggestions = suggest_placements(&import_shots, &existing);
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

        let suggestions = suggest_placements(&import_shots, &existing);

        // Should find a match from station N (= 4, last station)
        let station_n_suggestion = suggestions.iter().find(|s| s.import_station_index == 4);
        assert!(station_n_suggestion.is_some(), "should find match from station N; got suggestions: {:?}", suggestions.iter().map(|s| (s.import_station_index, s.existing_station_index, s.direction, s.score)).collect::<Vec<_>>());
    }

    #[test]
    fn no_suggestions_for_empty_project() {
        let import_shots = vec![
            make_shot_data(90.0, 90.0, 5.0, 3.0, 4.0),
        ];
        let suggestions = suggest_placements(&import_shots, &[]);
        assert!(suggestions.is_empty());
    }

    #[test]
    fn no_suggestions_for_empty_import() {
        let existing = vec![
            make_section(1, "Test", vec![
                make_shot(0, 90.0, 90.0, 5.0, 3.0, 4.0),
            ]),
        ];
        let suggestions = suggest_placements(&[], &existing);
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
        let suggestions = suggest_placements(&import_shots, &existing);
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

        let suggestions = suggest_placements(&import_shots, &existing);
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

        let suggestions = suggest_placements(&import_shots, &existing);
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

        let suggestions = suggest_placements(&import_shots, &existing);
        // A single matching shot should still produce a suggestion, but penalized
        assert!(!suggestions.is_empty(), "single shot should still match");
        assert!(suggestions[0].score < 0.7, "single shot should be penalized, got {}", suggestions[0].score);
    }

    #[test]
    fn partial_match_in_integration() {
        let import_shots = vec![
            make_shot_data(90.0, 90.0, 5.0, 3.0, 4.0),
            // Partial: 20% length of existing shot 1 — large length error ensures
            // full-match fails and partial detection kicks in
            make_shot_data(45.0, 45.0, 0.6, 4.0, 4.1),
        ];
        let existing = vec![
            make_section(1, "Test", vec![
                make_shot(0, 90.0, 90.0, 5.0, 3.0, 4.0),
                make_shot(1, 45.0, 45.0, 3.0, 4.0, 4.5),
            ]),
        ];

        let suggestions = suggest_placements(&import_shots, &existing);
        assert!(!suggestions.is_empty());
        let best = &suggestions[0];
        assert!(best.is_partial, "should detect partial match");
        assert_eq!(best.matched_shots, 2);
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
    fn partial_shot_azimuth_cutoff_boundary() {
        let config = SuggestionConfig::default();
        let existing_az = 90.0;
        let eff_length = 10.0;
        let length_ratio = 0.5;

        // 34.9° — just under partial cutoff
        let import_pass = MatchShot {
            avg_azimuth: existing_az + 34.9,
            length: eff_length * length_ratio,
            depth_in: 3.0,
            depth_out: 3.5,
        };
        let score = try_partial_one_direction(
            &import_pass, existing_az, eff_length, 3.0, 4.0, length_ratio, &config,
        );
        assert!(score > 0.0, "34.9° partial azimuth error should pass cutoff, got {score}");

        // 35.1° — just over partial cutoff
        let import_fail = MatchShot {
            avg_azimuth: existing_az + 35.1,
            length: eff_length * length_ratio,
            depth_in: 3.0,
            depth_out: 3.5,
        };
        let score = try_partial_one_direction(
            &import_fail, existing_az, eff_length, 3.0, 4.0, length_ratio, &config,
        );
        assert!(score == 0.0, "35.1° partial azimuth error should be hard-rejected, got {score}");
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
        // Short existing shot (2.0m): 15% = 0.3m, but floor is 2.0m
        let existing = MatchShot { avg_azimuth: 90.0, length: 2.0, depth_in: 3.0, depth_out: 4.0 };

        // 1.99m error — under the 2.0m floor
        let import_pass = MatchShot { length: 3.99, ..existing };
        let score = compute_shot_score(&import_pass, &existing, MatchDirection::Forward, &config);
        assert!(score > 0.0, "1.99m length error should pass floor cutoff, got {score}");

        // 2.01m error — over the 2.0m floor
        let import_fail = MatchShot { length: 4.01, ..existing };
        let score = compute_shot_score(&import_fail, &existing, MatchDirection::Forward, &config);
        assert!(score == 0.0, "2.01m length error should be hard-rejected by floor, got {score}");
    }

    #[test]
    fn length_cutoff_scales_for_long_shots() {
        let config = SuggestionConfig::default();
        // Long existing shot (20.0m): 15% = 3.0m > 2.0m floor
        let existing = MatchShot { avg_azimuth: 90.0, length: 20.0, depth_in: 3.0, depth_out: 4.0 };

        // 2.99m error — under the 3.0m (15%) cutoff
        let import_pass = MatchShot { length: 22.99, ..existing };
        let score = compute_shot_score(&import_pass, &existing, MatchDirection::Forward, &config);
        assert!(score > 0.0, "2.99m length error should pass 15% cutoff for 20m shot, got {score}");

        // 3.01m error — over the 3.0m (15%) cutoff
        let import_fail = MatchShot { length: 23.01, ..existing };
        let score = compute_shot_score(&import_fail, &existing, MatchDirection::Forward, &config);
        assert!(score == 0.0, "3.01m length error should be hard-rejected by 15% cutoff, got {score}");
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

        let suggestions = suggest_placements(&import_shots, &existing);
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
}
