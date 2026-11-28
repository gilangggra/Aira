// Native clipboard history watcher & read/write bridge using `arboard`.
// Runs a low-frequency background check (1.5s) when unpaused, bounds text size
// to MAX_CLIPBOARD_CHARS, captures images as cached PNGs with thumbnails,
// and emits `clipboard-text` / `clipboard-image` events to the island.

use std::borrow::Cow;
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use arboard::{Clipboard, ImageData};
use tauri::{AppHandle, Emitter, Manager};

const POLL_INTERVAL: Duration = Duration::from_millis(1500);
const MAX_CLIPBOARD_CHARS: usize = 16_000;
const MAX_CACHED_IMAGES: usize = 30;
const THUMB_MAX_DIM: usize = 320;

static CLIPBOARD: Mutex<Option<Clipboard>> = Mutex::new(None);
static LAST_SEEN: Mutex<String> = Mutex::new(String::new());
static LAST_IMAGE_HASH: Mutex<Option<u64>> = Mutex::new(None);
static PAUSED: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardImagePayload {
    pub hash: String,
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub thumb_data_url: String,
}

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

fn fnv1a_image_hash(width: usize, height: usize, bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in (width as u64).to_le_bytes().iter().chain((height as u64).to_le_bytes().iter()) {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    let step = (bytes.len() / 8192).max(1);
    for &b in bytes.iter().step_by(step) {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h ^= bytes.len() as u64;
    h.wrapping_mul(0x100000001b3)
}

fn encode_base64(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((n >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((n >> 12) & 0x3f) as usize] as char);
        out.push(if chunk.len() > 1 { TABLE[((n >> 6) & 0x3f) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[(n & 0x3f) as usize] as char } else { '=' });
    }
    out
}

pub fn encode_png_rgba(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    let expected = (width as usize).saturating_mul(height as usize).saturating_mul(4);
    if width == 0 || height == 0 || rgba.len() != expected {
        return Err("Invalid RGBA buffer dimensions".to_string());
    }
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder.write_header().map_err(|e| format!("PNG header failed: {e}"))?;
        writer
            .write_image_data(rgba)
            .map_err(|e| format!("PNG write failed: {e}"))?;
    }
    Ok(out)
}

pub fn decode_png_rgba(bytes: &[u8]) -> Result<(u32, u32, Vec<u8>), String> {
    let mut decoder = png::Decoder::new(Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::ALPHA);
    let mut reader = decoder.read_info().map_err(|e| format!("PNG decode failed: {e}"))?;
    let mut buf = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).map_err(|e| format!("PNG frame failed: {e}"))?;
    let mut data = buf[..info.buffer_size()].to_vec();
    if info.color_type == png::ColorType::GrayscaleAlpha {
        let mut rgba = Vec::with_capacity((info.width * info.height * 4) as usize);
        for px in data.chunks_exact(2) {
            rgba.extend_from_slice(&[px[0], px[0], px[0], px[1]]);
        }
        data = rgba;
    } else if info.color_type == png::ColorType::Rgb {
        let mut rgba = Vec::with_capacity((info.width * info.height * 4) as usize);
        for px in data.chunks_exact(3) {
            rgba.extend_from_slice(&[px[0], px[1], px[2], 255]);
        }
        data = rgba;
    }
    Ok((info.width, info.height, data))
}

pub fn make_thumbnail_rgba(width: usize, height: usize, rgba: &[u8], max_dim: usize) -> (u32, u32, Vec<u8>) {
    if width == 0 || height == 0 || (width <= max_dim && height <= max_dim) {
        return (width as u32, height as u32, rgba.to_vec());
    }
    let scale = (max_dim as f64) / (width.max(height) as f64);
    let tw = ((width as f64) * scale).round().max(1.0) as usize;
    let th = ((height as f64) * scale).round().max(1.0) as usize;
    let mut out = vec![0u8; tw * th * 4];
    for y in 0..th {
        let sy = (y * height) / th;
        for x in 0..tw {
            let sx = (x * width) / tw;
            let src = (sy * width + sx) * 4;
            let dst = (y * tw + x) * 4;
            out[dst..dst + 4].copy_from_slice(&rgba[src..src + 4]);
        }
    }
    (tw as u32, th as u32, out)
}

