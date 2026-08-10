//! Which north an Ariane document declares, and what that costs (#438).
//!
//! Split out of `tml.rs` to keep that file under the size ratchet; it is one
//! decision, and the export's only choice that can change a NUMBER rather than
//! a label.

use crate::models::{AzimuthReference, CorrectionSource, NorthReference, Project, Section};

/// How this document declares its azimuths (#438).
///
/// The flag `useMagneticAzimuth` is file-level and the project's references are
/// per section, so the three answers are: the sections agree on magnetic (write
/// the readings, flag true), they agree on true north (write them, flag false),
/// or they disagree - and then the only honest single-flag document is one where
/// every bearing has been rotated into true north on the way out.
///
/// ## An UNKNOWN correction is not a competing declaration
///
/// [`CorrectionSource::Unknown`] means "no correction is on record", not "a
/// correction of exactly zero" - it is what a `.dmp` and a georeference-less
/// `.tml` get, because the device is a compass and nothing in the file says how
/// far off north it read. A section like that is raw magnetic, which is exactly
/// what `useMagneticAzimuth=true` says, so it constrains the document to be
/// magnetic and otherwise votes on nothing.
///
/// Counting it as "correction 0" instead made the common case mixed: import an
/// IGRF-corrected `.tml` alongside `.dmp` files from the same cave and every
/// bearing in the export would be rewritten and the file declared true north -
/// baking OUR zero into the `.dmp` sections permanently, and asserting about
/// them the one thing we know is false. Handing Ariane the readings and letting
/// it apply its own declination is both the honest document and the stable one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum AzimuthExport {
    /// Every DECLARED section is magnetic with one correction, and any
    /// undeclared section is raw magnetic too: emit the readings untouched and
    /// let Ariane apply its own declination.
    Magnetic,
    /// Every section is already true north: emit untouched, flag false.
    TrueAsStored,
    /// The sections disagree. Apply each section's correction so the file is
    /// uniformly true north, and flag false.
    MixedToTrue,
}

impl AzimuthExport {
    pub(super) fn decide(project: &Project) -> Self {
        let references = || {
            project
                .sections
                .iter()
                .filter(|section| !section.shots.is_empty())
                .map(|section| project.azimuth_reference_for(section))
        };

        // Raw magnetic readings with nothing declared about them. They cannot
        // make a document mixed, but they can only ride in a magnetic one.
        let undeclared_magnetic = references()
            .any(|r| r.source == CorrectionSource::Unknown && r.north == NorthReference::Magnetic);
        let mut declared = references().filter(|r| r.source != CorrectionSource::Unknown);

        // Nothing declared at all - every existing project, and the historical
        // declaration this must keep producing.
        let Some(first) = declared.next() else {
            return AzimuthExport::Magnetic;
        };
        // Corrections come from the same file-level source, so this is an
        // identity test, not a tolerance: the epsilon only keeps a last-bit
        // difference from routing an otherwise uniform project down the
        // rewrite-every-azimuth path.
        let uniform = declared.all(|r| {
            r.north == first.north
                && (r.applied_correction() - first.applied_correction()).abs() < 1e-12
        });
        if !uniform {
            return AzimuthExport::MixedToTrue;
        }
        match first.north {
            // A true-north declaration and a raw magnetic section cannot share
            // one flag: whichever it names is a false claim about the other.
            NorthReference::True if undeclared_magnetic => AzimuthExport::MixedToTrue,
            NorthReference::True => AzimuthExport::TrueAsStored,
            NorthReference::Magnetic => AzimuthExport::Magnetic,
            // Grid bearings are neither: declaring them magnetic would have
            // Ariane add a declination to a grid azimuth, and declaring them
            // true would keep the meridian convergence in. Rotate them out.
            NorthReference::Grid => AzimuthExport::MixedToTrue,
        }
    }

    pub(super) fn is_magnetic(self) -> bool {
        matches!(self, AzimuthExport::Magnetic)
    }

    /// The reference to push each of `section`'s azimuths through on the way
    /// out. Identity except on the mixed path, so an ordinary export is
    /// byte-for-byte what it always was.
    pub(super) fn emit_reference(self, project: &Project, section: &Section) -> AzimuthReference {
        match self {
            AzimuthExport::MixedToTrue => project.azimuth_reference_for(section),
            _ => AzimuthReference::default(),
        }
    }
}
