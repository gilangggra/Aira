// On-demand 1-click local installer for FFmpeg, Pandoc, and LibreOffice.
// Keeps Aira's installer lightweight (Hybrid approach): downloads official
// portable releases from GitHub into %LOCALAPPDATA%\Aira\tools\ (for Pandoc &
// FFmpeg) with SHA-256 verification when published, and uses Windows' built-in
// `winget` silently for LibreOffice (or as fallback).

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::converter::{find_tool, ConverterEngine};
use crate::whatsapp::archive;
use crate::{i18n, log, net, platform, update};

const PANDOC_LATEST_API: &str = "https://api.github.com/repos/jgm/pandoc/releases/latest";
const FFMPEG_LATEST_API: &str = "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest";

const MAX_TOOL_ZIP: usize = 260 * 1024 * 1024;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);
const WINGET_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "step", rename_all = "camelCase")]
pub enum ToolInstallStep {
    Idle,
    Checking { tool: String },
    Downloading { tool: String, megabytes: u64 },
    Installing { tool: String },
    Uninstalling { tool: String },
    Done { tool: String },
    Failed { tool: String, reason: String },
}

impl ToolInstallStep {
    pub fn busy(&self) -> bool {
        matches!(
            self,
            ToolInstallStep::Checking { .. }
                | ToolInstallStep::Downloading { .. }
                | ToolInstallStep::Installing { .. }
                | ToolInstallStep::Uninstalling { .. }
        )
    }
}

static STATE: LazyLock<Mutex<ToolInstallStep>> = LazyLock::new(|| Mutex::new(ToolInstallStep::Idle));

fn set_step(app: &AppHandle, step: ToolInstallStep) {
    {
        let mut guard = STATE.lock().unwrap_or_else(|e| e.into_inner());
        *guard = step.clone();
    }
    let _ = app.emit("converter-install", step);
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReleaseAsset {
    pub name: String,
    pub url: String,
    pub size: u64,
    pub sha256: Option<String>,
}

fn parse_assets(json: &[u8]) -> Option<Vec<ReleaseAsset>> {
    let val: Value = serde_json::from_slice(json).ok()?;
    let arr = val.get("assets")?.as_array()?;
    Some(
        arr.iter()
            .filter_map(|a| {
                let name = a.get("name")?.as_str()?.to_string();
                let url = a.get("browser_download_url")?.as_str()?.to_string();
                if !update::allowed_url(&url) {
                    return None;
                }
                let size = a.get("size").and_then(Value::as_u64).unwrap_or(0);
                let sha256 = a
                    .get("digest")
                    .and_then(Value::as_str)
                    .and_then(update::parse_digest);
                Some(ReleaseAsset { name, url, size, sha256 })
            })
            .collect(),
    )
}

pub fn pick_pandoc_asset(json: &[u8], arch: &str) -> Option<ReleaseAsset> {
    let assets = parse_assets(json)?;
    let suffix = if arch == "arm64" { "-windows-arm64.zip" } else { "-windows-x86_64.zip" };
    assets
        .iter()
        .find(|a| a.name.ends_with(suffix))
        .or_else(|| assets.iter().find(|a| a.name.ends_with("-windows-x86_64.zip")))
        .cloned()
}

pub fn pick_ffmpeg_asset(json: &[u8], arch: &str) -> Option<ReleaseAsset> {
    let assets = parse_assets(json)?;
    let preferred = if arch == "arm64" {
        ["ffmpeg-master-latest-winarm64-gpl.zip", "ffmpeg-n7.1-latest-winarm64-gpl-7.1.zip"]
    } else {
        ["ffmpeg-master-latest-win64-gpl.zip", "ffmpeg-master-latest-win64-lgpl.zip"]
    };
    for name in preferred {
        if let Some(found) = assets.iter().find(|a| a.name == name) {
            return Some(found.clone());
        }
    }
    let needle = if arch == "arm64" { "winarm64-gpl" } else { "win64-gpl" };
    assets
        .into_iter()
        .find(|a| a.name.contains(needle) && a.name.ends_with(".zip") && !a.name.contains("shared"))
}

pub fn find_exe_entry<'a>(entries: &'a [archive::Entry], target_file: &str) -> Option<&'a archive::Entry> {
    entries.iter().find(|e| {
        let lower = e.name.to_ascii_lowercase();
        lower == target_file || lower.ends_with(&format!("/{target_file}"))
    })
}