fn image_cache_dir(app: &AppHandle) -> Option<PathBuf> {
    let base = app.path().app_data_dir().ok()?;
    let dir = base.join("clipboard_images");
    if fs::create_dir_all(&dir).is_ok() {
        Some(dir)
    } else {
        None
    }
}

fn prune_image_cache(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut files: Vec<(PathBuf, SystemTime)> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()) != Some("png") {
                return None;
            }
            let modified = e.metadata().and_then(|m| m.modified()).unwrap_or(UNIX_EPOCH);
            Some((p, modified))
        })
        .collect();
    if files.len() <= MAX_CACHED_IMAGES {
        return;
    }
    files.sort_by_key(|(_, t)| *t);
    for (p, _) in files.into_iter().take(MAX_CACHED_IMAGES / 3) {
        let _ = fs::remove_file(p);
    }
}

fn read_image_payload_sync(cache_dir: &Path, only_if_changed: bool) -> Option<ClipboardImagePayload> {
    let img = with_clipboard(|c| c.get_image().ok()).flatten()?;
    if img.width == 0 || img.height == 0 || img.bytes.is_empty() {
        return None;
    }
    let hash = fnv1a_image_hash(img.width, img.height, &img.bytes);
    if only_if_changed {
        if let Ok(mut last) = LAST_IMAGE_HASH.lock() {
            if *last == Some(hash) {
                return None;
            }
            *last = Some(hash);
        }
    } else if let Ok(mut last) = LAST_IMAGE_HASH.lock() {
        *last = Some(hash);
    }

    let hash_hex = format!("{hash:016x}");
    let file_path = cache_dir.join(format!("clip_{hash_hex}.png"));
    if !file_path.exists() {
        let png_bytes = encode_png_rgba(img.width as u32, img.height as u32, &img.bytes).ok()?;
        fs::write(&file_path, png_bytes).ok()?;
        prune_image_cache(cache_dir);
    }

    let (tw, th, thumb_rgba) = make_thumbnail_rgba(img.width, img.height, &img.bytes, THUMB_MAX_DIM);
    let thumb_png = encode_png_rgba(tw, th, &thumb_rgba).ok()?;
    let thumb_data_url = format!("data:image/png;base64,{}", encode_base64(&thumb_png));

    Some(ClipboardImagePayload {
        hash: hash_hex,
        path: file_path.to_string_lossy().to_string(),
        width: img.width as u32,
        height: img.height as u32,
        thumb_data_url,
    })
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
            let text_res = tokio::task::spawn_blocking(read_text_sync).await;
            if let Ok(Some(current)) = text_res {
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
                continue;
            }
            if let Some(dir) = image_cache_dir(&handle) {
                if let Ok(Some(payload)) =
                    tokio::task::spawn_blocking(move || read_image_payload_sync(&dir, true)).await
                {
                    let _ = handle.emit("clipboard-image", payload);
                }
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

#[tauri::command]
pub async fn clipboard_read_image(app: AppHandle) -> Result<Option<ClipboardImagePayload>, String> {
    let Some(dir) = image_cache_dir(&app) else {
        return Ok(None);
    };
    tokio::task::spawn_blocking(move || read_image_payload_sync(&dir, false))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn clipboard_write_image(path: String) -> Result<(), String> {
    let bytes = fs::read(&path).map_err(|e| format!("Could not read cached image: {e}"))?;
    let (width, height, rgba) = decode_png_rgba(&bytes)?;
    let hash = fnv1a_image_hash(width as usize, height as usize, &rgba);
    if let Ok(mut last) = LAST_IMAGE_HASH.lock() {
        *last = Some(hash);
    }
    tokio::task::spawn_blocking(move || {
        let img = ImageData {
            width: width as usize,
            height: height as usize,
            bytes: Cow::Owned(rgba),
        };
        match with_clipboard(|c| c.set_image(img)) {
            Some(Ok(())) => Ok(()),
            Some(Err(e)) => Err(format!("Clipboard image write failed: {e}")),
            None => Err("Clipboard unavailable".to_string()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn clipboard_save_image(app: AppHandle, path: String) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(|e| format!("Could not read image: {e}"))?;
    let pictures = app
        .path()
        .picture_dir()
        .or_else(|_| std::env::var("USERPROFILE").map(|p| PathBuf::from(p).join("Pictures")))
        .map_err(|_| "Pictures folder unavailable".to_string())?;
    let dest_dir = pictures.join("Aira");
    fs::create_dir_all(&dest_dir).map_err(|e| format!("Could not create folder: {e}"))?;
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let dest = dest_dir.join(format!("Aira_Clip_{secs}.png"));
    fs::write(&dest, bytes).map_err(|e| format!("Could not save image: {e}"))?;
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("explorer")
            .arg(format!("/select,{}", dest.to_string_lossy()))
            .spawn();
    }
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub fn clipboard_delete_image(app: AppHandle, path: String) {
    let Some(dir) = image_cache_dir(&app) else { return };
    let target = PathBuf::from(path);
    if target.parent() == Some(dir.as_path()) {
        let _ = fs::remove_file(target);
    }
}

#[tauri::command]
pub fn clipboard_read_image_data_url(app: AppHandle, path: String) -> Result<String, String> {
    let dir = image_cache_dir(&app).ok_or_else(|| "Image cache unavailable".to_string())?;
    let target = PathBuf::from(&path);
    if target.parent() != Some(dir.as_path()) {
        return Err("Invalid image path".to_string());
    }
    let bytes = fs::read(&target).map_err(|e| format!("Could not read image: {e}"))?;
    Ok(format!("data:image/png;base64,{}", encode_base64(&bytes)))
}

const MAX_QR_CHARS: usize = 2000;

/// Renders a crisp SVG QR code for a clipboard snippet or URL using the bundled `qrcode` crate.
#[tauri::command]
pub fn clipboard_qr_svg(text: String) -> Result<String, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("Empty QR text".to_string());
    }
    if trimmed.chars().count() > MAX_QR_CHARS {
        return Err("Text is too long for a QR code".to_string());
    }
    let code = qrcode::QrCode::new(trimmed.as_bytes()).map_err(|e| format!("QR encode failed: {e}"))?;
    Ok(code
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(180, 180)
        .quiet_zone(true)
        .dark_color(qrcode::render::svg::Color("#0f172a"))
        .light_color(qrcode::render::svg::Color("#ffffff"))
        .build())
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

    #[test]
    fn qr_svg_renders_valid_svg_and_rejects_empty() {
        assert!(clipboard_qr_svg("   ".to_string()).is_err());
        let svg = clipboard_qr_svg("https://github.com/gilangggra/Aira".to_string()).unwrap();
        assert!(svg.contains("<svg") && svg.contains("</svg>"));
    }

    #[test]
    fn png_roundtrip_and_thumbnail_downscale() {
        let mut rgba = vec![0u8; 320 * 160 * 4];
        for px in rgba.chunks_exact_mut(4) {
            px.copy_from_slice(&[56, 189, 248, 255]);
        }
        let png = encode_png_rgba(320, 160, &rgba).unwrap();
        let (w, h, decoded) = decode_png_rgba(&png).unwrap();
        assert_eq!((w, h), (320, 160));
        assert_eq!(decoded.len(), rgba.len());

        let (tw, th, thumb) = make_thumbnail_rgba(320, 160, &rgba, 80);
        assert_eq!((tw, th), (80, 40));
        assert_eq!(thumb.len(), 80 * 40 * 4);
    }
}
