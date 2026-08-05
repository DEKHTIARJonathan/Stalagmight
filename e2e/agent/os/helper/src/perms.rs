//! TCC permission preflights.
//!
//! Both are read-only: they report the grant state and never raise a system
//! prompt, so `preflight` is safe to run from a build gate.
//!
//! The grant is attributed to the RESPONSIBLE process, which for a CLI is
//! whatever spawned it (Terminal, iTerm, the editor running the MCP server) -
//! never this binary. Rebuilding the helper therefore does not invalidate a
//! grant, and granting the helper itself is not a thing a user can do.

use core_graphics::access::ScreenCaptureAccess;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    /// `Boolean AXIsProcessTrusted(void)` - true when the responsible process
    /// is in System Settings > Privacy & Security > Accessibility. Does not
    /// prompt (that is `AXIsProcessTrustedWithOptions`).
    fn AXIsProcessTrusted() -> u8;
}

pub struct Permissions {
    pub accessibility: bool,
    pub screen_recording: bool,
}

pub fn preflight() -> Permissions {
    Permissions {
        accessibility: accessibility(),
        screen_recording: ScreenCaptureAccess.preflight(),
    }
}

pub fn accessibility() -> bool {
    // SAFETY: no arguments, no out-params; returns a C Boolean by value.
    unsafe { AXIsProcessTrusted() != 0 }
}

/// Message for the refusal path. Posting CGEvents without Accessibility does
/// not error: the events are silently dropped, which downstream reads as "the
/// app ignored the click". Refusing up front is the difference between a
/// diagnosable failure and a false negative.
pub const ACCESSIBILITY_DENIED: &str = concat!(
    "Accessibility permission is not granted, so posted input events would be ",
    "silently dropped. Grant it to the app that runs this helper (your terminal ",
    "or editor) in System Settings > Privacy & Security > Accessibility, then ",
    "restart that app."
);
