// Clipboard history state, smart content classification, deduplication, and local persistence.

import { N_ } from "../i18n/i18n";
import { Bridge, IS_TAURI, type ClipboardImagePayload } from "./bridge";

export type ClipboardKind = "text" | "link" | "color" | "code" | "image";
export type ClipboardFilter = "all" | "pinned" | "links" | "images";

export interface ClipboardEntry {
  id: string;
  text: string;
  kind: ClipboardKind;
  pinned: boolean;
  copiedAt: number;
  sensitive?: boolean;
  imagePath?: string;
  imageWidth?: number;
  imageHeight?: number;
  imageThumb?: string;
}

export const MAX_CLIPBOARD_ITEMS = 30;
export const MAX_CLIPBOARD_CHARS = 16_000;

const STORAGE_KEY = "airaClipboardHistory";
const PAUSED_KEY = "airaClipboardPaused";
const SUPPRESSED_KEY = "airaClipboardSuppressed";

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

const SENSITIVE_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]+PRIVATE KEY-----/,
  /\bsk-(?:proj-|ant-api\d*-|live_|test_)?[A-Za-z0-9_-]{20,}\b/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[0-9A-Za-z-]{15,}\b/,
  /\bBearer\s+[A-Za-z0-9._-]{20,}\b/i,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /^\s*(?:[A-Z0-9_]*?(?:PASSWORD|PASSWD|SECRET|API_KEY|AUTH_TOKEN|ACCESS_TOKEN|PRIVATE_KEY))\s*[:=]\s*["']?[^\s"']{6,}["']?\s*$/im,
];

const CODE_TOKEN_RE = /(?:=>|\bfunction\s+[A-Za-z_$]|\b(?:const|let|var)\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=|\b(?:import|export)\s+(?:\{|\*|[A-Za-z_$])|\b(?:pub\s+)?fn\s+[a-z_][a-z0-9_]*\s*\(|\bdef\s+[a-z_][a-z0-9_]*\s*\(|\bSELECT\b.+\bFROM\b|<\/[a-zA-Z][a-zA-Z0-9-]*>)/;

function safeStorage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function isSensitiveClipboardText(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  return SENSITIVE_PATTERNS.some((re) => re.test(trimmed));
}

export function maskSensitiveText(raw: string): string {
  const trimmed = raw.trim();
  const prefixMatch = trimmed.match(/^(sk-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|AIza|AKIA|xox[baprs]-|Bearer\s+|eyJ)/i);
  if (prefixMatch) {
    return `${prefixMatch[1]}••••••••••••`;
  }
  const envMatch = trimmed.match(/^([A-Z0-9_]+)\s*[:=]/i);
  if (envMatch) {
    return `${envMatch[1]}=••••••••••••`;
  }
  return "••••••••••••";
}

export function countClipboardLines(raw: string): number {
  if (!raw) return 0;
  return raw.split(/\r?\n/).length;
}

const TRACKING_QUERY_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "si",
  "ref_src",
  "ref_url",
  "spm",
]);

export function parseHexColor(raw: string): { r: number; g: number; b: number; a?: number } | null {
  const trimmed = raw.trim();
  if (!HEX_COLOR_RE.test(trimmed)) return null;
  const hex = trimmed.slice(1);
  if (hex.length === 3 || hex.length === 4) {
    const r = parseInt(hex[0] + hex[0], 16);
    const g = parseInt(hex[1] + hex[1], 16);
    const b = parseInt(hex[2] + hex[2], 16);
    if (hex.length === 4) {
      const a = Math.round((parseInt(hex[3] + hex[3], 16) / 255) * 100) / 100;
      return { r, g, b, a };
    }
    return { r, g, b };
  }
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  if (hex.length === 8) {
    const a = Math.round((parseInt(hex.slice(6, 8), 16) / 255) * 100) / 100;
    return { r, g, b, a };
  }
  return { r, g, b };
}

export function hexToRgbString(raw: string): string | null {
  const c = parseHexColor(raw);
  if (!c) return null;
  return c.a !== undefined ? `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})` : `rgb(${c.r}, ${c.g}, ${c.b})`;
}

export function hexToHslString(raw: string): string | null {
  const c = parseHexColor(raw);
  if (!c) return null;
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }
    h /= 6;
  }
  const hd = Math.round(h * 360);
  const sp = Math.round(s * 100);
  const lp = Math.round(l * 100);
  return c.a !== undefined ? `hsla(${hd}, ${sp}%, ${lp}%, ${c.a})` : `hsl(${hd}, ${sp}%, ${lp}%)`;
}

