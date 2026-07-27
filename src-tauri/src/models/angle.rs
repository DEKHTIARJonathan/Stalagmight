//! The canonical wrap for a bearing this crate COMPUTES (issue #24).
//!
//! Scope: every azimuth the backend *derives* - a circular mean, a reciprocal,
//! an `atan2` of a solved displacement, a parsed reading being canonicalised.
//! It is deliberately NOT "the single wrap for every stored bearing": the shot
//! table stores raw user input on purpose (`ShotTableEditor.tsx` passes
//! `{ normalize: false }`), and `src/utils/validation.ts` plus `ImportDialog.tsx`
//! keep their own mirrors. Those are separate contracts, not clients of this one.

/// Wrap an azimuth in degrees into `[0, 360)`.
///
/// `f64::rem_euclid` alone is NOT enough, and the gap is reachable with ordinary
/// data rather than a crafted ulp. `rem_euclid` computes `r = self - (self /
/// rhs).trunc() * rhs` and then adds `rhs` when `r` is negative, so for a tiny
/// negative input the addend ROUNDS and the result is exactly `360.0`:
/// `(-1e-14f64).rem_euclid(360.0) == 360.0`. The ordinary route in is
/// [`average_azimuth_of`](crate::models::average_azimuth_of): every fore/back
/// pair whose circular mean is exactly north lands there, and there are 360 such
/// pairs on a plain 0.1-degree grid - `(0.1, 359.9)`, `(0.3, 359.7)`, and so on.
/// `atan2` writers reach it too (`(-1e-16f64).atan2(1.0)` in degrees wraps to
/// `360.0`).
///
/// `360.0` is not a harmless representation of north. It is `>= 360.0`, so it
/// trips `INVALID_AZIMUTH`, which `warning_is_ignorable` refuses to suppress
/// because it is [`WarningSeverity::Error`](crate::models::WarningSeverity) -
/// the user cannot dismiss it, only normalise it away by hand.
///
/// A non-finite reading has no canonical form and passes through untouched
/// (`rem_euclid` would turn an infinity into NaN); `ShotData::all_finite` and
/// the integrity banner are what surface those.
///
/// The `+ 0.0` maps `-0.0` to `+0.0`, so the output never serialises as `-0`.
#[inline]
#[must_use]
pub fn normalize_azimuth(degrees: f64) -> f64 {
    if !degrees.is_finite() {
        return degrees;
    }
    let wrapped = degrees.rem_euclid(360.0);
    if wrapped >= 360.0 {
        0.0
    } else {
        wrapped + 0.0
    }
}

#[cfg(test)]
#[expect(
    clippy::float_cmp,
    reason = "test module: the exact boundary is the whole point"
)]
mod tests {
    use super::*;

    /// Pins the precondition this helper exists for: the bare `rem_euclid` that
    /// every call site used before #24 really can return exactly `360.0`.
    #[test]
    fn rem_euclid_alone_can_return_exactly_360() {
        assert_eq!((-1e-14f64).rem_euclid(360.0), 360.0);
        assert_eq!(normalize_azimuth(-1e-14), 0.0);
    }

    #[test]
    fn output_is_always_in_range_and_never_negative_zero() {
        let cases: [(f64, f64); 10] = [
            (0.0, 0.0),
            (-0.0, 0.0),
            (360.0, 0.0),
            (-360.0, 0.0),
            (720.0, 0.0),
            (-1e-300, 0.0),
            (-1e-14, 0.0),
            (359.9, 359.9),
            (-90.0, 270.0),
            (f64::MAX, 128.0),
        ];
        for (input, expected) in cases {
            let actual = normalize_azimuth(input);
            assert_eq!(actual, expected, "normalize_azimuth({input})");
            assert!(
                (0.0..360.0).contains(&actual),
                "normalize_azimuth({input}) = {actual} escaped [0, 360)"
            );
            assert!(
                actual.is_sign_positive(),
                "normalize_azimuth({input}) returned negative zero"
            );
        }
    }

    #[test]
    fn non_finite_passes_through() {
        assert!(normalize_azimuth(f64::NAN).is_nan());
        assert_eq!(normalize_azimuth(f64::INFINITY), f64::INFINITY);
        assert_eq!(normalize_azimuth(f64::NEG_INFINITY), f64::NEG_INFINITY);
    }
}
