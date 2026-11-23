// Agenda & daily task planner unit tests (core/agenda.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_TASK_TITLE_LENGTH,
  addAgendaTask,
  dueAgendaReminders,
  loadAgendaTasks,
  markReminderNotified,
  normalizeTaskTime,
  parseAgendaCommand,
  pendingCountForDate,
  removeAgendaTask,
  snoozeAgendaTask,
  taskSummaryByDay,
  tasksForDay,
  toggleAgendaTask,
  updateAgendaTask,
} from "../src/core/agenda.ts";

test("addAgendaTask validates date keys and trims/clamps titles", () => {
  let tasks = [];
  tasks = addAgendaTask(tasks, "2026-11-05", "   ");
  assert.equal(tasks.length, 0);

  tasks = addAgendaTask(tasks, "bad-date", "Kerjakan PR");
  assert.equal(tasks.length, 0);

  tasks = addAgendaTask(tasks, "2026-11-05", "  Kerjakan PR Fisika  ");
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, "Kerjakan PR Fisika");
  assert.equal(tasks[0].date, "2026-11-05");
  assert.equal(tasks[0].completed, false);

  const longTitle = "A".repeat(MAX_TASK_TITLE_LENGTH + 40);
  tasks = addAgendaTask(tasks, "2026-11-05", longTitle);
  assert.equal(tasks[1].title.length, MAX_TASK_TITLE_LENGTH);
});

test("toggleAgendaTask and removeAgendaTask update state cleanly", () => {
  let tasks = addAgendaTask([], "2026-11-05", "Kirim tugas");
  const id = tasks[0].id;

  tasks = toggleAgendaTask(tasks, id);
  assert.equal(tasks[0].completed, true);

  tasks = toggleAgendaTask(tasks, id);
  assert.equal(tasks[0].completed, false);

  tasks = removeAgendaTask(tasks, id);
  assert.equal(tasks.length, 0);
});

test("tasksForDay sorts incomplete tasks before completed ones", () => {
  let tasks = [];
  tasks = addAgendaTask(tasks, "2026-11-05", "First");
  tasks = addAgendaTask(tasks, "2026-11-05", "Second");
  tasks = addAgendaTask(tasks, "2026-11-06", "Other day");
  tasks = toggleAgendaTask(tasks, tasks[0].id);

  const day5 = tasksForDay(tasks, "2026-11-05");
  assert.equal(day5.length, 2);
  assert.equal(day5[0].title, "Second");
  assert.equal(day5[0].completed, false);
  assert.equal(day5[1].title, "First");
  assert.equal(day5[1].completed, true);
});

test("taskSummaryByDay aggregates total and pending counts per date", () => {
  let tasks = [];
  tasks = addAgendaTask(tasks, "2026-11-05", "Task 1");
  tasks = addAgendaTask(tasks, "2026-11-05", "Task 2");
  tasks = addAgendaTask(tasks, "2026-11-10", "Task 3");
  tasks = toggleAgendaTask(tasks, tasks[0].id);

  const summary = taskSummaryByDay(tasks);
  assert.deepEqual(summary.get("2026-11-05"), { total: 2, pending: 1 });
  assert.deepEqual(summary.get("2026-11-10"), { total: 1, pending: 1 });
  assert.equal(summary.get("2026-11-12"), undefined);

  assert.equal(pendingCountForDate(tasks, "2026-11-05"), 1);
  assert.equal(pendingCountForDate(tasks, "2026-11-10"), 1);
  assert.equal(pendingCountForDate(tasks, "bad-date"), 0);
});

test("loadAgendaTasks returns empty array safely when localStorage is absent", () => {
  assert.deepEqual(loadAgendaTasks(), []);
});

test("normalizeTaskTime validates 24h HH:MM strings", () => {
  assert.equal(normalizeTaskTime("09:05"), "09:05");
  assert.equal(normalizeTaskTime("23:59"), "23:59");
  assert.equal(normalizeTaskTime("24:00"), undefined);
  assert.equal(normalizeTaskTime("9:05"), undefined);
  assert.equal(normalizeTaskTime(""), undefined);
});

