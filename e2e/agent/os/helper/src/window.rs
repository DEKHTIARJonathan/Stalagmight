//! Window-list queries: which window is in front, and where a given pid's
//! window is on screen.
//!
//! `CGWindowListCopyWindowInfo` returns on-screen windows in front-to-back
//! order, so "frontmost" is just the first entry that survives filtering. Only
//! the owner name is read, never `kCGWindowName`: window TITLES require Screen
//! Recording, and quietly returning an empty title when it is denied is the
//! same false-evidence trap as a wallpaper screenshot.

use core_foundation::array::CFArray;
use core_foundation::base::{CFType, TCFType};
use core_foundation::dictionary::CFDictionary;
use core_foundation::number::CFNumber;
use core_foundation::string::{CFString, CFStringRef};
use core_graphics::window::{
    kCGNullWindowID, kCGWindowBounds, kCGWindowLayer, kCGWindowListExcludeDesktopElements,
    kCGWindowListOptionOnScreenOnly, kCGWindowNumber, kCGWindowOwnerName, kCGWindowOwnerPID,
    CGWindowListCopyWindowInfo,
};

type InfoDict = CFDictionary<CFType, CFType>;

pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

pub struct WindowInfo {
    pub window_id: i64,
    pub pid: i32,
    pub owner: String,
    pub bounds: Bounds,
}

/// On-screen, non-desktop windows, front to back.
fn on_screen_windows() -> Result<CFArray<InfoDict>, String> {
    // SAFETY: the create-rule wrap takes ownership of the +1 array cargo the
    // call returns; null is checked first.
    let array = unsafe {
        let raw = CGWindowListCopyWindowInfo(
            kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
            kCGNullWindowID,
        );
        if raw.is_null() {
            return Err("CGWindowListCopyWindowInfo returned no list".to_string());
        }
        CFArray::<InfoDict>::wrap_under_create_rule(raw)
    };
    Ok(array)
}

fn value(dict: &InfoDict, key: CFStringRef) -> Option<CFType> {
    // SAFETY: `key` is one of CoreGraphics' static CFString constants, alive
    // for the process lifetime; the get-rule wrap does not take ownership.
    let key = unsafe { CFString::wrap_under_get_rule(key) };
    dict.find(key.as_CFType()).map(|found| found.clone())
}

fn number(dict: &InfoDict, key: CFStringRef) -> Option<f64> {
    value(dict, key)?.downcast::<CFNumber>()?.to_f64()
}

fn string(dict: &InfoDict, key: CFStringRef) -> Option<String> {
    Some(value(dict, key)?.downcast::<CFString>()?.to_string())
}

fn bounds(dict: &InfoDict) -> Option<Bounds> {
    // kCGWindowBounds is a CGRect in dictionary representation: X/Y/Width/Height
    // CFNumbers, in screen points with a top-left origin - the same space
    // CGEvent takes, so no flip is needed before clicking into it.
    let rect = value(dict, unsafe { kCGWindowBounds })?.downcast::<CFDictionary>()?;
    let rect: InfoDict = unsafe { InfoDict::wrap_under_get_rule(rect.as_concrete_TypeRef()) };
    let get = |name: &str| -> Option<f64> {
        let key = CFString::new(name);
        rect.find(key.as_CFType())?.downcast::<CFNumber>()?.to_f64()
    };
    Some(Bounds {
        x: get("X")?,
        y: get("Y")?,
        w: get("Width")?,
        h: get("Height")?,
    })
}

/// Read one list entry, keeping only real application windows: layer 0 (above
/// the desktop, below the menu bar and dock) with a non-degenerate rect. A
/// zero-area or off-layer entry is a status item or an offscreen shadow, never
/// something worth clicking or capturing.
fn describe(dict: &InfoDict) -> Option<WindowInfo> {
    if number(dict, unsafe { kCGWindowLayer })? != 0.0 {
        return None;
    }
    let bounds = bounds(dict)?;
    if bounds.w < 1.0 || bounds.h < 1.0 {
        return None;
    }
    Some(WindowInfo {
        window_id: number(dict, unsafe { kCGWindowNumber })? as i64,
        pid: number(dict, unsafe { kCGWindowOwnerPID })? as i32,
        owner: string(dict, unsafe { kCGWindowOwnerName }).unwrap_or_default(),
        bounds,
    })
}

/// The frontmost application window on the active space.
///
/// This is the window the user is looking at, which is what "is my app still
/// in front?" means for evidence quality. It is not identical to NSWorkspace's
/// frontmost APPLICATION: an active app with no visible window does not appear
/// here, by design (there would be nothing to click).
pub fn frontmost() -> Result<WindowInfo, String> {
    on_screen_windows()?
        .iter()
        .find_map(|dict| describe(&dict))
        .ok_or_else(|| "no on-screen application window found".to_string())
}

/// The frontmost window belonging to `pid`.
pub fn for_pid(pid: i32) -> Result<WindowInfo, String> {
    on_screen_windows()?
        .iter()
        .filter_map(|dict| describe(&dict))
        .find(|window| window.pid == pid)
        .ok_or_else(|| format!("no on-screen window for pid {pid}"))
}
