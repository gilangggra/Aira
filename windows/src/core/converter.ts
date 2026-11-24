// Pure helpers & shared types for Aira's local file converter
// (FFmpeg for video/audio + LibreOffice headless & Pandoc for documents).

export type ConverterEngine = "ffmpeg" | "libreoffice" | "pandoc";

export interface ConverterToolInfo {
  id: ConverterEngine;
  name: string;
  available: boolean;
  path: string | null;
  installUrl: string;
}

export interface ConvertOption {
  id: string;
  label: string;
  ext: string;
  engine: ConverterEngine;
  secondaryEngine: ConverterEngine | null;
  available: boolean;
}

export interface ConvertInspect {
  path: string;
  name: string;
  ext: string;
  size: number;
  options: ConvertOption[];
  tools: ConverterToolInfo[];
}

export interface ConvertResult {
  outputPath: string;
  outputName: string;
  outputDir: string;
  size: number;
  engine: string;
  durationMs: number;
}

export type ToolInstallStep =
  | { step: "idle" }
  | { step: "checking"; tool: string }
  | { step: "downloading"; tool: string; megabytes: number }
  | { step: "installing"; tool: string }
  | { step: "uninstalling"; tool: string }
  | { step: "done"; tool: string }
  | { step: "failed"; tool: string; reason: string };

export function isToolInstallBusy(step: ToolInstallStep): boolean {
  return (
    step.step === "checking" ||
    step.step === "downloading" ||
    step.step === "installing" ||
    step.step === "uninstalling"
  );
}

export function isToolInstallFailed(
  step: ToolInstallStep,
): step is Extract<ToolInstallStep, { step: "failed" }> {
  return step.step === "failed";
}

export function isToolInstallDone(
  step: ToolInstallStep,
): step is Extract<ToolInstallStep, { step: "done" }> {
  return step.step === "done";
}

export function isToolInstallFinished(step: ToolInstallStep): boolean {
  return step.step === "done" || step.step === "failed" || step.step === "idle";
}

export function makeToolInstallFailed(tool: string, reason: string): ToolInstallStep {
  return { step: "failed", tool, reason };
}

export type FileCategory = "media" | "document" | "unsupported";

const MEDIA_EXTS = new Set([
  "mp4", "mkv", "mov", "avi", "webm", "flv", "wmv", "m4v", "3gp", "gif",
  "mp3", "wav", "flac", "aac", "ogg", "opus", "m4a", "wma", "aiff",
]);

const DOC_EXTS = new Set([
  "docx", "doc", "odt", "rtf",
  "xlsx", "xls", "ods", "csv",
  "pptx", "ppt", "odp",
  "pdf", "md", "markdown", "epub", "html", "htm",
]);

/** Lowercase extension without leading dot, or "" when missing. */
export function fileExtension(nameOrPath: string): string {
  const base = nameOrPath.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

export function fileCategory(nameOrPath: string): FileCategory {
  const ext = fileExtension(nameOrPath);
  if (MEDIA_EXTS.has(ext)) return "media";
  if (DOC_EXTS.has(ext)) return "document";
  return "unsupported";
}

/** True when Aira's local converter can process this file type. */
export function isConvertibleFileName(nameOrPath: string): boolean {
  return fileCategory(nameOrPath) !== "unsupported";
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx++;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[idx]}`;
}

export function engineRequirementLabel(option: ConvertOption): string {
  const names: Record<ConverterEngine, string> = {
    ffmpeg: "FFmpeg",
    libreoffice: "LibreOffice",
    pandoc: "Pandoc",
  };
  if (option.secondaryEngine) {
    return `${names[option.engine]} + ${names[option.secondaryEngine]}`;
  }
  return names[option.engine];
}
