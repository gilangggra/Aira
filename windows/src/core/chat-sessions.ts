// Persistent multi-session chat history store (Apple/macOS-style threads).
// Pure data operations + localStorage persistence with graceful fallback.

import type { ChatMessage } from "./state";

export const CHAT_SESSIONS_KEY = "airaChatSessions";
export const CHAT_ACTIVE_SESSION_KEY = "airaActiveChatSessionId";
export const MAX_CHAT_SESSIONS = 50;
const TITLE_MAX_LEN = 42;

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

export type SessionGroupKey = "Today" | "Yesterday" | "Last 7 Days" | "Older";

export interface ChatSessionGroup {
  key: SessionGroupKey;
  items: ChatSession[];
}

function getStorage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function deriveSessionTitle(messages: readonly ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user" && m.content.trim().length > 0);
  const raw = (firstUser ?? messages[0])?.content ?? "";
  const clean = raw.replace(/\s+/g, " ").trim();
  if (!clean) return "New Chat";
  if (clean.length <= TITLE_MAX_LEN) return clean;
  return `${clean.slice(0, TITLE_MAX_LEN - 1).trimEnd()}…`;
}

function isValidAttachment(a: unknown): boolean {
  if (a === undefined) return true;
  if (!a || typeof a !== "object") return false;
  const rec = a as Record<string, unknown>;
  return typeof rec.name === "string" && (rec.path === undefined || typeof rec.path === "string");
}

function isValidMessage(m: unknown): m is ChatMessage {
  if (!m || typeof m !== "object") return false;
  const rec = m as Record<string, unknown>;
  return (
    typeof rec.id === "number" &&
    (rec.role === "user" || rec.role === "assistant") &&
    typeof rec.content === "string" &&
    isValidAttachment(rec.attachment)
  );
}

function isValidSession(s: unknown): s is ChatSession {
  if (!s || typeof s !== "object") return false;
  const rec = s as Record<string, unknown>;
  return (
    typeof rec.id === "string" &&
    rec.id.length > 0 &&
    typeof rec.title === "string" &&
    typeof rec.createdAt === "number" &&
    typeof rec.updatedAt === "number" &&
    Array.isArray(rec.messages) &&
    rec.messages.every(isValidMessage)
  );
}

export function loadChatSessions(): ChatSession[] {
  const store = getStorage();
  if (!store) return [];
  try {
    const raw = store.getItem(CHAT_SESSIONS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isValidSession)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_CHAT_SESSIONS);
  } catch {
    return [];
  }
}

export function saveChatSessions(sessions: readonly ChatSession[]): void {
  const store = getStorage();
  if (!store) return;
  try {
    store.setItem(CHAT_SESSIONS_KEY, JSON.stringify(sessions.slice(0, MAX_CHAT_SESSIONS)));
  } catch {
    // Storage quota exceeded or unavailable; fail silently without breaking chat.
  }
}

export function loadActiveChatSessionId(): string | null {
  const store = getStorage();
  if (!store) return null;
  try {
    const id = store.getItem(CHAT_ACTIVE_SESSION_KEY);
    return id && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

export function saveActiveChatSessionId(id: string | null): void {
  const store = getStorage();
  if (!store) return;
  try {
    if (id) store.setItem(CHAT_ACTIVE_SESSION_KEY, id);
    else store.removeItem(CHAT_ACTIVE_SESSION_KEY);
  } catch {
    // Ignore storage errors.
  }
}

export function createSessionId(now = Date.now()): string {
  return `chat-${now}-${Math.random().toString(36).slice(2, 7)}`;
}

export function upsertChatSession(
  sessions: readonly ChatSession[],
  activeId: string | null,
  messages: readonly ChatMessage[],
  now = Date.now(),
): { sessions: ChatSession[]; activeId: string | null } {
  if (messages.length === 0) {
    return { sessions: [...sessions], activeId };
  }

  const clonedMessages = messages.map((m) =>
    m.attachment ? { ...m, attachment: { ...m.attachment } } : { ...m },
  );
  const existing = activeId ? sessions.find((s) => s.id === activeId) : undefined;

  let nextSessions: ChatSession[];
  let resolvedId: string;

  if (existing) {
    resolvedId = existing.id;
    const title = existing.title && existing.title !== "New Chat"
      ? existing.title
      : deriveSessionTitle(clonedMessages);
    const updated: ChatSession = {
      ...existing,
      title,
      updatedAt: now,
      messages: clonedMessages,
    };
    nextSessions = [updated, ...sessions.filter((s) => s.id !== resolvedId)];
  } else {
    resolvedId = activeId ?? createSessionId(now);
    const created: ChatSession = {
      id: resolvedId,
      title: deriveSessionTitle(clonedMessages),
      createdAt: now,
      updatedAt: now,
      messages: clonedMessages,
    };
    nextSessions = [created, ...sessions];
  }

  return {
    sessions: nextSessions.slice(0, MAX_CHAT_SESSIONS),
    activeId: resolvedId,
  };
}

export function deleteChatSession(sessions: readonly ChatSession[], id: string): ChatSession[] {
  return sessions.filter((s) => s.id !== id);
}

function startOfDayMs(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function groupChatSessions(
  sessions: readonly ChatSession[],
  now = Date.now(),
): ChatSessionGroup[] {
  const todayStart = startOfDayMs(now);
  const yesterdayStart = todayStart - 86_400_000;
  const weekStart = todayStart - 6 * 86_400_000;

  const buckets: Record<SessionGroupKey, ChatSession[]> = {
    Today: [],
    Yesterday: [],
    "Last 7 Days": [],
    Older: [],
  };

  for (const s of sessions) {
    if (s.updatedAt >= todayStart) buckets.Today.push(s);
    else if (s.updatedAt >= yesterdayStart) buckets.Yesterday.push(s);
    else if (s.updatedAt >= weekStart) buckets["Last 7 Days"].push(s);
    else buckets.Older.push(s);
  }

  const order: SessionGroupKey[] = ["Today", "Yesterday", "Last 7 Days", "Older"];
  return order
    .filter((key) => buckets[key].length > 0)
    .map((key) => ({ key, items: buckets[key] }));
}

export function formatSessionTime(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const todayStart = startOfDayMs(now);
  if (ts >= todayStart) {
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }
  const day = String(d.getDate()).padStart(2, "0");
  const mon = String(d.getMonth() + 1).padStart(2, "0");
  return `${day}/${mon}`;
}
