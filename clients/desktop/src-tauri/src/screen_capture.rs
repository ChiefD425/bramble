//! "Block screenshots": content protection on every window, which is WDA_EXCLUDEFROMCAPTURE on
//! Windows and NSWindowSharingNone on macOS. Linux has nothing. See docs/screen-capture-blocking.md.

use std::{
    sync::atomic::{AtomicU64, AtomicU8, Ordering},
    time::Duration,
};

use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::{autolock::now_ms, storage, storage::ops};

const PREF: &str = "pref.screenCaptureBlocked";

/// What Settings chose this run: 0 not yet, when the stored value rules; 1 allow; 2 block.
static CHOSEN: AtomicU8 = AtomicU8::new(0);
/// When "Allow for 10 minutes" ends, in ms since the epoch. A restart ends it.
static PAUSED_UNTIL: AtomicU64 = AtomicU64::new(0);

/// Only a stored `false` allows capture, so a missing or unreadable value blocks.
fn blocked_by(stored: Option<&Value>) -> bool {
    !matches!(stored, Some(Value::Bool(false)))
}

fn secure(blocked: bool, paused_until: u64, now: u64) -> bool {
    blocked && now >= paused_until
}

fn blocked(app: &AppHandle) -> bool {
    match CHOSEN.load(Ordering::Relaxed) {
        1 => false,
        2 => true,
        _ => blocked_by(
            storage::data_dir(app)
                .ok()
                .and_then(|root| ops::get_meta(&root, PREF).ok().flatten())
                .as_ref(),
        ),
    }
}

pub fn apply(app: &AppHandle) {
    let on = secure(blocked(app), PAUSED_UNTIL.load(Ordering::Relaxed), now_ms());
    for window in app.webview_windows().values() {
        if let Err(e) = window.set_content_protected(on) {
            log::warn!("screen capture: {} not updated: {e}", window.label());
        }
    }
}

#[tauri::command]
pub fn screen_capture_available() -> bool {
    cfg!(any(target_os = "macos", target_os = "windows"))
}

/// Also ends a pause.
#[tauri::command]
pub fn screen_capture_set(app: AppHandle, blocked: bool) {
    CHOSEN.store(if blocked { 2 } else { 1 }, Ordering::Relaxed);
    PAUSED_UNTIL.store(0, Ordering::Relaxed);
    apply(&app);
}

/// When the current pause ends, in ms since the epoch, or 0 when there is none.
#[tauri::command]
pub fn screen_capture_paused_until() -> u64 {
    let until = PAUSED_UNTIL.load(Ordering::Relaxed);
    if until > now_ms() {
        until
    } else {
        0
    }
}

/// Allow capture for `ms`; returns when that ends, in ms since the epoch.
#[tauri::command]
pub fn screen_capture_pause(app: AppHandle, ms: u64) -> u64 {
    let until = now_ms() + ms;
    PAUSED_UNTIL.store(until, Ordering::Relaxed);
    apply(&app);
    // Polls the wall clock rather than sleeping `ms`: the monotonic clock a sleep uses stops
    // while the Mac sleeps. A later pause or switch replaces `until`, which retires this one.
    std::thread::spawn(move || {
        while PAUSED_UNTIL.load(Ordering::Relaxed) == until && now_ms() < until {
            std::thread::sleep(Duration::from_secs(1));
        }
        if PAUSED_UNTIL.load(Ordering::Relaxed) == until {
            apply(&app);
        }
    });
    until
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_a_stored_false_allows_capture() {
        assert!(!blocked_by(Some(&json!(false))));
        assert!(blocked_by(Some(&json!(true))));
        assert!(blocked_by(None));
        assert!(blocked_by(Some(&json!("false"))));
        assert!(blocked_by(Some(&json!(0))));
    }

    #[test]
    fn a_pause_allows_capture_until_it_ends() {
        assert!(!secure(true, 1_000, 999));
        assert!(secure(true, 1_000, 1_000));
        assert!(secure(true, 0, 5));
        assert!(!secure(false, 0, 5));
    }
}