test("tasksForDay sorts timed tasks chronologically before untimed tasks", () => {
  let tasks = [];
  tasks = addAgendaTask(tasks, "2026-11-18", "Untimed");
  tasks = addAgendaTask(tasks, "2026-11-18", "Afternoon", "15:00");
  tasks = addAgendaTask(tasks, "2026-11-18", "Morning", "08:30");

  const day = tasksForDay(tasks, "2026-11-18");
  assert.deepEqual(
    day.map((t) => t.title),
    ["Morning", "Afternoon", "Untimed"],
  );
});

test("dueAgendaReminders triggers on schedule, avoids duplicates, and respects snooze", () => {
  let tasks = [];
  tasks = addAgendaTask(tasks, "2026-11-18", "Kirim tugas", "14:00");
  tasks = addAgendaTask(tasks, "2026-11-18", "Later task", "18:00");

  const at1359 = new Date(2026, 10, 18, 13, 59, 0);
  assert.equal(dueAgendaReminders(tasks, at1359).length, 0);

  const at1400 = new Date(2026, 10, 18, 14, 0, 0);
  const due1 = dueAgendaReminders(tasks, at1400);
  assert.equal(due1.length, 1);
  assert.equal(due1[0].title, "Kirim tugas");

  tasks = markReminderNotified(tasks, due1[0].id, "2026-11-18 14:00");
  assert.equal(dueAgendaReminders(tasks, at1400).length, 0);

  tasks = snoozeAgendaTask(tasks, due1[0].id, 10, at1400.getTime());
  const at1405 = new Date(2026, 10, 18, 14, 5, 0);
  assert.equal(dueAgendaReminders(tasks, at1405).length, 0);

  const at1410 = new Date(2026, 10, 18, 14, 10, 0);
  const dueAfterSnooze = dueAgendaReminders(tasks, at1410);
  assert.equal(dueAfterSnooze.length, 1);
  assert.equal(dueAfterSnooze[0].id, due1[0].id);
});

test("updateAgendaTask edits title, time, and repeat rule", () => {
  let tasks = addAgendaTask([], "2026-11-18", "Draft PR", "10:00", "none");
  const id = tasks[0].id;

  tasks = updateAgendaTask(tasks, id, { title: "Final PR", time: "11:30", repeat: "daily" });
  assert.equal(tasks[0].title, "Final PR");
  assert.equal(tasks[0].time, "11:30");
  assert.equal(tasks[0].repeat, "daily");

  tasks = updateAgendaTask(tasks, id, { time: "", repeat: "none" });
  assert.equal(tasks[0].time, undefined);
  assert.equal(tasks[0].repeat, undefined);
});

test("recurring tasks advance date on toggle instead of staying completed", () => {
  let tasks = addAgendaTask([], "2026-11-18", "Standup", "09:00", "daily");
  tasks = addAgendaTask(tasks, "2026-11-18", "Weekly review", undefined, "weekly");

  tasks = toggleAgendaTask(tasks, tasks[0].id);
  assert.equal(tasks[0].date, "2026-11-19");
  assert.equal(tasks[0].completed, false);

  tasks = toggleAgendaTask(tasks, tasks[1].id);
  assert.equal(tasks[1].date, "2026-11-25");
  assert.equal(tasks[1].completed, false);
});

test("parseAgendaCommand parses Indonesian and English schedule commands", () => {
  const now = new Date(2026, 10, 18, 15, 0, 0);

  assert.deepEqual(parseAgendaCommand("ingatkan saya besok jam 09:00 ada rapat", now), {
    date: "2026-11-19",
    time: "09:00",
    title: "rapat",
  });

  assert.deepEqual(parseAgendaCommand("tambah tugas tanggal 25 jam 14:30 kirim laporan", now), {
    date: "2026-11-25",
    time: "14:30",
    title: "kirim laporan",
  });

  assert.deepEqual(parseAgendaCommand("remind me tomorrow at 18:00 call mom", now), {
    date: "2026-11-19",
    time: "18:00",
    title: "call mom",
  });

  assert.equal(parseAgendaCommand("apa itu TypeScript?", now), null);
});