export function tryFormatJson(
  raw: string,
): { formatted: string; minified: string; isMultiline: boolean } | null {
  const trimmed = raw.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null) return null;
    return {
      formatted: JSON.stringify(parsed, null, 2),
      minified: JSON.stringify(parsed),
      isMultiline: trimmed.includes("\n"),
    };
  } catch {
    return null;
  }
}

export function cleanTrackingUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!/^https?:\/\/\S+$/i.test(trimmed)) return null;
  try {
    const u = new URL(trimmed);
    let removed = false;
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_QUERY_PARAMS.has(key.toLowerCase())) {
        u.searchParams.delete(key);
        removed = true;
      }
    }
    return removed ? u.toString() : null;
  } catch {
    return null;
  }
}

export function parseUnixTimestamp(raw: string): { iso: string; local: string } | null {
  const trimmed = raw.trim();
  if (!/^\d{10}(?:\d{3})?$/.test(trimmed)) return null;
  const num = Number(trimmed);
  const ms = trimmed.length === 10 ? num * 1000 : num;
  if (ms < 946_684_800_000 || ms > 4_102_444_800_000) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return { iso: d.toISOString(), local: d.toLocaleString() };
}

export function decodeUrlText(raw: string): string | null {
  const trimmed = raw.trim();
  if (!/%[0-9A-Fa-f]{2}/.test(trimmed)) return null;
  try {
    const decoded = decodeURIComponent(trimmed);
    return decoded !== trimmed ? decoded : null;
  } catch {
    return null;
  }
}

export type SmartClipboardActionId =
  | "format-json"
  | "minify-json"
  | "copy-rgb"
  | "copy-hsl"
  | "clean-url"
  | "qr-code"
  | "decode-url"
  | "epoch-date"
  | "explain-code"
  | "summarize-ai"
  | "translate-ai"
  | "preview-image"
  | "save-image"
  | "ask-ai-image";

export interface SmartClipboardAction {
  id: SmartClipboardActionId;
  label: string;
  output?: string;
  hint?: string;
  aiPrompt?: string;
}

/**
 * Returns contextual 1-click smart actions for a clipboard entry based on its content.
 */
export function getSmartClipboardActions(entry: ClipboardEntry): SmartClipboardAction[] {
  if (entry.sensitive) return [];
  if (entry.kind === "image") {
    const acts: SmartClipboardAction[] = [];
    if (entry.imageThumb || entry.imagePath) {
      acts.push({ id: "preview-image", label: N_("Preview") });
    }
    if (entry.imagePath) {
      acts.push({ id: "save-image", label: N_("Save PNG") });
      acts.push({ id: "ask-ai-image", label: N_("Ask AI") });
    }
    return acts;
  }
  const trimmed = entry.text.trim();
  if (!trimmed) return [];

  const actions: SmartClipboardAction[] = [];

  if (entry.kind === "color") {
    const rgb = hexToRgbString(trimmed);
    const hsl = hexToHslString(trimmed);
    if (rgb) actions.push({ id: "copy-rgb", label: N_("Copy RGB"), output: rgb, hint: rgb });
    if (hsl) actions.push({ id: "copy-hsl", label: N_("Copy HSL"), output: hsl, hint: hsl });
    return actions;
  }

  const json = tryFormatJson(trimmed);
  if (json) {
    if (json.isMultiline) {
      if (json.minified !== trimmed) {
        actions.push({ id: "minify-json", label: N_("Minify JSON"), output: json.minified });
      }
      if (json.formatted !== trimmed) {
        actions.push({ id: "format-json", label: N_("Format JSON"), output: json.formatted });
      }
    } else {
      if (json.formatted !== trimmed) {
        actions.push({ id: "format-json", label: N_("Format JSON"), output: json.formatted });
      }
      if (json.minified !== trimmed) {
        actions.push({ id: "minify-json", label: N_("Minify JSON"), output: json.minified });
      }
    }
  }

  if (entry.kind === "link") {
    const cleaned = cleanTrackingUrl(trimmed);
    if (cleaned) {
      actions.push({ id: "clean-url", label: N_("Clean URL"), output: cleaned });
    }
    if (trimmed.length <= 2000) {
      actions.push({ id: "qr-code", label: N_("QR Code") });
    }
    const decoded = decodeUrlText(trimmed);
    if (decoded) {
      actions.push({ id: "decode-url", label: N_("Decode URL"), output: decoded });
    }
    actions.push({ id: "summarize-ai", label: N_("Summarize"), aiPrompt: "Summarize this link:\n\n" });
    return actions;
  }

  const epoch = parseUnixTimestamp(trimmed);
  if (epoch) {
    actions.push({ id: "epoch-date", label: N_("Copy Date"), output: epoch.iso, hint: epoch.local });
  }

  const decoded = decodeUrlText(trimmed);
  if (decoded) {
    actions.push({ id: "decode-url", label: N_("Decode URL"), output: decoded });
  }

  if (entry.kind === "code") {
    actions.push({ id: "explain-code", label: N_("Explain Code"), aiPrompt: "Explain this code:\n\n" });
    return actions;
  }

  if (trimmed.length <= 1000) {
    actions.push({ id: "qr-code", label: N_("QR Code") });
  }
  if (trimmed.length >= 80 || trimmed.includes("\n")) {
    actions.push({ id: "summarize-ai", label: N_("Summarize"), aiPrompt: "Summarize this:\n\n" });
  }
  if (trimmed.length >= 4) {
    actions.push({ id: "translate-ai", label: N_("Translate"), aiPrompt: "Translate this:\n\n" });
  }

  return actions;
}

