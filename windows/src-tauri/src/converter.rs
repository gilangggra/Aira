// Local file conversion engine — routes video/audio through FFmpeg and
// office/ebook/markup documents through LibreOffice (headless) & Pandoc,
// without requiring cloud uploads or Microsoft Office.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::{files, i18n, log, platform};

const FFMPEG_TIMEOUT: Duration = Duration::from_secs(300);
const DOC_TIMEOUT: Duration = Duration::from_secs(120);

static TEMP_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConverterEngine {
    Ffmpeg,
    Libreoffice,
    Pandoc,
}

impl ConverterEngine {
    pub fn id(self) -> &'static str {
        match self {
            ConverterEngine::Ffmpeg => "ffmpeg",
            ConverterEngine::Libreoffice => "libreoffice",
            ConverterEngine::Pandoc => "pandoc",
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            ConverterEngine::Ffmpeg => "FFmpeg",
            ConverterEngine::Libreoffice => "LibreOffice",
            ConverterEngine::Pandoc => "Pandoc",
        }
    }

    pub fn install_url(self) -> &'static str {
        match self {
            ConverterEngine::Ffmpeg => "https://ffmpeg.org/download.html",
            ConverterEngine::Libreoffice => "https://www.libreoffice.org/download/download-libreoffice/",
            ConverterEngine::Pandoc => "https://pandoc.org/installing.html",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    pub id: String,
    pub name: String,
    pub available: bool,
    pub path: Option<String>,
    pub install_url: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertOption {
    pub id: String,
    pub label: String,
    pub ext: String,
    pub engine: ConverterEngine,
    pub secondary_engine: Option<ConverterEngine>,
    pub available: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertInspect {
    pub path: String,
    pub name: String,
    pub ext: String,
    pub size: u64,
    pub options: Vec<ConvertOption>,
    pub tools: Vec<ToolInfo>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertResult {
    pub output_path: String,
    pub output_name: String,
    pub output_dir: String,
    pub size: u64,
    pub engine: String,
    pub duration_ms: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RouteKind {
    Ffmpeg,
    LibreOffice { out_format: &'static str, infilter: Option<&'static str> },
    Pandoc { to_format: Option<&'static str> },
    PandocThenLibreOffice { mid_ext: &'static str },
    LibreOfficeThenPandoc { mid_ext: &'static str, to_format: Option<&'static str> },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TargetSpec {
    pub id: &'static str,
    pub label: &'static str,
    pub ext: &'static str,
    pub suffix: &'static str,
    pub engine: ConverterEngine,
    pub secondary_engine: Option<ConverterEngine>,
    pub route: RouteKind,
}

const VIDEO_EXTS: &[&str] = &["mp4", "mkv", "mov", "avi", "webm", "flv", "wmv", "m4v", "3gp"];
const AUDIO_EXTS: &[&str] = &["mp3", "wav", "flac", "aac", "ogg", "opus", "m4a", "wma", "aiff"];
const WORD_EXTS: &[&str] = &["docx", "doc", "odt", "rtf"];
const SHEET_EXTS: &[&str] = &["xlsx", "xls", "ods", "csv"];
const SLIDE_EXTS: &[&str] = &["pptx", "ppt", "odp"];
const MARKUP_EXTS: &[&str] = &["md", "markdown"];
const HTML_EXTS: &[&str] = &["html", "htm"];

/// Pure format routing table: maps input extension to supported conversion targets.
pub fn targets_for_extension(raw_ext: &str) -> Vec<TargetSpec> {
    let ext = raw_ext.trim().trim_start_matches('.').to_ascii_lowercase();
    let mut out = Vec::new();

    if VIDEO_EXTS.contains(&ext.as_str()) {
        if ext != "mp4" {
            out.push(TargetSpec {
                id: "mp4",
                label: "MP4 Video",
                ext: "mp4",
                suffix: "",
                engine: ConverterEngine::Ffmpeg,
                secondary_engine: None,
                route: RouteKind::Ffmpeg,
            });
        }
        out.push(TargetSpec {
            id: "compress_mp4",
            label: "Compress MP4",
            ext: "mp4",
            suffix: "_compressed",
            engine: ConverterEngine::Ffmpeg,
            secondary_engine: None,
            route: RouteKind::Ffmpeg,
        });
        out.push(TargetSpec {
            id: "mp3",
            label: "Extract MP3",
            ext: "mp3",
            suffix: "",
            engine: ConverterEngine::Ffmpeg,
            secondary_engine: None,
            route: RouteKind::Ffmpeg,
        });
        out.push(TargetSpec {
            id: "gif",
            label: "GIF",
            ext: "gif",
            suffix: "",
            engine: ConverterEngine::Ffmpeg,
            secondary_engine: None,
            route: RouteKind::Ffmpeg,
        });
        return out;
    }

    if ext == "gif" {
        out.push(TargetSpec {
            id: "mp4",
            label: "MP4 Video",
            ext: "mp4",
            suffix: "",
            engine: ConverterEngine::Ffmpeg,
            secondary_engine: None,
            route: RouteKind::Ffmpeg,
        });
        out.push(TargetSpec {
            id: "compress_gif",
            label: "Compress GIF",
            ext: "gif",
            suffix: "_compressed",
            engine: ConverterEngine::Ffmpeg,
            secondary_engine: None,
            route: RouteKind::Ffmpeg,
        });
        return out;
    }

    if AUDIO_EXTS.contains(&ext.as_str()) {
        if ext != "mp3" {
            out.push(TargetSpec {
                id: "mp3",
                label: "MP3 Audio",
                ext: "mp3",
                suffix: "",
                engine: ConverterEngine::Ffmpeg,
                secondary_engine: None,
                route: RouteKind::Ffmpeg,
            });
        }
        if ext != "wav" {
            out.push(TargetSpec {
                id: "wav",
                label: "WAV Audio",
                ext: "wav",
                suffix: "",
                engine: ConverterEngine::Ffmpeg,
                secondary_engine: None,
                route: RouteKind::Ffmpeg,
            });
        }
        if ext != "m4a" {
            out.push(TargetSpec {
                id: "m4a",
                label: "M4A Audio",
                ext: "m4a",
                suffix: "",
                engine: ConverterEngine::Ffmpeg,
                secondary_engine: None,
                route: RouteKind::Ffmpeg,
            });
        }
        if ext != "ogg" {
            out.push(TargetSpec {
                id: "ogg",
                label: "OGG Audio",
                ext: "ogg",
                suffix: "",
                engine: ConverterEngine::Ffmpeg,
                secondary_engine: None,
                route: RouteKind::Ffmpeg,
            });
        }
        return out;
    }

    if WORD_EXTS.contains(&ext.as_str()) {
        out.push(TargetSpec {
            id: "pdf",
            label: "PDF",
            ext: "pdf",
            suffix: "",
            engine: ConverterEngine::Libreoffice,
            secondary_engine: None,
            route: RouteKind::LibreOffice { out_format: "pdf", infilter: None },
        });
        if ext != "docx" {
            out.push(TargetSpec {
                id: "docx",
                label: "Word (DOCX)",
                ext: "docx",
                suffix: "",
                engine: ConverterEngine::Libreoffice,
                secondary_engine: None,
                route: RouteKind::LibreOffice { out_format: "docx", infilter: None },
            });
        }
        if ext == "docx" || ext == "odt" {
            out.push(TargetSpec {
                id: "md",
                label: "Markdown",
                ext: "md",
                suffix: "",
                engine: ConverterEngine::Pandoc,
                secondary_engine: None,
                route: RouteKind::Pandoc { to_format: Some("gfm") },
            });
            out.push(TargetSpec {
                id: "epub",
                label: "EPUB",
                ext: "epub",
                suffix: "",
                engine: ConverterEngine::Pandoc,
                secondary_engine: None,
                route: RouteKind::Pandoc { to_format: None },
            });
        } else {
            out.push(TargetSpec {
                id: "md",
                label: "Markdown",
                ext: "md",
                suffix: "",
                engine: ConverterEngine::Libreoffice,
                secondary_engine: Some(ConverterEngine::Pandoc),
                route: RouteKind::LibreOfficeThenPandoc { mid_ext: "docx", to_format: Some("gfm") },
            });
            out.push(TargetSpec {
                id: "epub",
                label: "EPUB",
                ext: "epub",
                suffix: "",
                engine: ConverterEngine::Libreoffice,
                secondary_engine: Some(ConverterEngine::Pandoc),
                route: RouteKind::LibreOfficeThenPandoc { mid_ext: "docx", to_format: None },
            });
        }
        out.push(TargetSpec {
            id: "html",
            label: "HTML",
            ext: "html",
            suffix: "",
            engine: ConverterEngine::Libreoffice,
            secondary_engine: None,
            route: RouteKind::LibreOffice { out_format: "html", infilter: None },
        });
        out.push(TargetSpec {
            id: "txt",
            label: "Plain Text",
            ext: "txt",
            suffix: "",
            engine: ConverterEngine::Libreoffice,
            secondary_engine: None,
            route: RouteKind::LibreOffice { out_format: "txt:Text", infilter: None },
        });
        return out;
    }

    if SHEET_EXTS.contains(&ext.as_str()) {
        out.push(TargetSpec {
            id: "pdf",
            label: "PDF",
            ext: "pdf",
            suffix: "",
            engine: ConverterEngine::Libreoffice,
            secondary_engine: None,
            route: RouteKind::LibreOffice { out_format: "pdf", infilter: None },
        });
        if ext != "xlsx" {
            out.push(TargetSpec {
                id: "xlsx",
                label: "Excel (XLSX)",
                ext: "xlsx",
                suffix: "",
                engine: ConverterEngine::Libreoffice,
                secondary_engine: None,
                route: RouteKind::LibreOffice { out_format: "xlsx", infilter: None },
            });
        }
        if ext != "csv" {
            out.push(TargetSpec {
                id: "csv",
                label: "CSV",
                ext: "csv",
                suffix: "",
                engine: ConverterEngine::Libreoffice,
                secondary_engine: None,
                route: RouteKind::LibreOffice { out_format: "csv", infilter: None },
            });
        }
        return out;
    }

    if SLIDE_EXTS.contains(&ext.as_str()) {
        out.push(TargetSpec {
            id: "pdf",
            label: "PDF",
            ext: "pdf",
            suffix: "",
            engine: ConverterEngine::Libreoffice,
            secondary_engine: None,
            route: RouteKind::LibreOffice { out_format: "pdf", infilter: None },
        });
        if ext != "pptx" {
            out.push(TargetSpec {
                id: "pptx",
                label: "PowerPoint (PPTX)",
                ext: "pptx",
                suffix: "",
                engine: ConverterEngine::Libreoffice,
                secondary_engine: None,
                route: RouteKind::LibreOffice { out_format: "pptx", infilter: None },
            });
        }
        return out;
    }

    if ext == "pdf" {
        out.push(TargetSpec {
            id: "docx",
            label: "Word (DOCX)",
            ext: "docx",
            suffix: "",
            engine: ConverterEngine::Libreoffice,
            secondary_engine: None,
            route: RouteKind::LibreOffice {
                out_format: "docx",
                infilter: Some("writer_pdf_import"),
            },
        });
        out.push(TargetSpec {
            id: "txt",
            label: "Plain Text",
            ext: "txt",
            suffix: "",
            engine: ConverterEngine::Libreoffice,
            secondary_engine: None,
            route: RouteKind::LibreOffice {
                out_format: "txt:Text",
                infilter: Some("writer_pdf_import"),
            },
        });
        return out;
    }

    if MARKUP_EXTS.contains(&ext.as_str()) {
        out.push(TargetSpec {
            id: "pdf",
            label: "PDF",
            ext: "pdf",
            suffix: "",
            engine: ConverterEngine::Pandoc,
            secondary_engine: Some(ConverterEngine::Libreoffice),
            route: RouteKind::PandocThenLibreOffice { mid_ext: "docx" },
        });
        out.push(TargetSpec {
            id: "docx",
            label: "Word (DOCX)",
            ext: "docx",
            suffix: "",
            engine: ConverterEngine::Pandoc,
            secondary_engine: None,
            route: RouteKind::Pandoc { to_format: None },
        });
        out.push(TargetSpec {
            id: "epub",
            label: "EPUB",
            ext: "epub",
            suffix: "",
            engine: ConverterEngine::Pandoc,
            secondary_engine: None,
            route: RouteKind::Pandoc { to_format: None },
        });
        out.push(TargetSpec {
            id: "html",
            label: "HTML",
            ext: "html",
            suffix: "",
            engine: ConverterEngine::Pandoc,
            secondary_engine: None,
            route: RouteKind::Pandoc { to_format: None },
        });
        return out;
    }

    if ext == "epub" {
        out.push(TargetSpec {
            id: "pdf",
            label: "PDF",
            ext: "pdf",
            suffix: "",
            engine: ConverterEngine::Pandoc,
            secondary_engine: Some(ConverterEngine::Libreoffice),
            route: RouteKind::PandocThenLibreOffice { mid_ext: "docx" },
        });
        out.push(TargetSpec {
            id: "docx",
            label: "Word (DOCX)",
            ext: "docx",
            suffix: "",
            engine: ConverterEngine::Pandoc,
            secondary_engine: None,
            route: RouteKind::Pandoc { to_format: None },
        });
        out.push(TargetSpec {
            id: "md",
            label: "Markdown",
            ext: "md",
            suffix: "",
            engine: ConverterEngine::Pandoc,
            secondary_engine: None,
            route: RouteKind::Pandoc { to_format: Some("gfm") },
        });
        out.push(TargetSpec {
            id: "html",
            label: "HTML",
            ext: "html",
            suffix: "",
            engine: ConverterEngine::Pandoc,
            secondary_engine: None,
            route: RouteKind::Pandoc { to_format: None },
        });
        return out;
    }

    if HTML_EXTS.contains(&ext.as_str()) {
        out.push(TargetSpec {
            id: "pdf",
            label: "PDF",
            ext: "pdf",
            suffix: "",
            engine: ConverterEngine::Libreoffice,
            secondary_engine: None,
            route: RouteKind::LibreOffice { out_format: "pdf", infilter: None },
        });
        out.push(TargetSpec {
            id: "docx",
            label: "Word (DOCX)",
            ext: "docx",
            suffix: "",
            engine: ConverterEngine::Pandoc,
            secondary_engine: None,
            route: RouteKind::Pandoc { to_format: None },
        });
        out.push(TargetSpec {
            id: "md",
            label: "Markdown",
            ext: "md",
            suffix: "",
            engine: ConverterEngine::Pandoc,
            secondary_engine: None,
            route: RouteKind::Pandoc { to_format: Some("gfm") },
        });
        out.push(TargetSpec {
            id: "epub",
            label: "EPUB",
            ext: "epub",
            suffix: "",
            engine: ConverterEngine::Pandoc,
            secondary_engine: None,
            route: RouteKind::Pandoc { to_format: None },
        });
    }

    out
}

// ── Binary Discovery ──────────────────────────────────────────────────────────

fn find_winget_ffmpeg() -> Option<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from)?;
    let packages = local.join("Microsoft").join("WinGet").join("Packages");
    let entries = std::fs::read_dir(packages).ok()?;
    for pkg in entries.flatten() {
        let name = pkg.file_name().to_string_lossy().to_ascii_lowercase();
        if !name.contains("ffmpeg") {
            continue;
        }
        let direct = pkg.path().join("ffmpeg.exe");
        if direct.is_file() {
            return Some(direct);
        }
        let Ok(subs) = std::fs::read_dir(pkg.path()) else { continue };
        for sub in subs.flatten() {
            let bin = sub.path().join("bin").join("ffmpeg.exe");
            if bin.is_file() {
                return Some(bin);
            }
        }
    }
    None
}

pub fn find_tool(engine: ConverterEngine) -> Option<PathBuf> {
    match engine {
        ConverterEngine::Ffmpeg => {
            if let Some(p) = platform::find_on_path("ffmpeg") {
                return Some(p);
            }
            #[cfg(windows)]
            {
                let mut candidates = Vec::new();
                let local = platform::local_dir();
                candidates.push(local.join("tools").join("ffmpeg").join("ffmpeg.exe"));
                candidates.push(local.join("tools").join("ffmpeg").join("bin").join("ffmpeg.exe"));
                if let Some(la) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
                    candidates.push(la.join("Microsoft").join("WinGet").join("Links").join("ffmpeg.exe"));
                }
                if let Some(home) = std::env::var_os("USERPROFILE").map(PathBuf::from) {
                    candidates.push(home.join("scoop").join("shims").join("ffmpeg.exe"));
                }
                candidates.push(PathBuf::from(r"C:\ProgramData\chocolatey\bin\ffmpeg.exe"));
                candidates.push(PathBuf::from(r"C:\ffmpeg\bin\ffmpeg.exe"));
                candidates.push(PathBuf::from(r"C:\Program Files\ffmpeg\bin\ffmpeg.exe"));
                if let Some(found) = candidates.into_iter().find(|p| p.is_file()) {
                    return Some(found);
                }
                return find_winget_ffmpeg();
            }
            #[cfg(not(windows))]
            {
                ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/snap/bin/ffmpeg"]
                    .into_iter()
                    .map(PathBuf::from)
                    .find(|p| p.is_file())
            }
        }
        ConverterEngine::Libreoffice => {
            if let Some(p) = platform::find_on_path("soffice").or_else(|| platform::find_on_path("libreoffice")) {
                return Some(p);
            }
            #[cfg(windows)]
            {
                let mut candidates = vec![
                    PathBuf::from(r"C:\Program Files\LibreOffice\program\soffice.exe"),
                    PathBuf::from(r"C:\Program Files (x86)\LibreOffice\program\soffice.exe"),
                ];
                if let Some(la) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
                    candidates.push(la.join("Programs").join("LibreOffice").join("program").join("soffice.exe"));
                }
                candidates.into_iter().find(|p| p.is_file())
            }
            #[cfg(not(windows))]
            {
                [
                    "/usr/bin/soffice",
                    "/usr/bin/libreoffice",
                    "/usr/local/bin/libreoffice",
                    "/snap/bin/libreoffice",
                ]
                .into_iter()
                .map(PathBuf::from)
                .find(|p| p.is_file())
            }
        }
        ConverterEngine::Pandoc => {
            if let Some(p) = platform::find_on_path("pandoc") {
                return Some(p);
            }
            #[cfg(windows)]
            {
                let mut candidates = Vec::new();
                let local = platform::local_dir();
                candidates.push(local.join("tools").join("pandoc").join("pandoc.exe"));
                candidates.push(local.join("tools").join("pandoc").join("bin").join("pandoc.exe"));
                if let Some(la) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
                    candidates.push(la.join("Pandoc").join("pandoc.exe"));
                    candidates.push(la.join("Microsoft").join("WinGet").join("Links").join("pandoc.exe"));
                }
                if let Some(home) = std::env::var_os("USERPROFILE").map(PathBuf::from) {
                    candidates.push(home.join("scoop").join("shims").join("pandoc.exe"));
                }
                candidates.push(PathBuf::from(r"C:\Program Files\Pandoc\pandoc.exe"));
                candidates.push(PathBuf::from(r"C:\Program Files (x86)\Pandoc\pandoc.exe"));
                candidates.push(PathBuf::from(r"C:\ProgramData\chocolatey\bin\pandoc.exe"));
                candidates.into_iter().find(|p| p.is_file())
            }
            #[cfg(not(windows))]
            {
                ["/usr/bin/pandoc", "/usr/local/bin/pandoc"]
                    .into_iter()
                    .map(PathBuf::from)
                    .find(|p| p.is_file())
            }
        }
    }
}

pub fn list_tools() -> Vec<ToolInfo> {
    [ConverterEngine::Ffmpeg, ConverterEngine::Libreoffice, ConverterEngine::Pandoc]
        .into_iter()
        .map(|eng| {
            let found = find_tool(eng);
            ToolInfo {
                id: eng.id().to_string(),
                name: eng.display_name().to_string(),
                available: found.is_some(),
                path: found.map(|p| p.to_string_lossy().to_string()),
                install_url: eng.install_url().to_string(),
            }
        })
        .collect()
}

// ── Pure Argument & Path Helpers ──────────────────────────────────────────────

pub fn path_to_file_url(path: &Path) -> String {
    let raw = path.to_string_lossy().replace('\\', "/");
    let normalized = if raw.starts_with('/') { raw } else { format!("/{raw}") };
    let encoded: String = normalized
        .chars()
        .map(|c| if c == ' ' { "%20".to_string() } else { c.to_string() })
        .collect();
    format!("file://{encoded}")
}

/// Returns a path in `dir` like `stem{suffix}.ext` without overwriting an existing file.
pub fn non_overwriting_path(dir: &Path, stem: &str, suffix: &str, ext: &str) -> PathBuf {
    let base = dir.join(format!("{stem}{suffix}.{ext}"));
    if !base.exists() {
        return base;
    }
    for i in 2..1000 {
        let candidate = dir.join(format!("{stem}{suffix} ({i}).{ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!("{stem}{suffix}_{}.{ext}", TEMP_SEQ.fetch_add(1, Ordering::Relaxed)))
}

pub fn ffmpeg_args(input: &Path, output: &Path, target_id: &str) -> Result<Vec<String>, String> {
    let inp = input.to_string_lossy().to_string();
    let out = output.to_string_lossy().to_string();
    let args = match target_id {
        "mp4" => vec![
            "-y".into(),
            "-i".into(),
            inp,
            "-c:v".into(),
            "libx264".into(),
            "-preset".into(),
            "medium".into(),
            "-crf".into(),
            "23".into(),
            "-vf".into(),
            "scale=trunc(iw/2)*2:trunc(ih/2)*2".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            "192k".into(),
            "-movflags".into(),
            "+faststart".into(),
            out,
        ],
        "compress_mp4" => vec![
            "-y".into(),
            "-i".into(),
            inp,
            "-c:v".into(),
            "libx264".into(),
            "-preset".into(),
            "medium".into(),
            "-crf".into(),
            "28".into(),
            "-vf".into(),
            "scale='min(1280,iw)':-2".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            "128k".into(),
            "-movflags".into(),
            "+faststart".into(),
            out,
        ],
        "mp3" => vec![
            "-y".into(),
            "-i".into(),
            inp,
            "-vn".into(),
            "-c:a".into(),
            "libmp3lame".into(),
            "-q:a".into(),
            "2".into(),
            out,
        ],
        "wav" => vec![
            "-y".into(),
            "-i".into(),
            inp,
            "-vn".into(),
            "-c:a".into(),
            "pcm_s16le".into(),
            out,
        ],
        "m4a" => vec![
            "-y".into(),
            "-i".into(),
            inp,
            "-vn".into(),
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            "192k".into(),
            out,
        ],
        "ogg" => vec![
            "-y".into(),
            "-i".into(),
            inp,
            "-vn".into(),
            "-c:a".into(),
            "libvorbis".into(),
            "-q:a".into(),
            "5".into(),
            out,
        ],
        "gif" => vec![
            "-y".into(),
            "-i".into(),
            inp,
            "-vf".into(),
            "fps=12,scale='min(480,iw)':-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse".into(),
            "-loop".into(),
            "0".into(),
            out,
        ],
        "compress_gif" => vec![
            "-y".into(),
            "-i".into(),
            inp,
            "-vf".into(),
            "fps=10,scale='min(360,iw)':-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse".into(),
            "-loop".into(),
            "0".into(),
            out,
        ],
        other => return Err(format!("Unsupported FFmpeg target: {other}")),
    };
    Ok(args)
}

pub fn libreoffice_args(
    input: &Path,
    out_dir: &Path,
    profile_dir: &Path,
    out_format: &str,
    infilter: Option<&str>,
) -> Vec<String> {
    let mut args = vec![
        "--headless".into(),
        "--nologo".into(),
        "--nofirststartwizard".into(),
        "--nodefault".into(),
        "--norestore".into(),
        format!("-env:UserInstallation={}", path_to_file_url(profile_dir)),
    ];
    if let Some(filter) = infilter {
        args.push(format!("--infilter={filter}"));
    }
    args.push("--convert-to".into());
    args.push(out_format.into());
    args.push("--outdir".into());
    args.push(out_dir.to_string_lossy().to_string());
    args.push(input.to_string_lossy().to_string());
    args
}

pub fn pandoc_args(input: &Path, output: &Path, to_format: Option<&str>) -> Vec<String> {
    let mut args = vec![input.to_string_lossy().to_string()];
    if let Some(fmt) = to_format {
        args.push("-t".into());
        args.push(fmt.into());
    }
    if output.extension().is_some_and(|e| e.eq_ignore_ascii_case("html")) {
        args.push("-s".into());
    }
    args.push("-o".into());
    args.push(output.to_string_lossy().to_string());
    args
}

// ── Execution ─────────────────────────────────────────────────────────────────

struct TempDirGuard(PathBuf);

impl TempDirGuard {
    fn create(prefix: &str) -> Result<Self, String> {
        let id = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("{prefix}-{}-{id}", std::process::id()));
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        Ok(Self(dir))
    }
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn run_tool(exe: &Path, args: &[String], timeout: Duration) -> Result<(), String> {
    let mut std_cmd = std::process::Command::new(exe);
    std_cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    platform::no_console(&mut std_cmd);

    let mut cmd = tokio::process::Command::from(std_cmd);
    cmd.kill_on_drop(true);
    let child = cmd.spawn().map_err(|e| i18n::tf("Conversion failed: {error}", &[("error", &e.to_string())]))?;

    let output = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| i18n::t("Conversion timed out."))?
        .map_err(|e| i18n::tf("Conversion failed: {error}", &[("error", &e.to_string())]))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let msg = stderr
            .lines()
            .rev()
            .chain(stdout.lines().rev())
            .map(str::trim)
            .find(|l| !l.is_empty())
            .unwrap_or("process exited with error");
        let short: String = msg.chars().take(180).collect();
        return Err(i18n::tf("Conversion failed: {error}", &[("error", &short)]));
    }
    Ok(())
}

fn resolve_source(path: &str, fallback_path: Option<&str>) -> Result<PathBuf, String> {
    if !files::is_allowed_source(path) {
        if let Some(fb) = fallback_path {
            if files::is_allowed_source(fb) && Path::new(fb).is_file() {
                return Ok(PathBuf::from(fb));
            }
        }
        return Err(i18n::t("Only files dropped or selected in Aira can be converted."));
    }
    let p = PathBuf::from(path);
    if p.is_file() {
        return Ok(p);
    }
    if let Some(fb) = fallback_path {
        if files::is_allowed_source(fb) {
            let fbp = PathBuf::from(fb);
            if fbp.is_file() {
                return Ok(fbp);
            }
        }
    }
    Err(i18n::t("Source file does not exist."))
}

fn default_output_dir(source: &Path) -> PathBuf {
    let inbox = files::inbox_dir();
    if let (Ok(canon_src), Ok(canon_inbox)) = (std::fs::canonicalize(source), std::fs::canonicalize(&inbox)) {
        if canon_src.starts_with(&canon_inbox) {
            let dl = platform::home_dir().join("Downloads");
            if dl.is_dir() {
                return dl;
            }
        }
    }
    if let Some(parent) = source.parent() {
        if parent.is_dir() {
            return parent.to_path_buf();
        }
    }
    inbox
}

fn find_generated_file(dir: &Path, stem: &str, ext: &str) -> Option<PathBuf> {
    let expected = dir.join(format!("{stem}.{ext}"));
    if expected.is_file() {
        return Some(expected);
    }
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() && path.extension().is_some_and(|e| e.eq_ignore_ascii_case(ext)) {
            return Some(path);
        }
    }
    None
}

async fn run_libreoffice(
    soffice: &Path,
    input: &Path,
    out_dir: &Path,
    out_format: &str,
    infilter: Option<&str>,
    target_ext: &str,
) -> Result<PathBuf, String> {
    let profile = TempDirGuard::create("aira-lo-profile")?;
    let args = libreoffice_args(input, out_dir, &profile.0, out_format, infilter);
    run_tool(soffice, &args, DOC_TIMEOUT).await?;
    let stem = input.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    find_generated_file(out_dir, &stem, target_ext)
        .ok_or_else(|| i18n::t("Converted file was not created."))
}

fn move_into_place(src: &Path, dest: &Path) -> Result<(), String> {
    if std::fs::rename(src, dest).is_ok() {
        return Ok(());
    }
    std::fs::copy(src, dest).map_err(|e| i18n::tf("Conversion failed: {error}", &[("error", &e.to_string())]))?;
    let _ = std::fs::remove_file(src);
    Ok(())
}

fn require_tool(engine: ConverterEngine) -> Result<PathBuf, String> {
    find_tool(engine).ok_or_else(|| i18n::tf("{tool} is not installed yet.", &[("tool", engine.display_name())]))
}

// ── Tauri Commands ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn converter_tools() -> Vec<ToolInfo> {
    list_tools()
}

#[tauri::command]
pub fn converter_inspect(path: String, fallback_path: Option<String>) -> Result<ConvertInspect, String> {
    let source = resolve_source(&path, fallback_path.as_deref())?;
    let meta = std::fs::metadata(&source).map_err(|e| e.to_string())?;
    let name = source
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());
    let ext = source
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();

    let tools = list_tools();
    let has = |eng: ConverterEngine| tools.iter().any(|t| t.id == eng.id() && t.available);
    let options = targets_for_extension(&ext)
        .into_iter()
        .map(|spec| {
            let primary_ok = has(spec.engine);
            let secondary_ok = spec.secondary_engine.is_none_or(has);
            ConvertOption {
                id: spec.id.to_string(),
                label: spec.label.to_string(),
                ext: spec.ext.to_string(),
                engine: spec.engine,
                secondary_engine: spec.secondary_engine,
                available: primary_ok && secondary_ok,
            }
        })
        .collect();

    Ok(ConvertInspect {
        path: source.to_string_lossy().to_string(),
        name,
        ext,
        size: meta.len(),
        options,
        tools,
    })
}