pub fn extract_binary_from_zip(zip: &[u8], target_file: &str, expected_sha256: Option<&str>) -> Result<Vec<u8>, String> {
    if let Some(expected) = expected_sha256 {
        let actual = sha256_hex(zip);
        if actual != expected {
            return Err("Archive checksum verification failed.".into());
        }
    }
    let list = archive::entries(zip).ok_or_else(|| "Unsupported archive layout.".to_string())?;
    let entry = find_exe_entry(&list, target_file).ok_or_else(|| format!("{target_file} not found in archive."))?;
    archive::read(zip, entry).ok_or_else(|| "Failed to unpack binary from archive.".to_string())
}

fn sha256_hex(data: &[u8]) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA256, data);
    let mut out = String::with_capacity(digest.as_ref().len() * 2);
    for b in digest.as_ref() {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

fn tools_dir() -> PathBuf {
    platform::local_dir().join("tools")
}

fn write_binary_atomically(dest: &Path, data: &[u8]) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        platform::ensure_private_dir(parent).map_err(|e| e.to_string())?;
    }
    let temp = dest.with_extension("download");
    let written = (|| -> std::io::Result<()> {
        let mut f = std::fs::File::create(&temp)?;
        f.write_all(data)?;
        f.flush()?;
        drop(f);
        let _ = std::fs::remove_file(dest);
        std::fs::rename(&temp, dest)
    })();
    if let Err(err) = written {
        let _ = std::fs::remove_file(&temp);
        return Err(err.to_string());
    }
    Ok(())
}

fn github_client(timeout: Duration) -> Result<reqwest::Client, String> {
    let policy = reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 5 {
            attempt.error("too many redirects")
        } else if attempt.url().scheme() == "https" && update::allowed_host(attempt.url().host_str()) {
            attempt.follow()
        } else {
            attempt.stop()
        }
    });
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(timeout)
        .user_agent("Aira")
        .redirect(policy)
        .build()
        .map_err(|e| e.to_string())
}

async fn github_get(client: &reqwest::Client, url: &str, accept: &str) -> Result<reqwest::Response, String> {
    if !update::allowed_url(url) {
        return Err("Blocked untrusted download host.".into());
    }
    let resp = client
        .get(url)
        .header("Accept", accept)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() || resp.url().scheme() != "https" || !update::allowed_host(resp.url().host_str()) {
        return Err(format!("HTTP {}", resp.status()));
    }
    Ok(resp)
}

async fn install_zip_from_github(
    app: &AppHandle,
    tool_id: &str,
    api_url: &str,
    target_exe: &str,
    dest_path: PathBuf,
    picker: fn(&[u8], &str) -> Option<ReleaseAsset>,
) -> Result<(), String> {
    let client = github_client(DOWNLOAD_TIMEOUT)?;
    let meta_resp = github_get(&client, api_url, "application/vnd.github+json").await?;
    let meta = net::read_capped(meta_resp, net::MAX_BODY)
        .await
        .map_err(|e| e.to_string())?;

    let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "x86_64" };
    let asset = picker(&meta, arch).ok_or_else(|| "No compatible release package found.".to_string())?;
    if asset.size > MAX_TOOL_ZIP as u64 {
        return Err("Release package exceeds size limit.".into());
    }

    set_step(
        app,
        ToolInstallStep::Downloading {
            tool: tool_id.to_string(),
            megabytes: (asset.size / 1_000_000).max(1),
        },
    );

    let zip_resp = github_get(&client, &asset.url, "application/octet-stream").await?;
    let limit = if asset.size > 0 { asset.size as usize } else { MAX_TOOL_ZIP };
    let data = net::read_capped(zip_resp, limit)
        .await
        .map_err(|e| e.to_string())?;

    set_step(app, ToolInstallStep::Installing { tool: tool_id.to_string() });
    let expected = asset.sha256;
    let exe_name = target_exe.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let bin = extract_binary_from_zip(&data, &exe_name, expected.as_deref())?;
        write_binary_atomically(&dest_path, &bin)
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(())
}