function isLikelyCode(trimmed: string): boolean {
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    if (trimmed.includes('":') || trimmed.includes("':")) return true;
  }
  const sample = trimmed.length > 2048 ? trimmed.slice(0, 2048) : trimmed;
  if (CODE_TOKEN_RE.test(sample)) return true;
  if (sample.includes("\n")) {
    const lines = sample.split(/\r?\n/);
    const hasBraces = sample.includes("{") && sample.includes("}");
    let semicolonCount = 0;
    let indentedCount = 0;
    for (const l of lines) {
      if (l.trimEnd().endsWith(";")) semicolonCount++;
      if (/^(?:  |\t)\S/.test(l)) indentedCount++;
      if (semicolonCount >= 2 || indentedCount >= 2) return true;
    }
    if (hasBraces) return true;
  }
  return false;
}

export function detectClipboardKind(raw: string): ClipboardKind {
  const trimmed = raw.trim();
  if (!trimmed) return "text";
  if (HEX_COLOR_RE.test(trimmed)) return "color";
  if (!trimmed.includes("\n") && /^https?:\/\/\S+$/i.test(trimmed)) {
    try {
      const u = new URL(trimmed);
      if (u.protocol === "http:" || u.protocol === "https:") return "link";
    } catch {
      // Not a valid URL
    }
  }
  if (isLikelyCode(trimmed)) return "code";
  return "text";
}

export function loadClipboardEntries(): ClipboardEntry[] {
  const store = safeStorage();
  if (!store) return [];
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is ClipboardEntry =>
        item &&
        typeof item.id === "string" &&
        typeof item.text === "string" &&
        typeof item.pinned === "boolean" &&
        typeof item.copiedAt === "number",
    );
  } catch {
    return [];
  }
}

export function saveClipboardEntries(entries: readonly ClipboardEntry[]): void {
  const store = safeStorage();
  if (!store) return;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Ignore quota errors
  }
}

export function loadClipboardPaused(): boolean {
  const store = safeStorage();
  if (!store) return false;
  return store.getItem(PAUSED_KEY) === "1";
}

export function saveClipboardPaused(paused: boolean): void {
  const store = safeStorage();
  if (!store) return;
  try {
    store.setItem(PAUSED_KEY, paused ? "1" : "0");
  } catch {
    // Ignore
  }
}

function makeEntryId(now: number): string {
  const rand = Math.random().toString(36).slice(2, 7);
  return `clip_${now}_${rand}`;
}

/**
 * Adds a clipboard text entry with deduplication and bounded retention.
 * Pinned items are never evicted when enforcing MAX_CLIPBOARD_ITEMS.
 */
export function addClipboardEntry(
  entries: readonly ClipboardEntry[],
  rawText: string,
  now = Date.now(),
): ClipboardEntry[] {
  if (!rawText || !rawText.trim()) return [...entries];
  const text = rawText.length > MAX_CLIPBOARD_CHARS ? rawText.slice(0, MAX_CLIPBOARD_CHARS) : rawText;

  let existing: ClipboardEntry | undefined;
  const pinned: ClipboardEntry[] = [];
  const unpinned: ClipboardEntry[] = [];
  for (const e of entries) {
    if (e.text === text) {
      existing = e;
      continue;
    }
    if (e.pinned) pinned.push(e);
    else unpinned.push(e);
  }

  const entry: ClipboardEntry = existing
    ? { ...existing, copiedAt: now }
    : {
        id: makeEntryId(now),
        text,
        kind: detectClipboardKind(text),
        pinned: false,
        copiedAt: now,
        sensitive: isSensitiveClipboardText(text),
      };

  if (entry.pinned) pinned.unshift(entry);
  else unpinned.unshift(entry);

  const unpinnedLimit = Math.max(0, MAX_CLIPBOARD_ITEMS - pinned.length);
  const next = [...pinned, ...unpinned.slice(0, unpinnedLimit)].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.copiedAt - a.copiedAt;
  });
  saveClipboardEntries(next);
  return next;
}