#[tauri::command]
pub async fn converter_convert(
    path: String,
    fallback_path: Option<String>,
    target: String,
) -> Result<ConvertResult, String> {
    let started = Instant::now();
    let source = resolve_source(&path, fallback_path.as_deref())?;
    let ext = source
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();

    let spec = targets_for_extension(&ext)
        .into_iter()
        .find(|s| s.id == target)
        .ok_or_else(|| {
            i18n::tf(
                "Conversion format \"{target}\" is not supported for .{ext} files.",
                &[("target", &target), ("ext", &ext)],
            )
        })?;

    let out_dir = default_output_dir(&source);
    std::fs::create_dir_all(&out_dir)
        .map_err(|e| i18n::tf("Conversion failed: {error}", &[("error", &e.to_string())]))?;
    let stem = source
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "output".into());
    let dest = non_overwriting_path(&out_dir, &stem, spec.suffix, spec.ext);

    let engine_label = match spec.route {
        RouteKind::Ffmpeg => {
            let ffmpeg = require_tool(ConverterEngine::Ffmpeg)?;
            let temp_work = TempDirGuard::create("aira-ffmpeg")?;
            let temp_out = temp_work.0.join(format!("out.{}", spec.ext));
            let args = ffmpeg_args(&source, &temp_out, spec.id)?;
            run_tool(&ffmpeg, &args, FFMPEG_TIMEOUT).await?;
            if !temp_out.is_file() {
                return Err(i18n::t("Converted file was not created."));
            }
            move_into_place(&temp_out, &dest)?;
            "FFmpeg".to_string()
        }
        RouteKind::LibreOffice { out_format, infilter } => {
            let soffice = require_tool(ConverterEngine::Libreoffice)?;
            let temp_work = TempDirGuard::create("aira-lo-out")?;
            let generated = run_libreoffice(&soffice, &source, &temp_work.0, out_format, infilter, spec.ext).await?;
            move_into_place(&generated, &dest)?;
            "LibreOffice".to_string()
        }
        RouteKind::Pandoc { to_format } => {
            let pandoc = require_tool(ConverterEngine::Pandoc)?;
            let temp_work = TempDirGuard::create("aira-pandoc")?;
            let temp_out = temp_work.0.join(format!("out.{}", spec.ext));
            let args = pandoc_args(&source, &temp_out, to_format);
            run_tool(&pandoc, &args, DOC_TIMEOUT).await?;
            if !temp_out.is_file() {
                return Err(i18n::t("Converted file was not created."));
            }
            move_into_place(&temp_out, &dest)?;
            "Pandoc".to_string()
        }
        RouteKind::PandocThenLibreOffice { mid_ext } => {
            let pandoc = require_tool(ConverterEngine::Pandoc)?;
            let soffice = require_tool(ConverterEngine::Libreoffice)?;
            let temp_work = TempDirGuard::create("aira-pandoc-lo")?;
            let mid = temp_work.0.join(format!("{stem}.{mid_ext}"));
            let p_args = pandoc_args(&source, &mid, None);
            run_tool(&pandoc, &p_args, DOC_TIMEOUT).await?;
            if !mid.is_file() {
                return Err(i18n::t("Converted file was not created."));
            }
            let generated = run_libreoffice(&soffice, &mid, &temp_work.0, spec.ext, None, spec.ext).await?;
            move_into_place(&generated, &dest)?;
            "Pandoc + LibreOffice".to_string()
        }
        RouteKind::LibreOfficeThenPandoc { mid_ext, to_format } => {
            let soffice = require_tool(ConverterEngine::Libreoffice)?;
            let pandoc = require_tool(ConverterEngine::Pandoc)?;
            let temp_work = TempDirGuard::create("aira-lo-pandoc")?;
            let mid = run_libreoffice(&soffice, &source, &temp_work.0, mid_ext, None, mid_ext).await?;
            let temp_out = temp_work.0.join(format!("out.{}", spec.ext));
            let p_args = pandoc_args(&mid, &temp_out, to_format);
            run_tool(&pandoc, &p_args, DOC_TIMEOUT).await?;
            if !temp_out.is_file() {
                return Err(i18n::t("Converted file was not created."));
            }
            move_into_place(&temp_out, &dest)?;
            "LibreOffice + Pandoc".to_string()
        }
    };

    let size = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
    let output_path = dest.to_string_lossy().to_string();
    files::allow_source(output_path.clone());
    log::line(format!("converter: {} -> {} ({engine_label})", source.display(), dest.display()));

    Ok(ConvertResult {
        output_path,
        output_name: dest.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        output_dir: out_dir.to_string_lossy().to_string(),
        size,
        engine: engine_label,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

#[tauri::command]
pub async fn converter_pick_file(app: tauri::AppHandle) -> Option<String> {
    let title = i18n::t("Choose a file");
    let picked = tauri::async_runtime::spawn_blocking(move || platform::pick_file(&app, &title))
        .await
        .ok()
        .flatten();
    if let Some(ref p) = picked {
        files::allow_source(p.clone());
    }
    picked
}

#[tauri::command]
pub fn converter_reveal_output(path: String) -> Result<(), String> {
    if !files::is_allowed_source(&path) {
        return Err(i18n::t("Only files dropped or selected in Aira can be converted."));
    }
    let p = Path::new(&path);
    let target = if p.is_file() { p.parent().unwrap_or(p) } else { p };
    if target.is_dir() {
        platform::reveal_folder(&target.to_string_lossy());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_video_and_audio_extensions_to_ffmpeg_targets() {
        let mkv = targets_for_extension(".MKV");
        let ids: Vec<_> = mkv.iter().map(|t| t.id).collect();
        assert_eq!(ids, vec!["mp4", "compress_mp4", "mp3", "gif"]);
        assert!(mkv.iter().all(|t| t.engine == ConverterEngine::Ffmpeg));

        let mp4 = targets_for_extension("mp4");
        let mp4_ids: Vec<_> = mp4.iter().map(|t| t.id).collect();
        assert_eq!(mp4_ids, vec!["compress_mp4", "mp3", "gif"]);

        let wav = targets_for_extension("wav");
        let wav_ids: Vec<_> = wav.iter().map(|t| t.id).collect();
        assert_eq!(wav_ids, vec!["mp3", "m4a", "ogg"]);
    }

    #[test]
    fn maps_office_markdown_and_epub_to_libreoffice_and_pandoc() {
        let docx = targets_for_extension("docx");
        assert!(docx.iter().any(|t| t.id == "pdf" && t.engine == ConverterEngine::Libreoffice));
        assert!(docx.iter().any(|t| t.id == "md" && t.engine == ConverterEngine::Pandoc));
        assert!(docx.iter().any(|t| t.id == "epub" && t.engine == ConverterEngine::Pandoc));

        let xlsx = targets_for_extension("xlsx");
        assert!(xlsx.iter().any(|t| t.id == "pdf" && t.engine == ConverterEngine::Libreoffice));
        assert!(xlsx.iter().any(|t| t.id == "csv" && t.engine == ConverterEngine::Libreoffice));

        let pptx = targets_for_extension("pptx");
        assert!(pptx.iter().any(|t| t.id == "pdf" && t.engine == ConverterEngine::Libreoffice));

        let md = targets_for_extension("md");
        assert!(md.iter().any(|t| {
            t.id == "pdf"
                && t.engine == ConverterEngine::Pandoc
                && t.secondary_engine == Some(ConverterEngine::Libreoffice)
        }));
        assert!(md.iter().any(|t| t.id == "docx" && t.engine == ConverterEngine::Pandoc));
        assert!(md.iter().any(|t| t.id == "epub" && t.engine == ConverterEngine::Pandoc));

        let epub = targets_for_extension("epub");
        assert!(epub.iter().any(|t| t.id == "docx" && t.engine == ConverterEngine::Pandoc));
        assert!(epub.iter().any(|t| t.id == "md" && t.engine == ConverterEngine::Pandoc));
    }

    #[test]
    fn builds_expected_command_arguments() {
        let in_p = Path::new("clip.mov");
        let out_p = Path::new("clip.mp3");
        let args = ffmpeg_args(in_p, out_p, "mp3").unwrap();
        assert_eq!(args, vec!["-y", "-i", "clip.mov", "-vn", "-c:a", "libmp3lame", "-q:a", "2", "clip.mp3"]);

        let gif_args = ffmpeg_args(in_p, Path::new("clip.gif"), "gif").unwrap();
        assert!(gif_args.iter().any(|a| a.contains("palettegen")));

        let lo_args = libreoffice_args(
            Path::new("deck.pptx"),
            Path::new("/tmp/out"),
            Path::new("/tmp/lo profile"),
            "pdf",
            None,
        );
        assert!(lo_args.contains(&"--headless".to_string()));
        assert!(lo_args.contains(&"-env:UserInstallation=file:///tmp/lo%20profile".to_string()));
        assert!(lo_args.contains(&"pdf".to_string()));

        let pd_args = pandoc_args(Path::new("readme.md"), Path::new("readme.html"), None);
        assert_eq!(pd_args, vec!["readme.md", "-s", "-o", "readme.html"]);
    }

    #[test]
    fn non_overwriting_path_increments_on_collision() {
        let dir = std::env::temp_dir().join(format!("aira-conv-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p1 = non_overwriting_path(&dir, "doc", "", "pdf");
        assert_eq!(p1, dir.join("doc.pdf"));
        std::fs::write(&p1, b"1").unwrap();
        let p2 = non_overwriting_path(&dir, "doc", "", "pdf");
        assert_eq!(p2, dir.join("doc (2).pdf"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unallowed_paths_are_rejected_and_allowed_paths_pass() {
        assert!(resolve_source(r"C:\definitely-not-dropped-file.docx", None).is_err());

        let dir = std::env::temp_dir().join(format!("aira-conv-allow-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("sample.md");
        std::fs::write(&file, b"# hi").unwrap();
        let path_str = file.to_string_lossy().to_string();
        files::allow_source(path_str.clone());
        assert_eq!(resolve_source(&path_str, None).unwrap(), file);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
