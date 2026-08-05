//! Synthesized mouse and keyboard input via CGEvent.
//!
//! Everything posts to `kCGHIDEventTap`, the lowest tap, so events pass through
//! the same path as a real device and reach the frontmost app regardless of
//! which process the helper is.
//!
//! Timing is not decoration: a toolkit that tracks enter/leave ignores a press
//! that arrives with no prior hover, and a down/up pair with no gap is
//! swallowed by some hit-test debounces. The two constants below are the
//! settle times a real hand would produce.

use std::thread::sleep;
use std::time::Duration;

use core_graphics::event::{
    CGEvent, CGEventFlags, CGEventTapLocation, CGEventType, CGKeyCode, CGMouseButton, EventField,
};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use core_graphics::geometry::CGPoint;

use crate::cli::Button;

/// Hover-before-press settle, in milliseconds.
pub const HOVER_SETTLE_MS: u64 = 120;
/// Gap between a press and its release, in milliseconds.
pub const PRESS_GAP_MS: u64 = 60;
/// Gap between a key down and its key up, in milliseconds.
pub const KEY_GAP_MS: u64 = 25;
/// Milliseconds per interpolated drag step; also the floor on step duration.
const DRAG_STEP_MS: u64 = 12;
/// Upper bound on interpolated drag steps, so a long drag cannot flood the tap.
const MAX_DRAG_STEPS: u64 = 120;

fn source() -> Result<CGEventSource, String> {
    CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|()| "could not create a CGEventSource".to_string())
}

fn post(
    source: &CGEventSource,
    event_type: CGEventType,
    point: CGPoint,
    button: CGMouseButton,
    click_state: Option<i64>,
) -> Result<(), String> {
    let event = CGEvent::new_mouse_event(source.clone(), event_type, point, button)
        .map_err(|()| format!("could not create a {event_type:?} event"))?;
    if let Some(state) = click_state {
        event.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, state);
    }
    event.post(CGEventTapLocation::HID);
    Ok(())
}

fn point(x: f64, y: f64) -> CGPoint {
    CGPoint::new(x, y)
}

/// Move the cursor with no press. Also the hover leg of `click` and `drag`.
pub fn move_to(x: f64, y: f64) -> Result<(), String> {
    let source = source()?;
    post(
        &source,
        CGEventType::MouseMoved,
        point(x, y),
        CGMouseButton::Left,
        None,
    )
}

pub fn click(x: f64, y: f64, button: Button, double: bool) -> Result<(), String> {
    let source = source()?;
    let (down, up, cg_button) = match button {
        Button::Left => (
            CGEventType::LeftMouseDown,
            CGEventType::LeftMouseUp,
            CGMouseButton::Left,
        ),
        Button::Right => (
            CGEventType::RightMouseDown,
            CGEventType::RightMouseUp,
            CGMouseButton::Right,
        ),
    };
    let at = point(x, y);

    post(&source, CGEventType::MouseMoved, at, cg_button, None)?;
    sleep(Duration::from_millis(HOVER_SETTLE_MS));

    // A double click is two full click pairs whose click-state counts up; a
    // single event with clickState 2 is not what AppKit's clickCount sees.
    let pairs = if double { 2 } else { 1 };
    for pair in 1..=pairs {
        post(&source, down, at, cg_button, Some(pair))?;
        sleep(Duration::from_millis(PRESS_GAP_MS));
        post(&source, up, at, cg_button, Some(pair))?;
        if pair < pairs {
            sleep(Duration::from_millis(PRESS_GAP_MS));
        }
    }
    Ok(())
}

/// Press at `from`, interpolate to `to`, release. Left button only: no drag
/// gesture in this app is bound to the right button.
pub fn drag(from: (f64, f64), to: (f64, f64), duration_ms: u64) -> Result<u64, String> {
    let source = source()?;
    let start = point(from.0, from.1);
    let end = point(to.0, to.1);

    post(
        &source,
        CGEventType::MouseMoved,
        start,
        CGMouseButton::Left,
        None,
    )?;
    sleep(Duration::from_millis(HOVER_SETTLE_MS));
    post(
        &source,
        CGEventType::LeftMouseDown,
        start,
        CGMouseButton::Left,
        Some(1),
    )?;
    sleep(Duration::from_millis(PRESS_GAP_MS));

    let steps = drag_steps(duration_ms);
    let step_ms = duration_ms / steps;
    for step in 1..=steps {
        let progress = step as f64 / steps as f64;
        let at = point(
            from.0 + (to.0 - from.0) * progress,
            from.1 + (to.1 - from.1) * progress,
        );
        post(
            &source,
            CGEventType::LeftMouseDragged,
            at,
            CGMouseButton::Left,
            None,
        )?;
        sleep(Duration::from_millis(step_ms));
    }

    sleep(Duration::from_millis(PRESS_GAP_MS));
    post(
        &source,
        CGEventType::LeftMouseUp,
        end,
        CGMouseButton::Left,
        Some(1),
    )?;
    Ok(steps)
}

/// Step count for a drag of `duration_ms`: enough to look continuous, never so
/// many that the per-step sleep rounds to zero.
fn drag_steps(duration_ms: u64) -> u64 {
    (duration_ms / DRAG_STEP_MS).clamp(1, MAX_DRAG_STEPS)
}

/// Press and release one key with `flags` set on both events.
///
/// The modifier state rides the key events themselves rather than separate
/// modifier key-downs. AppKit reads `NSEvent.modifierFlags` when matching a
/// menu key equivalent, so this is enough for Cmd+S, and it cannot leave a
/// modifier stuck down if the process dies mid-sequence.
pub fn keys(key_code: CGKeyCode, flags: CGEventFlags) -> Result<(), String> {
    let source = source()?;
    for keydown in [true, false] {
        let event = CGEvent::new_keyboard_event(source.clone(), key_code, keydown)
            .map_err(|()| "could not create a keyboard event".to_string())?;
        event.set_flags(flags);
        event.post(CGEventTapLocation::HID);
        if keydown {
            sleep(Duration::from_millis(KEY_GAP_MS));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drag_steps_never_round_the_per_step_sleep_to_zero() {
        for duration_ms in [1_u64, 12, 60, 300, 5_000, 60_000] {
            let steps = drag_steps(duration_ms);
            assert!(steps >= 1, "{duration_ms} ms produced {steps} steps");
            assert!(steps <= MAX_DRAG_STEPS, "{duration_ms} ms produced {steps}");
            assert!(
                duration_ms / steps >= 1 || duration_ms == 0,
                "{duration_ms} ms over {steps} steps sleeps 0 per step"
            );
        }
    }

    #[test]
    fn drag_steps_scale_with_duration() {
        assert!(drag_steps(300) > drag_steps(60));
        assert_eq!(drag_steps(0), 1);
    }
}
