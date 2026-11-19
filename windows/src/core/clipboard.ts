// Clipboard history state, smart content classification, deduplication, and local persistence.

import { Bridge, IS_TAURI } from "./bridge";

export type ClipboardKind = "text" | "link" | "color" | "code";
export type ClipboardFilter = "all" | "pinned" | "links";

export interface ClipboardEntry {
  id: string;
  text: string;
  kind: ClipboardKind;
  pinned: boolean;
  copiedAt: number;
  sensitive?: boolean;
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

function isLikelyCode(trimmed: string): boolean {
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    if (trimmed.includes('":') || trimmed.includes("':")) return true;
  }
  if (CODE_TOKEN_RE.test(trimmed)) return true;
  if (trimmed.includes("\n")) {
    const lines = trimmed.split(/\r?\n/);
    const hasBraces = trimmed.includes("{") && trimmed.includes("}");
    const hasSemicolonLines = lines.filter((l) => l.trimEnd().endsWith(";")).length >= 2;
    const hasIndentedLines = lines.filter((l) => /^(?:  |\t)\S/.test(l)).length >= 2;
    if (hasBraces || hasSemicolonLines || hasIndentedLines) return true;
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

  const existing = entries.find((e) => e.text === text);
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

  const rest = entries.filter((e) => e.text !== text);
  const combined = [entry, ...rest];

  const pinned = combined.filter((e) => e.pinned);
  const unpinnedLimit = Math.max(0, MAX_CLIPBOARD_ITEMS - pinned.length);
  const unpinned = combined.filter((e) => !e.pinned).slice(0, unpinnedLimit);

  const next = [...pinned, ...unpinned].sort((a, b) => {
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
      if (text) this.capture(text);
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
      this.suppressedTexts.add(target.text);
      saveSuppressedText(target.text);
    }
    this.entries = removeClipboardEntry(this.entries, id);
    this.emit();
  }

  clearUnpinned() {
    const unpinned = this.entries.filter((e) => !e.pinned);
    for (const item of unpinned) {
      this.suppressedTexts.add(item.text);
    }
    if (unpinned.length > 0) {
      saveSuppressedText(unpinned[0].text);
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
