# Local modifications

This is a vendored fork of [`compass_data`](https://github.com/zheylmun/compass_data)
v0.0.7 by Zach Heylmun, used under its MIT OR Apache-2.0 license (see
`LICENSE-MIT` / `LICENSE-APACHE`). It is embedded in Stalagmight as a path
dependency so we can carry fixes the upstream release lacks.

Changes from upstream v0.0.7:

- **`Shot`**: added `back_azimuth` / `back_inclination: Option<f64>`. The shot
  parser now captures redundant backsight columns (when the survey format
  declares them) and the trailing `#|FLAGS#` token and free-form comment, instead
  of discarding the rest of the line. `Shot.flags` / `Shot.comment` are therefore
  populated.
- **`survey::parser`**: `parse_shot` takes a `has_backsights` flag (derived from
  the survey format) so backsight columns aren't mis-read as comment text; added
  `split_flags_and_comment`.
- **`SurveyFormat`**: added public accessors `has_backsights()`, `length_units()`,
  `inclination_units()` so consumers can interpret units.
- **`project::Station`**: `name` / `location` fields made public so consumers can
  resolve georeference anchors from the `.MAK` link stations.

These should be contributed upstream where appropriate.
