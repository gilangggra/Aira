// Quick Camera Mirror capture storage — saves photos and videos directly into
// the OS Camera Roll (e.g. %USERPROFILE%\Pictures\Camera Roll on Windows) using
// standard WIN_YYYYMMDD_HH_MM_SS.<ext> filenames so they appear alongside native
// Camera app captures.

use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

use tauri::State;

use crate::platform;
use crate::recap::decode_base64;

const MAX_CAPTURE_BYTES: usize = 64 << 20;

#[derive(Default)]
pub struct CameraStore(Mutex<Option<PathBuf>>);

impl CameraStore {
    fn lock(&self) -> MutexGuard<'_, Option<PathBuf>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

fn camera_roll_dir(dirs: &[PathBuf]) -> Result<PathBuf, String> {
    let base = dirs
        .iter()
        .find(|d| d.is_dir())
        .ok_or_else(|| crate::i18n::t("No Pictures or Downloads folder to save into."))?;
    let roll = base.join("Camera Roll");
    if roll.is_dir() {
        return Ok(roll);
    }
    if fs::create_dir_all(&roll).is_ok() && roll.is_dir() {
        return Ok(roll);
    }
    Ok(base.to_path_buf())
}

fn sanitize_stamp(raw: &str) -> String {
    let clean: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
        .take(32)
        .collect();
    if clean.is_empty() {
        "capture".to_string()
    } else {
        clean
    }
}

fn sanitize_ext(raw: &str) -> Result<&'static str, String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "png" => Ok("png"),
        "jpg" | "jpeg" => Ok("jpg"),
        "webm" => Ok("webm"),
        "mp4" => Ok("mp4"),
        _ => Err("Unsupported media format.".to_string()),
    }
}

fn write_unique(dir: &Path, stem: &str, ext: &str, bytes: &[u8]) -> std::io::Result<PathBuf> {
    for n in 1..=999u32 {
        let name = if n == 1 {
            format!("{stem}.{ext}")
        } else {
            format!("{stem}_{n}.{ext}")
        };
        let path = dir.join(name);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                file.write_all(bytes)?;
                return Ok(path);
            }
            Err(err) if err.kind() == ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(err),
        }
    }
    Err(std::io::Error::new(ErrorKind::AlreadyExists, "too many files"))
}

fn save_capture(dirs: &[PathBuf], data: &str, stamp: &str, ext: &str) -> Result<PathBuf, String> {
    let safe_ext = sanitize_ext(ext)?;
    if data.len() > MAX_CAPTURE_BYTES / 3 * 4 + 128 {
        return Err("Capture file is too large.".to_string());
    }
    let bytes = decode_base64(data).ok_or_else(|| "Could not decode capture data.".to_string())?;
    if bytes.is_empty() {
        return Err("Capture data is empty.".to_string());
    }
    let dir = camera_roll_dir(dirs)?;
    let safe_stamp = sanitize_stamp(stamp);
    let stem = if safe_stamp.starts_with("WIN_") {
        safe_stamp
    } else {
        format!("WIN_{safe_stamp}")
    };
    write_unique(&dir, &stem, safe_ext, &bytes)
        .map_err(|err| format!("Could not save capture: {err}"))
}

#[tauri::command]
pub fn camera_save_capture(
    store: State<CameraStore>,
    data: String,
    stamp: String,
    ext: String,
) -> Result<String, String> {
    let path = save_capture(&platform::picture_dirs(), &data, &stamp, &ext)?;
    let shown = path.to_string_lossy().to_string();
    *store.lock() = Some(path);
    Ok(shown)
}

#[tauri::command]
pub fn camera_reveal_saved(store: State<CameraStore>) {
    let dir = store
        .lock()
        .as_ref()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .or_else(|| camera_roll_dir(&platform::picture_dirs()).ok());
    if let Some(dir) = dir {
        platform::reveal_folder(&dir.to_string_lossy());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_to_camera_roll_with_native_win_prefix_and_collision_suffix() {
        let base = std::env::temp_dir().join(format!("aira_cam_test_{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();

        let p1 = save_capture(&[base.clone()], "data:image/png;base64,SGVsbG8=", "20261128_14_20_00", "png").unwrap();
        assert_eq!(p1.parent().unwrap(), base.join("Camera Roll"));
        assert_eq!(p1.file_name().unwrap().to_string_lossy(), "WIN_20261128_14_20_00.png");

        let p2 = save_capture(&[base.clone()], "SGVsbG8=", "20261128_14_20_00", "png").unwrap();
        assert_eq!(p2.file_name().unwrap().to_string_lossy(), "WIN_20261128_14_20_00_2.png");

        let _ = fs::remove_dir_all(&base);
    }
}

