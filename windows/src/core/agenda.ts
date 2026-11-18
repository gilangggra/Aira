// Local daily agenda & task planner — pure logic + localStorage persistence.
// Safe in non-DOM test environments (checks typeof localStorage).

export type AgendaRepeat = "none" | "daily" | "weekly";

export interface AgendaTask {
  id: string;
  /** Local date key in YYYY-MM-DD format (matches core/calendar.ts dayKey). */
  date: string;
  title: string;
  completed: boolean;
  createdAt: number;
  /** Optional 24h local time in HH:MM format (e.g. "14:30"). */
  time?: string;
  /** Optional recurrence rule. */
  repeat?: AgendaRepeat;
  /** Epoch ms until which a snoozed reminder waits before firing again. */
  snoozeUntil?: number;
  /** Slot key ("YYYY-MM-DD HH:MM") of the last fired reminder to avoid duplicate alerts. */
  notifiedAt?: string;
}

export interface DayTaskSummary {
  total: number;
  pending: number;
}

export interface ParsedAgendaCommand {
  date: string;
  time?: string;
  title: string;
}

export const AGENDA_STORAGE_KEY = "airaAgendaTasks";
export const MAX_TASK_TITLE_LENGTH = 120;
export const DEFAULT_SNOOZE_MINUTES = 10;

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_KEY_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function storage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function normalizeTaskTime(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return TIME_KEY_RE.test(trimmed) ? trimmed : undefined;
}

export function normalizeRepeat(raw: unknown): AgendaRepeat {
  return raw === "daily" || raw === "weekly" ? raw : "none";
}

function formatLocalDateKey(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** Shifts a YYYY-MM-DD date key by `days` calendar days. */
export function shiftDateKey(dateKey: string, days: number): string {
  if (!DATE_KEY_RE.test(dateKey)) return dateKey;
  const [y, m, d] = dateKey.split("-").map(Number);
  return formatLocalDateKey(new Date(y, m - 1, d + days));
}

function isValidTask(raw: unknown): raw is AgendaTask {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    r.id.length > 0 &&
    typeof r.date === "string" &&
    DATE_KEY_RE.test(r.date) &&
    typeof r.title === "string" &&
    r.title.trim().length > 0 &&
    typeof r.completed === "boolean" &&
    typeof r.createdAt === "number" &&
    Number.isFinite(r.createdAt)
  );
}

/** Loads persisted agenda tasks, discarding any malformed entries. */
export function loadAgendaTasks(): AgendaTask[] {
  const store = storage();
  if (!store) return [];
  try {
    const raw = store.getItem(AGENDA_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidTask).map((t) => {
      const repeat = normalizeRepeat(t.repeat);
      return {
        id: t.id,
        date: t.date,
        title: t.title.trim().slice(0, MAX_TASK_TITLE_LENGTH),
        completed: t.completed,
        createdAt: t.createdAt,
        time: normalizeTaskTime(t.time),
        ...(repeat !== "none" ? { repeat } : {}),
        snoozeUntil: typeof t.snoozeUntil === "number" && Number.isFinite(t.snoozeUntil) ? t.snoozeUntil : undefined,
        notifiedAt: typeof t.notifiedAt === "string" ? t.notifiedAt : undefined,
      };
    });
  } catch {
    return [];
  }
}

/** Saves agenda tasks to localStorage. */
export function saveAgendaTasks(tasks: readonly AgendaTask[]): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(AGENDA_STORAGE_KEY, JSON.stringify(tasks));
  } catch {
    // Storage quota exceeded or unavailable; ignore gracefully.
  }
}

/** Returns tasks for a specific YYYY-MM-DD date, incomplete first, then by time and creation order. */
export function tasksForDay(tasks: readonly AgendaTask[], dateKey: string): AgendaTask[] {
  if (!DATE_KEY_RE.test(dateKey)) return [];
  return tasks
    .filter((t) => t.date === dateKey)
    .sort((a, b) => {
      if (a.completed !== b.completed) return a.completed ? 1 : -1;
      if (a.time && b.time && a.time !== b.time) return a.time.localeCompare(b.time);
      if (a.time !== b.time) return a.time ? -1 : 1;
      return a.createdAt - b.createdAt;
    });
}

/** Summarizes total and pending task counts per YYYY-MM-DD date key. */
export function taskSummaryByDay(tasks: readonly AgendaTask[]): Map<string, DayTaskSummary> {
  const map = new Map<string, DayTaskSummary>();
  for (const t of tasks) {
    const prev = map.get(t.date) ?? { total: 0, pending: 0 };
    prev.total += 1;
    if (!t.completed) prev.pending += 1;
    map.set(t.date, prev);
  }
  return map;
}

