//! The north reference an Ariane file declares (#438).
//!
//! Split out of `mod.rs` only to keep that file under the size ratchet; it is
//! one decision and its receipt line.

use chrono::{Datelike, Utc};

use crate::models::{AzimuthReference, CorrectionSource};

use super::TmlFile;

/// The north reference to record on every section of this file (#438), plus the
/// receipt line that says what was recorded and why.
///
/// One reference per FILE, not per section: `useMagneticAzimuth` is a file-level
/// flag in this format, unlike Compass, where the declination is per survey.
///
/// The magnetic case wants a declination, and the reproducible source is the
/// IGRF model already bundled for the Compass "auto" mode
/// ([`crate::parsers::geo::igrf_declination`]), evaluated at the file's
/// georeference on the earliest date the file records. A file with no
/// `<GeoCoding>`, or a date the model does not span, gets a ZERO correction and
/// a receipt line saying so - never a guess.
pub(super) fn tml_azimuth_reference(tml: &TmlFile, warnings: &mut Vec<String>) -> AzimuthReference {
    if !tml.use_magnetic_azimuth {
        warnings.push(
            "The file declares true-north azimuths (useMagneticAzimuth=false); recorded a \
             true-north reference with no declination correction."
                .to_string(),
        );
        return AzimuthReference::true_north(CorrectionSource::FileDeclared);
    }

    // Earliest dated section: the earliest survey date this format records, and
    // the one the declination should be evaluated at. An undated file falls back
    // to today, which the model may refuse - handled below like any other
    // failure. The epoch is stored with the value either way, so the number
    // stays reproducible and explainable.
    let (epoch_date, dated) = tml
        .sections
        .iter()
        .filter_map(|section| section.date)
        .min()
        .map_or_else(|| (Utc::now().date_naive(), false), |date| (date, true));
    let epoch_year = epoch_date.year();

    let Some(geo) = tml.geo_coding.as_ref() else {
        warnings.push(
            "The file declares magnetic azimuths (useMagneticAzimuth=true) but carries no \
             georeference, so no declination could be computed. Azimuths were imported exactly \
             as measured, with a 0.0 degree correction - bearings will read as magnetic until a \
             declination is set."
                .to_string(),
        );
        return AzimuthReference::magnetic(0.0, CorrectionSource::Unknown);
    };

    match crate::parsers::geo::igrf_declination(geo.latitude, geo.longitude, epoch_date) {
        Ok(declination) if declination.is_finite() => {
            warnings.push(format!(
                "The file declares magnetic azimuths; recorded a declination of \
                 {declination:.2} degrees (IGRF at {lat:.4}, {lon:.4}, {epoch_date}). Stored \
                 azimuths are unchanged - the correction is applied when geometry is computed.",
                lat = geo.latitude,
                lon = geo.longitude
            ));
            AzimuthReference::magnetic(declination, CorrectionSource::IgrfAuto { epoch_year })
        }
        Ok(_) => {
            warnings.push(
                "The file declares magnetic azimuths, but the geomagnetic model returned a \
                 non-finite declination; azimuths were imported exactly as measured, with a 0.0 \
                 degree correction."
                    .to_string(),
            );
            AzimuthReference::magnetic(0.0, CorrectionSource::Unknown)
        }
        Err(reason) => {
            let dated_note = if dated {
                format!("the file's earliest survey date ({epoch_date})")
            } else {
                format!("today's date ({epoch_date}), as the file carries no survey date")
            };
            warnings.push(format!(
                "The file declares magnetic azimuths and is georeferenced ({lat:.4}, {lon:.4}), \
                 but the declination could not be computed for {dated_note}: {reason}. Azimuths \
                 were imported exactly as measured, with a 0.0 degree correction.",
                lat = geo.latitude,
                lon = geo.longitude
            ));
            AzimuthReference::magnetic(0.0, CorrectionSource::Unknown)
        }
    }
}