/**
 * Adds a clipboard image entry with deduplication by imagePath/hash and bounded retention.
 */
export function addClipboardImageEntry(
  entries: readonly ClipboardEntry[],
  payload: ClipboardImagePayload,
  now = Date.now(),
): ClipboardEntry[] {
  if (!payload.path || !payload.thumbDataUrl) return [...entries];
  const label = `Image ${payload.width}×${payload.height}`;

  let existing: ClipboardEntry | undefined;
  const pinned: ClipboardEntry[] = [];
  const unpinned: ClipboardEntry[] = [];
  for (const e of entries) {
    if (e.kind === "image" && e.imagePath === payload.path) {
      existing = e;
      continue;
    }
    if (e.pinned) pinned.push(e);
    else unpinned.push(e);
  }

  const entry: ClipboardEntry = existing
    ? { ...existing, copiedAt: now, imageThumb: payload.thumbDataUrl }
    : {
        id: makeEntryId(now),
        text: label,
        kind: "image",
        pinned: false,
        copiedAt: now,
        imagePath: payload.path,
        imageWidth: payload.width,
        imageHeight: payload.height,
        imageThumb: payload.thumbDataUrl,
      };

  if (entry.pinned) pinned.unshift(entry);
  else unpinned.unshift(entry);

  const unpinnedLimit = Math.max(0, MAX_CLIPBOARD_ITEMS - pinned.length);
  const next = [...pinned, ...unpinned.slice(0, unpinnedLimit)].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.copiedAt - a.copiedAt;
  });
  saveClipboardEntries(next);
  return next;
}

export function togglePinClipboardEntry(entries: readonly ClipboardEntry[], id: string): ClipboardEntry[] {
  let changed = false;
  const next = entries.map((e) => {
    if (e.id !== id) return e;
    changed = true;
    return { ...e, pinned: !e.pinned };
  });
  if (!changed) return [...entries];
  next.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.copiedAt - a.copiedAt;
  });
  saveClipboardEntries(next);
  return next;
}

export function removeClipboardEntry(entries: readonly ClipboardEntry[], id: string): ClipboardEntry[] {
  const next = entries.filter((e) => e.id !== id);
  if (next.length !== entries.length) saveClipboardEntries(next);
  return next;
}

export function clearUnpinnedClipboard(entries: readonly ClipboardEntry[]): ClipboardEntry[] {
  const next = entries.filter((e) => e.pinned);
  if (next.length !== entries.length) saveClipboardEntries(next);
  return next;
}

export function filterClipboardEntries(
  entries: readonly ClipboardEntry[],
  query = "",
  filter: ClipboardFilter = "all",
): ClipboardEntry[] {
  const q = query.trim().toLowerCase();
  return [...entries]
    .filter((e) => {
      if (filter === "pinned" && !e.pinned) return false;
      if (filter === "links" && e.kind !== "link") return false;
      if (filter === "images" && e.kind !== "image") return false;
      if (q && !e.text.toLowerCase().includes(q)) return false;
      return true;
    })
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.copiedAt - a.copiedAt;
    });
}