/** Counts incomplete tasks for a specific YYYY-MM-DD date key. */
export function pendingCountForDate(tasks: readonly AgendaTask[], dateKey: string): number {
  if (!DATE_KEY_RE.test(dateKey)) return 0;
  let count = 0;
  for (const t of tasks) {
    if (t.date === dateKey && !t.completed) count += 1;
  }
  return count;
}

function makeTaskId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `task_${Date.now()}_${rand}`;
}

/** Adds a validated task for `dateKey` (with optional HH:MM `rawTime` and `repeat`), persists, and returns the updated list. */
export function addAgendaTask(
  tasks: readonly AgendaTask[],
  dateKey: string,
  rawTitle: string,
  rawTime?: string,
  rawRepeat: AgendaRepeat = "none",
): AgendaTask[] {
  if (!DATE_KEY_RE.test(dateKey)) return [...tasks];
  const title = rawTitle.trim().slice(0, MAX_TASK_TITLE_LENGTH);
  if (!title) return [...tasks];
  const time = normalizeTaskTime(rawTime);
  const repeat = normalizeRepeat(rawRepeat);
  const next: AgendaTask[] = [
    ...tasks,
    {
      id: makeTaskId(),
      date: dateKey,
      title,
      completed: false,
      createdAt: Date.now(),
      ...(time ? { time } : {}),
      ...(repeat !== "none" ? { repeat } : {}),
    },
  ];
  saveAgendaTasks(next);
  return next;
}

/** Updates title, time, or repeat rule of an existing task by ID. */
export function updateAgendaTask(
  tasks: readonly AgendaTask[],
  id: string,
  patch: { title?: string; time?: string; repeat?: AgendaRepeat },
): AgendaTask[] {
  let changed = false;
  const next = tasks.map((t) => {
    if (t.id !== id) return t;
    const updated = { ...t };
    if (patch.title !== undefined) {
      const clean = patch.title.trim().slice(0, MAX_TASK_TITLE_LENGTH);
      if (clean && clean !== t.title) {
        updated.title = clean;
        changed = true;
      }
    }
    if (patch.time !== undefined) {
      const nextTime = normalizeTaskTime(patch.time);
      if (nextTime !== t.time) {
        updated.time = nextTime;
        updated.snoozeUntil = undefined;
        updated.notifiedAt = undefined;
        changed = true;
      }
    }
    if (patch.repeat !== undefined) {
      const nextRepeat = normalizeRepeat(patch.repeat);
      const prevRepeat = normalizeRepeat(t.repeat);
      if (nextRepeat !== prevRepeat) {
        if (nextRepeat === "none") delete updated.repeat;
        else updated.repeat = nextRepeat;
        changed = true;
      }
    }
    return updated;
  });
  if (changed) saveAgendaTasks(next);
  return next;
}

/** Toggles completion status; recurring tasks advance to their next scheduled occurrence instead of staying done. */
export function toggleAgendaTask(tasks: readonly AgendaTask[], id: string): AgendaTask[] {
  let changed = false;
  const next = tasks.map((t) => {
    if (t.id !== id) return t;
    changed = true;
    if (!t.completed && (t.repeat === "daily" || t.repeat === "weekly")) {
      const step = t.repeat === "daily" ? 1 : 7;
      return {
        ...t,
        date: shiftDateKey(t.date, step),
        completed: false,
        snoozeUntil: undefined,
        notifiedAt: undefined,
      };
    }
    return {
      ...t,
      completed: !t.completed,
      snoozeUntil: undefined,
    };
  });
  if (changed) saveAgendaTasks(next);
  return next;
}

/** Removes a task by ID, persists, and returns the updated list. */
export function removeAgendaTask(tasks: readonly AgendaTask[], id: string): AgendaTask[] {
  const next = tasks.filter((t) => t.id !== id);
  if (next.length !== tasks.length) saveAgendaTasks(next);
  return next;
}

