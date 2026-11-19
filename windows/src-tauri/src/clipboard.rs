// Native clipboard history watcher & read/write bridge using `arboard`.
// Runs a low-frequency background check (1.5s) when unpaused, bounds text size
// to MAX_CLIPBOARD_CHARS, and emits `clipboard-text` events to the island.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use arboard::Clipboard;
use tauri::{AppHandle, Emitter};

const POLL_INTERVAL: Duration = Duration::from_millis(1500);
const MAX_CLIPBOARD_CHARS: usize = 16_000;

static CLIPBOARD: Mutex<Option<Clipboard>> = Mutex::new(None);
static LAST_SEEN: Mutex<String> = Mutex::new(String::new());
static PAUSED: AtomicBool = AtomicBool::new(false);

fn with_clipboard<T>(f: impl FnOnce(&mut Clipboard) -> T) -> Option<T> {
    let mut slot = CLIPBOARD.lock().ok()?;
    if slot.is_none() {
        *slot = Clipboard::new().ok();
    }
    slot.as_mut().map(f)
}

pub fn sanitize_clipboard_text(raw: &str) -> Option<String> {
    if raw.trim().is_empty() {
        return None;
    }
    let clamped: String = raw.chars().take(MAX_CLIPBOARD_CHARS).collect();
    Some(clamped)
}

fn read_text_sync() -> Option<String> {
    let raw = with_clipboard(|c| c.get_text().ok()).flatten()?;
    sanitize_clipboard_text(&raw)
}

fn write_text_sync(text: &str) -> Result<(), String> {
    if let Ok(mut last) = LAST_SEEN.lock() {
        *last = text.to_string();
    }
    let res = with_clipboard(|c| c.set_text(text.to_string()));
    match res {
        Some(Ok(())) => Ok(()),
        Some(Err(e)) => Err(format!("Clipboard write failed: {e}")),
        None => Err("Clipboard unavailable".to_string()),
    }
}

pub fn setup(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        // Seed LAST_SEEN with whatever was already on clipboard at boot
        // so we don't fire a spurious event if empty, or capture initial item once.
        if let Ok(Some(initial)) = tokio::task::spawn_blocking(read_text_sync).await {
            if let Ok(mut last) = LAST_SEEN.lock() {
                *last = initial.clone();
            }
            let _ = handle.emit("clipboard-text", initial);
        }

        let mut ticker = tokio::time::interval(POLL_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            if PAUSED.load(Ordering::Relaxed) {
                continue;
            }
            let current = match tokio::task::spawn_blocking(read_text_sync).await {
                Ok(Some(text)) => text,
                _ => continue,
            };
            let changed = match LAST_SEEN.lock() {
                Ok(mut last) => {
                    if *last == current {
                        false
                    } else {
                        *last = current.clone();
                        true
                    }
                }
                Err(_) => false,
            };
            if changed {
                let _ = handle.emit("clipboard-text", current);
            }
        }
    });
}

#[tauri::command]
pub async fn clipboard_read_text() -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(read_text_sync)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn clipboard_write_text(text: String) -> Result<(), String> {
    let sanitized = sanitize_clipboard_text(&text).ok_or_else(|| "Empty clipboard text".to_string())?;
    tokio::task::spawn_blocking(move || write_text_sync(&sanitized))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn clipboard_set_paused(paused: bool) {
    PAUSED.store(paused, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_rejects_empty_and_clamps_long_text() {
        assert_eq!(sanitize_clipboard_text(""), None);
        assert_eq!(sanitize_clipboard_text("   \n\t  "), None);
        assert_eq!(sanitize_clipboard_text("hello world"), Some("hello world".to_string()));

        let huge = "a".repeat(MAX_CLIPBOARD_CHARS + 500);
        let out = sanitize_clipboard_text(&huge).unwrap();
        assert_eq!(out.chars().count(), MAX_CLIPBOARD_CHARS);
    }
}