export function formatClipboardAge(copiedAt: number, now = Date.now()): string {
  const sec = Math.max(0, Math.floor((now - copiedAt) / 1000));
  if (sec < 60) return "now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

function loadSuppressedTexts(): Set<string> {
  const store = safeStorage();
  if (!store) return new Set();
  const raw = store.getItem(SUPPRESSED_KEY);
  return raw ? new Set([raw]) : new Set();
}

function saveSuppressedText(text: string | null): void {
  const store = safeStorage();
  if (!store) return;
  try {
    if (text) store.setItem(SUPPRESSED_KEY, text);
    else store.removeItem(SUPPRESSED_KEY);
  } catch {
    // Ignore quota errors
  }
}

export class ClipboardStore {
  entries: ClipboardEntry[] = loadClipboardEntries();
  paused: boolean = loadClipboardPaused();
  private suppressedTexts: Set<string> = loadSuppressedTexts();
  private listeners = new Set<() => void>();

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  capture(rawText: string) {
    if (this.paused) return;
    if (!rawText || !rawText.trim()) return;
    const clamped = rawText.length > MAX_CLIPBOARD_CHARS ? rawText.slice(0, MAX_CLIPBOARD_CHARS) : rawText;
    if (this.suppressedTexts.has(clamped)) return;
    if (this.suppressedTexts.size > 0) {
      this.suppressedTexts.clear();
      saveSuppressedText(null);
    }
    const prevTop = this.entries[0];
    if (prevTop && prevTop.text === clamped && Date.now() - prevTop.copiedAt < 1000) {
      return;
    }
    this.entries = addClipboardEntry(this.entries, clamped);
    this.emit();
  }

  async refreshFromSystem(): Promise<void> {
    if (this.paused) return;
    if (IS_TAURI) {
      const text = await Bridge.clipboardReadText();
      if (text) {
        this.capture(text);
        return;
      }
      const img = await Bridge.clipboardReadImage();
      if (img) this.captureImage(img);
    }
  }

  captureImage(payload: ClipboardImagePayload) {
    if (this.paused) return;
    if (!payload.path || !payload.thumbDataUrl) return;
    if (this.suppressedTexts.has(payload.path)) return;
    if (this.suppressedTexts.size > 0) {
      this.suppressedTexts.clear();
      saveSuppressedText(null);
    }
    const prevTop = this.entries[0];
    if (prevTop && prevTop.kind === "image" && prevTop.imagePath === payload.path && Date.now() - prevTop.copiedAt < 1000) {
      return;
    }
    this.entries = addClipboardImageEntry(this.entries, payload);
    this.emit();
  }

  async copyImageToSystem(entry: ClipboardEntry): Promise<boolean> {
    if (entry.kind !== "image" || !entry.imagePath) return false;
    if (this.suppressedTexts.delete(entry.imagePath) && this.suppressedTexts.size === 0) {
      saveSuppressedText(null);
    }
    if (!IS_TAURI) return false;
    try {
      await Bridge.clipboardWriteImage(entry.imagePath);
      this.entries = addClipboardImageEntry(this.entries, {
        hash: "",
        path: entry.imagePath,
        width: entry.imageWidth ?? 0,
        height: entry.imageHeight ?? 0,
        thumbDataUrl: entry.imageThumb ?? "",
      });
      this.emit();
      return true;
    } catch {
      return false;
    }
  }

  async copyToSystem(text: string): Promise<boolean> {
    const clamped = text.length > MAX_CLIPBOARD_CHARS ? text.slice(0, MAX_CLIPBOARD_CHARS) : text;
    if (this.suppressedTexts.delete(clamped) && this.suppressedTexts.size === 0) {
      saveSuppressedText(null);
    }
    if (IS_TAURI) {
      await Bridge.clipboardWriteText(text);
      this.entries = addClipboardEntry(this.entries, text);
      this.emit();
      return true;
    }
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      }
      this.entries = addClipboardEntry(this.entries, text);
      this.emit();
      return true;
    } catch {
      return false;
    }
  }

  togglePin(id: string) {
    this.entries = togglePinClipboardEntry(this.entries, id);
    this.emit();
  }

  remove(id: string) {
    const target = this.entries.find((e) => e.id === id);
    if (target) {
      const key = target.kind === "image" && target.imagePath ? target.imagePath : target.text;
      this.suppressedTexts.add(key);
      saveSuppressedText(key);
      if (IS_TAURI && target.kind === "image" && target.imagePath) {
        void Bridge.clipboardDeleteImage(target.imagePath);
      }
    }
    this.entries = removeClipboardEntry(this.entries, id);
    this.emit();
  }

  clearUnpinned() {
    const unpinned = this.entries.filter((e) => !e.pinned);
    for (const item of unpinned) {
      const key = item.kind === "image" && item.imagePath ? item.imagePath : item.text;
      this.suppressedTexts.add(key);
      if (IS_TAURI && item.kind === "image" && item.imagePath) {
        void Bridge.clipboardDeleteImage(item.imagePath);
      }
    }
    if (unpinned.length > 0) {
      const first = unpinned[0];
      saveSuppressedText(first.kind === "image" && first.imagePath ? first.imagePath : first.text);
    }
    this.entries = clearUnpinnedClipboard(this.entries);
    this.emit();
  }

  setPaused(paused: boolean) {
    this.paused = paused;
    saveClipboardPaused(paused);
    if (IS_TAURI) void Bridge.clipboardSetPaused(paused);
    this.emit();
  }
}

export const Clipboard = new ClipboardStore();