function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** Returns incomplete tasks whose scheduled time or snooze deadline is now due. */
export function dueAgendaReminders(tasks: readonly AgendaTask[], now = new Date()): AgendaTask[] {
  const todayKey = formatLocalDateKey(now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const nowMs = now.getTime();
  const due: AgendaTask[] = [];

  for (const t of tasks) {
    if (t.completed) continue;
    if (t.snoozeUntil != null) {
      if (nowMs >= t.snoozeUntil) due.push(t);
      continue;
    }
    if (!t.time || !TIME_KEY_RE.test(t.time)) continue;
    if (t.date !== todayKey) continue;
    const slotKey = `${t.date} ${t.time}`;
    if (t.notifiedAt === slotKey) continue;
    if (timeToMinutes(t.time) <= nowMinutes) {
      due.push(t);
    }
  }
  return due;
}

/** Marks a task reminder as notified for its current scheduled slot and clears any snooze. */
export function markReminderNotified(tasks: readonly AgendaTask[], id: string, slotKey: string): AgendaTask[] {
  let changed = false;
  const next = tasks.map((t) => {
    if (t.id !== id) return t;
    changed = true;
    return { ...t, notifiedAt: slotKey, snoozeUntil: undefined };
  });
  if (changed) saveAgendaTasks(next);
  return next;
}

/** Snoozes a task reminder by `minutes` from `nowMs`, persisting to storage. */
export function snoozeAgendaTask(
  tasks: readonly AgendaTask[],
  id: string,
  minutes = DEFAULT_SNOOZE_MINUTES,
  nowMs = Date.now(),
): AgendaTask[] {
  const clamped = Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_SNOOZE_MINUTES;
  let changed = false;
  const next = tasks.map((t) => {
    if (t.id !== id) return t;
    changed = true;
    return {
      ...t,
      snoozeUntil: nowMs + clamped * 60_000,
      notifiedAt: t.time ? `${t.date} ${t.time}` : t.notifiedAt,
    };
  });
  if (changed) saveAgendaTasks(next);
  return next;
}

const AGENDA_COMMAND_RE =
  /^(?:ingatkan(?:\s+(?:saya|aku))?|tambah(?:kan)?\s+tugas|catat\s+tugas|jadwalkan|remind\s+me(?:\s+to)?|add\s+task|schedule\s+task)\s+(.+)$/i;

/**
 * Parses natural-language calendar commands (ID & EN) into a structured task.
 * Returns null if the prompt is not a calendar command.
 */
export function parseAgendaCommand(input: string, now = new Date()): ParsedAgendaCommand | null {
  const match = AGENDA_COMMAND_RE.exec(input.trim());
  if (!match) return null;

  let rest = match[1].trim();
  let date = formatLocalDateKey(now);
  let time: string | undefined;

  // 1. Explicit ISO date YYYY-MM-DD
  const isoMatch = /\b(\d{4}-\d{2}-\d{2})\b/.exec(rest);
  if (isoMatch) {
    date = isoMatch[1];
    rest = rest.replace(isoMatch[0], " ");
  } else if (/\b(?:besok|tomorrow)\b/i.test(rest)) {
    date = shiftDateKey(date, 1);
    rest = rest.replace(/\b(?:besok|tomorrow)\b/i, " ");
  } else if (/\blusa\b/i.test(rest)) {
    date = shiftDateKey(date, 2);
    rest = rest.replace(/\blusa\b/i, " ");
  } else if (/\b(?:hari\s+ini|today)\b/i.test(rest)) {
    rest = rest.replace(/\b(?:hari\s+ini|today)\b/i, " ");
  } else {
    const dayMatch = /\b(?:tanggal|tgl|on)\s+(\d{1,2})\b/i.exec(rest);
    if (dayMatch) {
      const targetDay = Number(dayMatch[1]);
      if (targetDay >= 1 && targetDay <= 31) {
        const candidate = new Date(now.getFullYear(), now.getMonth(), targetDay);
        if (candidate.getDate() === targetDay) {
          if (targetDay < now.getDate()) {
            const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, targetDay);
            date = formatLocalDateKey(nextMonth);
          } else {
            date = formatLocalDateKey(candidate);
          }
        }
      }
      rest = rest.replace(dayMatch[0], " ");
    }
  }

  // 2. Time extraction: jam 14:30 / pukul 9 / at 09:00 / @ 18.00
  const timeMatch = /(?:^|\s)(?:jam|pukul|at|@)\s*(\d{1,2})(?:[:.](\d{2}))?\b/i.exec(rest);
  if (timeMatch) {
    const hh = Number(timeMatch[1]);
    const mm = timeMatch[2] ? Number(timeMatch[2]) : 0;
    if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
      time = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
      rest = rest.replace(timeMatch[0], " ");
    }
  }

  // 3. Clean filler words & punctuation
  const title = rest
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:untuk|ada|to|that|bahwa|:|-)+\s*/i, "")
    .trim()
    .slice(0, MAX_TASK_TITLE_LENGTH);

  if (!title) return null;
  return { date, ...(time ? { time } : {}), title };
}
