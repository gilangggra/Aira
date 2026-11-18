// Agenda & daily task planner view for the expanded notch.
// Left: mini month calendar with task indicators per date.
// Right: task checklist for the selected date + quick inline add.

import {
  MAX_TASK_TITLE_LENGTH,
  addAgendaTask,
  loadAgendaTasks,
  pendingCountForDate,
  removeAgendaTask,
  snoozeAgendaTask,
  taskSummaryByDay,
  tasksForDay,
  toggleAgendaTask,
  updateAgendaTask,
  type AgendaRepeat,
  type AgendaTask,
} from "../core/agenda";
import { dayKey, monthDays } from "../core/calendar";
import { State } from "../core/state";
import { language, t, tl } from "../i18n/i18n";
import { clear, h, svg } from "./dom";
import { ICONS } from "./icons";
import type { ViewActions, ViewHost } from "./views";

export function buildAgendaView(actions: ViewActions): ViewHost {
  let tasks: AgendaTask[] = loadAgendaTasks();
  let today = new Date();
  let month = new Date(today.getFullYear(), today.getMonth(), 1);
  let selectedDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  let editingId: string | null = null;

  const calColumn = h("div", { class: "agenda-cal" });
  const tasksColumn = h("div", { class: "agenda-tasks" });
  const dayTitle = h("div", { class: "agenda-day-title" });
  const dayBadge = h("span", { class: "agenda-day-badge" });
  const listEl = h("div", { class: "agenda-list" });

  const input = h("input", {
    type: "text",
    class: "agenda-input",
    placeholder: tl("Add a task…"),
    maxlength: String(MAX_TASK_TITLE_LENGTH),
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;

  const timeInput = h("input", {
    type: "time",
    class: "agenda-time-input",
    title: tl("Reminder"),
  }) as HTMLInputElement;

  const repeatSelect = h(
    "select",
    { class: "agenda-repeat-select" },
    h("option", { value: "none", text: tl("Once") }),
    h("option", { value: "daily", text: tl("Daily") }),
    h("option", { value: "weekly", text: tl("Weekly") }),
  ) as HTMLSelectElement;

  const addBtn = h("button", {
    type: "submit",
    class: "agenda-add-btn",
    text: tl("Add"),
  }) as HTMLButtonElement;

  const form = h(
    "form",
    { class: "agenda-form" },
    h("div", { class: "agenda-form-main" }, input, addBtn),
    h("div", { class: "agenda-form-opts" }, timeInput, repeatSelect),
  );
  form.addEventListener("submit", (e: Event) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    actions.blip();
    tasks = addAgendaTask(
      tasks,
      dayKey(selectedDate),
      text,
      timeInput.value,
      repeatSelect.value as AgendaRepeat,
    );
    input.value = "";
    timeInput.value = "";
    repeatSelect.value = "none";
    actions.holdOpen(false);
    renderCalendar();
    renderTasks();
    State.notify();
    input.focus();
  });

  input.addEventListener("input", () => {
    actions.holdOpen(input.value.trim().length > 0);
  });
  input.addEventListener("focus", () => actions.keyboard(true));
  input.addEventListener("blur", () => {
    actions.holdOpen(false);
    actions.keyboard(false);
  });

  tasksColumn.append(
    h("div", { class: "agenda-tasks-head" }, dayTitle, dayBadge),
    listEl,
    form,
  );

  const shell = h("div", { class: "agenda-shell" }, calColumn, tasksColumn);
  const el = h("div", { class: "view agenda-view" }, shell);

  function renderCalendar() {
    clear(calColumn);
    const todayKey = dayKey(today);
    const selectedKey = dayKey(selectedDate);
    const summary = taskSummaryByDay(tasks);

    const prevBtn = h(
      "button",
      {
        type: "button",
        class: "agenda-nav-btn",
        title: t("Previous"),
        onclick: () => {
          actions.blip();
          month = new Date(month.getFullYear(), month.getMonth() - 1, 1);
          renderCalendar();
        },
      },
      svg(ICONS.chevronLeft, 12, { stroke: 2 }),
    );

    const monthLabel = h("button", {
      type: "button",
      class: "agenda-month-btn",
      title: t("Today"),
      text: month.toLocaleDateString(language(), { month: "short", year: "numeric" }),
      onclick: () => {
        actions.blip();
        today = new Date();
        month = new Date(today.getFullYear(), today.getMonth(), 1);
        selectedDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        renderCalendar();
        renderTasks();
      },
    });

    const nextBtn = h(
      "button",
      {
        type: "button",
        class: "agenda-nav-btn",
        title: t("Next"),
        onclick: () => {
          actions.blip();
          month = new Date(month.getFullYear(), month.getMonth() + 1, 1);
          renderCalendar();
        },
      },
      svg(ICONS.chevronRight, 12, { stroke: 2 }),
    );

    const nav = h("div", { class: "agenda-cal-nav" }, prevBtn, monthLabel, nextBtn);

    const weekdays = h("div", { class: "cal-weekdays agenda-weekdays" });
    for (let d = 0; d < 7; d++) {
      // 2024-01-01 is a Monday, matching monthDays() Monday-first grid.
      const label = new Date(2024, 0, 1 + d).toLocaleDateString(language(), { weekday: "narrow" });
      weekdays.append(h("span", { text: label }));
    }

    const grid = h("div", { class: "cal-grid agenda-grid" });
    for (const date of monthDays(month)) {
      const key = dayKey(date);
      const inMonth = date.getMonth() === month.getMonth();
      const info = summary.get(key);
      const isToday = key === todayKey;
      const isSelected = key === selectedKey;

      const classes = ["agenda-day"];
      if (!inMonth) classes.push("outside");
      if (isToday) classes.push("today");
      if (isSelected) classes.push("selected");
      if (info && info.pending > 0) classes.push("has-pending");
      else if (info && info.total > 0) classes.push("has-done");

      const btn = h(
        "button",
        {
          type: "button",
          class: classes.join(" "),
          "data-day": key,
          onclick: () => {
            actions.blip();
            selectedDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
            if (!inMonth) month = new Date(date.getFullYear(), date.getMonth(), 1);
            renderCalendar();
            renderTasks();
          },
        },
        h("span", { text: String(date.getDate()) }),
      );
      grid.append(btn);
    }

    calColumn.append(nav, weekdays, grid);
  }

  function renderTasks() {
    const key = dayKey(selectedDate);
    const dayTasks = tasksForDay(tasks, key);
    const pendingCount = dayTasks.filter((item) => !item.completed).length;

    dayTitle.textContent = selectedDate.toLocaleDateString(language(), {
      weekday: "short",
      day: "numeric",
      month: "short",
    });
    dayBadge.textContent = pendingCount > 0 ? String(pendingCount) : "";
    dayBadge.style.display = pendingCount > 0 ? "" : "none";

    clear(listEl);
    if (dayTasks.length === 0) {
      listEl.append(h("div", { class: "agenda-empty", text: t("No tasks") }));
      return;
    }

    for (const task of dayTasks) {
      if (editingId === task.id) {
        const editTitle = h("input", {
          type: "text",
          class: "agenda-edit-input",
          value: task.title,
          maxlength: String(MAX_TASK_TITLE_LENGTH),
          autocomplete: "off",
          spellcheck: "false",
        }) as HTMLInputElement;
        const editTime = h("input", {
          type: "time",
          class: "agenda-time-input",
          value: task.time ?? "",
        }) as HTMLInputElement;
        const editRepeat = h(
          "select",
          { class: "agenda-repeat-select" },
          h("option", { value: "none", text: tl("Once") }),
          h("option", { value: "daily", text: tl("Daily") }),
          h("option", { value: "weekly", text: tl("Weekly") }),
        ) as HTMLSelectElement;
        editRepeat.value = task.repeat ?? "none";

        const commitEdit = () => {
          const nextTitle = editTitle.value.trim();
          if (nextTitle) {
            actions.blip();
            tasks = updateAgendaTask(tasks, task.id, {
              title: nextTitle,
              time: editTime.value,
              repeat: editRepeat.value as AgendaRepeat,
            });
          }
          editingId = null;
          actions.holdOpen(false);
          renderCalendar();
          renderTasks();
          State.notify();
        };

        const cancelEdit = () => {
          editingId = null;
          actions.holdOpen(false);
          renderTasks();
        };

        const editForm = h(
          "form",
          { class: "agenda-item agenda-item-edit" },
          h(
            "div",
            { class: "agenda-edit-main" },
            editTitle,
            h("button", { type: "submit", class: "agenda-save-btn", title: t("Save") }, svg(ICONS.check, 10, { stroke: 2.4 })),
            h("button", { type: "button", class: "agenda-del", style: "opacity:1", onclick: cancelEdit }, svg(ICONS.xmark, 10)),
          ),
          h("div", { class: "agenda-edit-opts" }, editTime, editRepeat),
        );
        editForm.addEventListener("submit", (e: Event) => {
          e.preventDefault();
          commitEdit();
        });
        editTitle.addEventListener("keydown", (e: KeyboardEvent) => {
          if (e.key === "Escape") {
            e.preventDefault();
            cancelEdit();
          }
        });
        editTitle.addEventListener("focus", () => {
          actions.keyboard(true);
          actions.holdOpen(true);
        });
        editTitle.addEventListener("blur", () => actions.keyboard(false));
        listEl.append(editForm);
        window.setTimeout(() => {
          editTitle.focus();
          editTitle.select();
        }, 0);
        continue;
      }

      const checkBtn = h(
        "button",
        {
          type: "button",
          class: task.completed ? "agenda-check on" : "agenda-check",
          "aria-pressed": String(task.completed),
          onclick: () => {
            actions.blip();
            const wasCompleted = task.completed;
            tasks = toggleAgendaTask(tasks, task.id);
            if (!wasCompleted) {
              const remaining = pendingCountForDate(tasks, dayKey(selectedDate));
              actions.emote?.(remaining === 0 ? "proud" : "happy");
            }
            renderCalendar();
            renderTasks();
            State.notify();
          },
        },
        task.completed ? svg(ICONS.check, 9, { stroke: 2.5 }) : "",
      );

      const titleEl = h("span", {
        class: task.completed ? "agenda-task-title done editable" : "agenda-task-title editable",
        text: task.title,
        title: t("Edit"),
        onclick: () => {
          actions.blip();
          editingId = task.id;
          renderTasks();
        },
      });

      const repeatEl =
        task.repeat === "daily" || task.repeat === "weekly"
          ? h("span", {
              class: "agenda-task-repeat",
              title: task.repeat === "daily" ? t("Daily") : t("Weekly"),
              text: "↻",
            })
          : null;

      const timeEl = task.time
        ? h("span", { class: "agenda-task-time", text: task.time })
        : null;

      const focusBtn = task.completed
        ? null
        : h(
            "button",
            {
              type: "button",
              class: "agenda-focus",
              title: t("Start"),
              onclick: () => {
                actions.blip();
                actions.focusTask?.(task.title);
              },
            },
            svg(ICONS.timer, 11),
          );

      const delBtn = h(
        "button",
        {
          type: "button",
          class: "agenda-del",
          title: t("Delete"),
          onclick: () => {
            actions.blip();
            tasks = removeAgendaTask(tasks, task.id);
            renderCalendar();
            renderTasks();
            State.notify();
          },
        },
        svg(ICONS.xmark, 10),
      );

      listEl.append(h("div", { class: "agenda-item" }, checkBtn, titleEl, repeatEl, timeEl, focusBtn, delBtn));
    }
  }

  return {
    el,
    sync() {
      today = new Date();
      tasks = loadAgendaTasks();
      renderCalendar();
      renderTasks();
    },
    focus() {
      input.focus();
    },
  };
}

/** Pop-up reminder card shown when a scheduled agenda task time arrives. */
export function buildReminderView(actions: ViewActions): ViewHost {
  const badgeTime = h("span", { class: "reminder-time" });
  const titleEl = h("div", { class: "title reminder-title" });

  const doneBtn = h("button", {
    type: "button",
    class: "btn primary",
    text: tl("Done"),
    onclick: () => {
      const rem = State.activeReminder;
      if (!rem) return;
      actions.blip();
      const tasks = loadAgendaTasks();
      const current = tasks.find((item) => item.id === rem.id);
      if (current && !current.completed) {
        toggleAgendaTask(tasks, rem.id);
      }
      State.activeReminder = null;
      actions.emote?.("proud");
      actions.collapse();
      State.notify();
    },
  });

  const snoozeBtn = h("button", {
    type: "button",
    class: "btn secondary",
    text: tl("Snooze 10m"),
    onclick: () => {
      const rem = State.activeReminder;
      if (!rem) return;
      actions.blip();
      snoozeAgendaTask(loadAgendaTasks(), rem.id);
      State.activeReminder = null;
      actions.collapse();
      State.notify();
    },
  });

  const openAgendaBtn = h("button", {
    type: "button",
    class: "link-btn",
    text: tl("Calendar"),
    onclick: () => {
      actions.blip();
      State.activeReminder = null;
      actions.setView("agenda");
    },
  });

  const body = h(
    "div",
    { class: "stack reminder-stack" },
    h(
      "div",
      { class: "who-row reminder-head" },
      svg(ICONS.calendar, 12, { stroke: 2 }),
      h("span", { text: tl("Reminder") }),
      badgeTime,
    ),
    titleEl,
    h("div", { class: "actions-row reminder-actions" }, doneBtn, snoozeBtn, openAgendaBtn),
  );

  const el = h("div", { class: "view" }, h("div", { class: "card" }, body));

  return {
    el,
    sync() {
      const rem = State.activeReminder;
      titleEl.textContent = rem?.title ?? "";
      badgeTime.textContent = rem?.time ? `· ${rem.time}` : "";
    },
  };
}