#[cfg(windows)]
fn winget_package_id(engine: ConverterEngine) -> &'static str {
    match engine {
        ConverterEngine::Pandoc => "JohnMacFarlane.Pandoc",
        ConverterEngine::Ffmpeg => "Gyan.FFmpeg",
        ConverterEngine::Libreoffice => "TheDocumentFoundation.LibreOffice",
    }
}

#[cfg(windows)]
async fn run_winget(verb: &str, package_id: &str) -> Result<(), String> {
    let winget = platform::find_on_path("winget")
        .ok_or_else(|| i18n::t("Automatic install requires winget or manual download on this system."))?;

    let mut std_cmd = std::process::Command::new(winget);
    std_cmd.args([verb, "--id", package_id, "--exact", "--silent"]);
    if verb == "install" {
        std_cmd.arg("--accept-package-agreements");
    }
    std_cmd
        .arg("--accept-source-agreements")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    platform::no_console(&mut std_cmd);

    let mut cmd = tokio::process::Command::from(std_cmd);
    cmd.kill_on_drop(true);
    let child = cmd.spawn().map_err(|e| e.to_string())?;
    let output = tokio::time::timeout(WINGET_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| format!("{verb} timed out."))?
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let detail = stderr
        .lines()
        .rev()
        .chain(stdout.lines().rev())
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("winget failed");
    Err(detail.chars().take(160).collect())
}

#[cfg(not(windows))]
async fn run_winget(_verb: &str, _package_id: &str) -> Result<(), String> {
    Err(i18n::t("Automatic install requires winget or manual download on this system."))
}

async fn install_via_winget(package_id: &str) -> Result<(), String> {
    run_winget("install", package_id).await
}

