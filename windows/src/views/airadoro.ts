// Airadoro card and pill — DOM ports of AiradoroCardView and AiradoroPill (AiradoroViews.swift).
// Zero-CPU when closed; only updates while expanded on screen.

import { h, dot, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { Airadoro } from "../island/airadoro";
import {
  AIRADORO_STORAGE_WORK,
  AiradoroEngine,
  DEFAULT_WORK_MINUTES,
  getAiradoroConfig,
  loadStoredMinutes,
  saveStoredMinutes,
} from "../core/airadoro";
import { State, type AgentTask, type PillBadge } from "../core/state";
import { createMiniBot } from "../mochi/minibots";
import { t } from "../i18n/i18n";

const ACCENT_COLOR = "#0EA5E9";

function lighter(hex: string, amount: number): string {
  const v = parseInt(hex.replace("#", ""), 16);
  const c = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((x) =>
    Math.min(255, Math.round(x + amount * 255)),
  );
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// ── Pill (overview right column) ──────────────────────────────────────────────

export interface AiradoroPillHost {
  el: HTMLElement;
  sync(): void;
}

export function buildAiradoroPill(task: AgentTask, onTap: () => void): AiradoroPillHost {
  const color = task.color || ACCENT_COLOR;
  const mini = createMiniBot(task, 24, () => false);
  const label = h("span", { class: "lbl", text: "Airadoro" });
  label.style.fontVariantNumeric = "tabular-nums";

  const pill = h("div", { class: "pill airadoro-pill", onclick: onTap }, mini, label);
  pill.style.borderColor = `${color}24`;

  let badgeEl: HTMLElement | null = null;
  let shownBadge: PillBadge | null = null;

  const sync = () => {
    const text = Airadoro.pillLabel();
    if (label.textContent !== text) label.textContent = text;

    const currentTask = State.tasks.find((t) => t.id === task.id);
    const badge = currentTask?.pillBadge ?? null;
    if (badge !== shownBadge) {
      shownBadge = badge;
      if (badgeEl) {
        badgeEl.remove();
        badgeEl = null;
      }
      if (badge) {
        const colors = { approval: "#F5A524", finished: "#22C55E", error: "#F4505E" } as const;
        const icons = { approval: ICONS.bang, finished: ICONS.check, error: ICONS.xmark } as const;
        const inner = h("i", { style: `background:${colors[badge]}` },
          svg(icons[badge], 6, { stroke: badge === "finished" ? 3 : 0 }),
        );
        badgeEl = h("div", { class: "pill-badge" }, inner);
        badgeEl.style.boxShadow = `0 0 4px ${colors[badge]}99`;
        pill.append(badgeEl);
      }
    }
  };

  pill.addEventListener("mouseenter", () => {
    pill.style.background = `${color}2e`;
    pill.style.borderColor = `${color}8c`;
    pill.style.boxShadow = `0 2px 10px ${color}59`;
    label.style.color = lighter(color, 0.3);
    sync();
  });

  pill.addEventListener("mouseleave", () => {
    pill.style.background = "";
    pill.style.borderColor = `${color}24`;
    pill.style.boxShadow = "";
    label.style.color = "";
    sync();
  });

  sync();
  return { el: pill, sync };
}

// ── Card (overview left card) ─────────────────────────────────────────────────

export interface AiradoroCardHost {
  el: HTMLElement;
  sync(): void;
}

export function buildAiradoroCard(): AiradoroCardHost {
  const el = h("div", { class: "int-card airadoro-card" });
  el.style.padding = "10px 14px 0 108px";

  const subtitleSpan = h("span", { text: t("Ready") });
  const head = h("div", { class: "int-head" },
    dot(ACCENT_COLOR, 7),
    h("b", { text: "Airadoro" }),
    subtitleSpan,
  );

  const clockEl = h("span", { class: "airadoro-clock-text", text: "25:00" });
  clockEl.style.font = "600 20px var(--font)";
  clockEl.style.color = "var(--ink, #F5F6F8)";
  clockEl.style.fontVariantNumeric = "tabular-nums";
  clockEl.style.letterSpacing = "-0.5px";

  const controlsEl = h("div", { class: "airadoro-controls" });
  controlsEl.style.display = "flex";
  controlsEl.style.alignItems = "center";
  controlsEl.style.gap = "6px";

  const row = h("div", { class: "airadoro-row" }, clockEl, controlsEl);
  row.style.display = "flex";
  row.style.alignItems = "center";
  row.style.justifyContent = "space-between";
  row.style.marginTop = "8px";

  const bannerEl = h("div", { class: "airadoro-banner" });
  bannerEl.style.font = "500 11px var(--font)";
  bannerEl.style.color = ACCENT_COLOR;
  bannerEl.style.marginTop = "4px";
  bannerEl.style.display = "none";

  const progressFill = h("div", { class: "airadoro-progress-fill" });
  const progressTrack = h("div", { class: "airadoro-progress-track" }, progressFill);

  el.append(head, row, progressTrack, bannerEl);

  function createBtn(text: string, filled: boolean, onClick: () => void, accentBg?: string): HTMLElement {
    const btn = h("button", { class: "btn-subtle", text, onclick: onClick });
    btn.style.font = "600 11px var(--font)";
    btn.style.padding = "4px 10px";
    btn.style.borderRadius = "12px";
    btn.style.cursor = "pointer";
    btn.style.transition = "all 0.15s ease";

    if (filled) {
      btn.style.background = accentBg ?? ACCENT_COLOR;
      btn.style.color = "#041018";
      btn.style.border = "none";
    } else {
      btn.style.background = "rgba(255, 255, 255, 0.08)";
      btn.style.color = "#E8E9EC";
      btn.style.border = "1px solid rgba(255, 255, 255, 0.12)";
    }

    btn.addEventListener("mouseenter", () => {
      btn.style.opacity = "0.9";
      btn.style.transform = "scale(1.02)";
    });
    btn.addEventListener("mouseleave", () => {
      btn.style.opacity = "1";
      btn.style.transform = "scale(1)";
    });

    return btn;
  }

  let timer: number | null = null;

  function paintClock() {
    const snap = Airadoro.snapshot;
    const config = getAiradoroConfig();
    let seconds = 0;
    let total = config.work;
    if (snap.phase === "idle") {
      seconds = config.work;
    } else {
      seconds = Airadoro.remaining() ?? 0;
      total = snap.phase === "rest" ? config.rest : config.work;
    }
    clockEl.textContent = AiradoroEngine.clock(seconds);
    const pct = snap.phase === "idle"
      ? 0
      : Math.min(100, Math.max(0, Math.round(((total - seconds) / Math.max(1, total)) * 100)));
    progressTrack.style.display = snap.phase === "idle" ? "none" : "";
    progressFill.style.width = `${pct}%`;
    progressFill.style.background = snap.phase === "rest" ? "#22C55E" : ACCENT_COLOR;
  }

  function syncTimer() {
    const snap = Airadoro.snapshot;
    const running = snap.phase !== "idle" && !snap.paused && el.isConnected &&
      State.mode === "expanded" && State.view === "overview";

    if (running && timer == null) {
      timer = window.setInterval(() => {
        const stillActive = Airadoro.snapshot.phase !== "idle" && !Airadoro.snapshot.paused &&
          el.isConnected && State.mode === "expanded" && State.view === "overview";
        if (!stillActive) {
          if (timer != null) window.clearInterval(timer);
          timer = null;
          return;
        }
        paintClock();
      }, 500);
    } else if (!running && timer != null) {
      window.clearInterval(timer);
      timer = null;
    }
  }

  function sync() {
    const snap = Airadoro.snapshot;

    // 1. Subtitle
    if (snap.paused) {
      subtitleSpan.textContent = t("Paused");
    } else {
      switch (snap.phase) {
        case "work":
          subtitleSpan.textContent = t("Work");
          break;
        case "rest":
          subtitleSpan.textContent = t("Rest");
          break;
        case "idle":
          subtitleSpan.textContent = t("Ready");
          break;
      }
    }

    // 2. Clock
    paintClock();

    // 3. Controls
    clear(controlsEl);
    if (snap.phase === "idle") {
      const workMins = loadStoredMinutes(AIRADORO_STORAGE_WORK, DEFAULT_WORK_MINUTES);
      const durSeg = h("div", { class: "airadoro-dur-seg" });
      for (const mins of [15, 25, 45]) {
        durSeg.append(
          h("button", {
            type: "button",
            class: workMins === mins ? "airadoro-dur-btn on" : "airadoro-dur-btn",
            text: `${mins}m`,
            onclick: () => {
              saveStoredMinutes(AIRADORO_STORAGE_WORK, mins);
              sync();
            },
          }),
        );
      }
      controlsEl.append(durSeg, createBtn(t("Start"), true, () => Airadoro.begin()));
    } else if (snap.paused) {
      controlsEl.append(createBtn(t("Resume"), true, () => Airadoro.resume()));
      if (Airadoro.taskId) {
        controlsEl.append(createBtn(t("Done"), true, () => Airadoro.completeFocusedTask(), "#22C55E"));
      }
      controlsEl.append(createBtn(t("Stop"), false, () => Airadoro.stop()));
    } else {
      controlsEl.append(createBtn(t("Pause"), false, () => Airadoro.pause()));
      if (Airadoro.taskId) {
        controlsEl.append(createBtn(t("Done"), true, () => Airadoro.completeFocusedTask(), "#22C55E"));
      }
      controlsEl.append(createBtn(t("Stop"), false, () => Airadoro.stop()));
    }

    // 4. Banner (phase transition banner takes priority; otherwise active task title)
    const banner = snap.paused ? null : Airadoro.banner();
    const taskLabel = snap.phase !== "idle" && Airadoro.taskTitle ? `🎯 ${Airadoro.taskTitle}` : null;
    const text = banner ?? taskLabel;
    if (text) {
      bannerEl.textContent = text;
      bannerEl.style.display = "";
      bannerEl.style.whiteSpace = "nowrap";
      bannerEl.style.overflow = "hidden";
      bannerEl.style.textOverflow = "ellipsis";
    } else {
      bannerEl.style.display = "none";
    }

    // 5. Active live timer
    syncTimer();
  }

  sync();
  return { el, sync };
}