/// Removes Aira's managed tool folder (`%LOCALAPPDATA%\Aira\tools\<id>`) and prunes the parent
/// `tools` directory when nothing else remains inside it.
pub fn remove_managed_dir(tools_root: &Path, tool_id: &str) -> Result<bool, String> {
    let dir = tools_root.join(tool_id);
    let existed = dir.exists();
    if existed {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    let _ = std::fs::remove_dir(tools_root);
    Ok(existed)
}

fn cleanup_libreoffice_temp_profiles() {
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if name.to_string_lossy().starts_with("aira-lo-profile-") {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

async fn run_install(app: &AppHandle, engine: ConverterEngine) -> Result<(), String> {
    if find_tool(engine).is_some() {
        return Ok(());
    }
    let id = engine.id();
    set_step(app, ToolInstallStep::Checking { tool: id.to_string() });

    #[cfg(windows)]
    {
        match engine {
            ConverterEngine::Pandoc => {
                let dest = tools_dir().join("pandoc").join("pandoc.exe");
                if let Err(err) = install_zip_from_github(app, id, PANDOC_LATEST_API, "pandoc.exe", dest, pick_pandoc_asset).await {
                    log::line(format!("converter-install: pandoc github zip failed ({err}), trying winget"));
                    set_step(app, ToolInstallStep::Installing { tool: id.to_string() });
                    install_via_winget("JohnMacFarlane.Pandoc").await?;
                }
            }
            ConverterEngine::Ffmpeg => {
                let dest = tools_dir().join("ffmpeg").join("ffmpeg.exe");
                if let Err(err) = install_zip_from_github(app, id, FFMPEG_LATEST_API, "ffmpeg.exe", dest, pick_ffmpeg_asset).await {
                    log::line(format!("converter-install: ffmpeg github zip failed ({err}), trying winget"));
                    set_step(app, ToolInstallStep::Installing { tool: id.to_string() });
                    install_via_winget("Gyan.FFmpeg").await?;
                }
            }
            ConverterEngine::Libreoffice => {
                set_step(app, ToolInstallStep::Installing { tool: id.to_string() });
                install_via_winget("TheDocumentFoundation.LibreOffice").await?;
            }
        }
        if find_tool(engine).is_some() {
            return Ok(());
        }
        return Err(i18n::t("Download failed — check your connection or install manually."));
    }

    #[cfg(not(windows))]
    {
        let _ = (tools_dir, write_binary_atomically, github_client, install_zip_from_github);
        Err(i18n::t("Automatic install requires winget or manual download on this system."))
    }
}

#[tauri::command]
pub fn converter_install_status() -> ToolInstallStep {
    STATE.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

fn parse_engine(tool: &str) -> Result<ConverterEngine, String> {
    match tool {
        "ffmpeg" => Ok(ConverterEngine::Ffmpeg),
        "libreoffice" => Ok(ConverterEngine::Libreoffice),
        "pandoc" => Ok(ConverterEngine::Pandoc),
        _ => Err(i18n::tf("Unknown tool: {tool}", &[("tool", tool)])),
    }
}

#[tauri::command]
pub async fn converter_install_tool(app: AppHandle, tool: String) -> Result<(), String> {
    let engine = parse_engine(&tool)?;

    {
        let current = STATE.lock().unwrap_or_else(|e| e.into_inner());
        if current.busy() {
            return Err(i18n::t("An installation is already in progress."));
        }
    }

    match run_install(&app, engine).await {
        Ok(()) => {
            log::line(format!("converter-install: {} installed cleanly", engine.id()));
            set_step(&app, ToolInstallStep::Done { tool: engine.id().to_string() });
            Ok(())
        }
        Err(err) => {
            let reason = i18n::tf("{tool} installation failed: {error}", &[("tool", engine.display_name()), ("error", &err)]);
            log::line(format!("converter-install: {reason}"));
            set_step(&app, ToolInstallStep::Failed { tool: engine.id().to_string(), reason: reason.clone() });
            Err(reason)
        }
    }
}

async fn run_uninstall(engine: ConverterEngine) -> Result<(), String> {
    remove_managed_dir(&tools_dir(), engine.id())?;
    if engine == ConverterEngine::Libreoffice {
        cleanup_libreoffice_temp_profiles();
    }

    #[cfg(windows)]
    if engine == ConverterEngine::Libreoffice || find_tool(engine).is_some() {
        let pkg = winget_package_id(engine);
        if let Err(err) = run_winget("uninstall", pkg).await {
            log::line(format!("converter-uninstall: winget uninstall {pkg} note: {err}"));
        }
    }

    if let Some(remaining) = find_tool(engine) {
        return Err(i18n::tf(
            "Aira's files were removed, but an external {tool} installation still exists at {path}.",
            &[("tool", engine.display_name()), ("path", &remaining.to_string_lossy())],
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn converter_uninstall_tool(app: AppHandle, tool: String) -> Result<(), String> {
    let engine = parse_engine(&tool)?;

    {
        let current = STATE.lock().unwrap_or_else(|e| e.into_inner());
        if current.busy() {
            return Err(i18n::t("An installation is already in progress."));
        }
    }

    set_step(&app, ToolInstallStep::Uninstalling { tool: engine.id().to_string() });
    match run_uninstall(engine).await {
        Ok(()) => {
            log::line(format!("converter-uninstall: {} removed completely", engine.id()));
            set_step(&app, ToolInstallStep::Idle);
            Ok(())
        }
        Err(reason) => {
            log::line(format!("converter-uninstall: {} note: {reason}", engine.id()));
            set_step(&app, ToolInstallStep::Failed { tool: engine.id().to_string(), reason: reason.clone() });
            Err(reason)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn picks_expected_pandoc_and_ffmpeg_windows_assets() {
        let pandoc_json = serde_json::to_vec(&json!({
            "assets": [
                {
                    "name": "pandoc-3.6-linux-amd64.tar.gz",
                    "browser_download_url": "https://github.com/jgm/pandoc/releases/download/3.6/pandoc-3.6-linux-amd64.tar.gz",
                    "size": 100
                },
                {
                    "name": "pandoc-3.6-windows-x86_64.zip",
                    "browser_download_url": "https://github.com/jgm/pandoc/releases/download/3.6/pandoc-3.6-windows-x86_64.zip",
                    "size": 35000000,
                    "digest": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
                }
            ]
        })).unwrap();
        let asset = pick_pandoc_asset(&pandoc_json, "x86_64").unwrap();
        assert_eq!(asset.name, "pandoc-3.6-windows-x86_64.zip");
        assert!(asset.sha256.is_some());

        let ffmpeg_json = serde_json::to_vec(&json!({
            "assets": [
                {
                    "name": "ffmpeg-master-latest-win64-gpl-shared.zip",
                    "browser_download_url": "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl-shared.zip",
                    "size": 500
                },
                {
                    "name": "ffmpeg-master-latest-win64-gpl.zip",
                    "browser_download_url": "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
                    "size": 130000000
                }
            ]
        })).unwrap();
        let ff = pick_ffmpeg_asset(&ffmpeg_json, "x86_64").unwrap();
        assert_eq!(ff.name, "ffmpeg-master-latest-win64-gpl.zip");
    }

    #[test]
    fn extracts_binary_and_rejects_bad_digest() {
        let mut zip = Vec::new();
        let data = b"fake-pandoc-exe";
        let compressed = miniz_oxide::deflate::compress_to_vec(data, 6);
        let name = b"pandoc-3.6/pandoc.exe";
        zip.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        zip.extend_from_slice(&[20, 0, 0, 0]);
        zip.extend_from_slice(&8u16.to_le_bytes());
        zip.extend_from_slice(&[0; 8]);
        zip.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
        zip.extend_from_slice(&(data.len() as u32).to_le_bytes());
        zip.extend_from_slice(&(name.len() as u16).to_le_bytes());
        zip.extend_from_slice(&0u16.to_le_bytes());
        zip.extend_from_slice(name);
        zip.extend_from_slice(&compressed);

        let cd_offset = zip.len() as u32;
        zip.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        zip.extend_from_slice(&[20, 3, 20, 0, 0, 0]);
        zip.extend_from_slice(&8u16.to_le_bytes());
        zip.extend_from_slice(&[0; 8]);
        zip.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
        zip.extend_from_slice(&(data.len() as u32).to_le_bytes());
        zip.extend_from_slice(&(name.len() as u16).to_le_bytes());
        zip.extend_from_slice(&[0; 12]);
        zip.extend_from_slice(&0u32.to_le_bytes());
        zip.extend_from_slice(name);

        let cd_len = (zip.len() as u32) - cd_offset;
        zip.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        zip.extend_from_slice(&[0; 4]);
        zip.extend_from_slice(&1u16.to_le_bytes());
        zip.extend_from_slice(&1u16.to_le_bytes());
        zip.extend_from_slice(&cd_len.to_le_bytes());
        zip.extend_from_slice(&cd_offset.to_le_bytes());
        zip.extend_from_slice(&0u16.to_le_bytes());

        let good_sha = sha256_hex(&zip);
        assert_eq!(extract_binary_from_zip(&zip, "pandoc.exe", Some(&good_sha)).unwrap(), data);
        assert!(extract_binary_from_zip(&zip, "pandoc.exe", Some("0000")).is_err());
    }

    #[test]
    fn remove_managed_dir_deletes_tool_and_prunes_empty_parent() {
        let root = std::env::temp_dir().join(format!("aira-conv-uninstall-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let ffmpeg_dir = root.join("ffmpeg");
        std::fs::create_dir_all(&ffmpeg_dir).unwrap();
        std::fs::write(ffmpeg_dir.join("ffmpeg.exe"), b"bin").unwrap();

        assert!(remove_managed_dir(&root, "ffmpeg").unwrap());
        assert!(!ffmpeg_dir.exists());
        assert!(!root.exists());
        assert!(!remove_managed_dir(&root, "ffmpeg").unwrap());
    }
}
