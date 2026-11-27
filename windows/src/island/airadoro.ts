// AiradoroController: port of AiradoroController.swift.
// Manages the countdown deadline timer, sound alerts, island surfacing and pill labeling.

import {
  AiradoroEngine,
  AIRADORO_ID,
  getAiradoroConfig,
  type AiradoroEvent,
  type AiradoroSnapshot,
} from "../core/airadoro";
import { loadAgendaTasks, toggleAgendaTask } from "../core/agenda";
import { Sound } from "../core/sound";
import { State, type AgentTask } from "../core/state";
import { Bridge } from "../core/bridge";
import { toggleDeclared } from "../core/pills";
import { t } from "../i18n/i18n";
import type { Island } from "./island";

class AiradoroManager {
  private snap: AiradoroSnapshot = AiradoroEngine.stop();
  private timer: number | null = null;
  private noticeUntil: number | null = null;
  private island: Island | null = null;
  private registered = false;
  private activeTask: string | null = null;
  private activeTaskId: string | null = null;

  get snapshot(): AiradoroSnapshot {
    return this.snap;
  }

  get taskTitle(): string | null {
    return this.activeTask;
  }

  get taskId(): string | null {
    return this.activeTaskId;
  }

  register(island: Island) {
    this.island = island;
    if (this.registered) return;
    this.registered = true;

    State.subscribe(() => {
      const active = this.isPillActive();
      if (!active && this.snap.phase !== "idle") {
        this.stop();
      }
    });
  }

  isPillActive(): boolean {
    return State.settings.activeIntegrations.includes(AIRADORO_ID);
  }

  begin() {
    if (!this.isPillActive()) return;
    const config = getAiradoroConfig();
    const { snap, events } = AiradoroEngine.start(config);
    this.snap = snap;
    this.ensureTimer();
    this.paint();
    if (events.length > 0) {
      this.surface(events[events.length - 1]);
    }
    State.notify();
  }

  /** Enables Airadoro if needed and starts a focus session for a specific task. */
  startForTask(title: string, taskId?: string): boolean {
    if (!this.isPillActive()) {
      const next = toggleDeclared(State.settings, AIRADORO_ID, State.os);
      if (!next) return false;
      State.settings.activeIntegrations = next;
      State.loadIntegrationTasks();
      void Bridge.saveSettings(State.settings);
    }
    this.activeTask = title.trim() || null;
    this.activeTaskId = taskId ?? null;
    this.begin();
    return true;
  }

  /** Marks the currently focused agenda task as done and stops the focus session. */
  completeFocusedTask(): boolean {
    const id = this.activeTaskId;
    if (!id) return false;
    const tasks = loadAgendaTasks();
    const match = tasks.find((item) => item.id === id);
    if (match && !match.completed) {
      toggleAgendaTask(tasks, id);
    }
    Sound.play("finish");
    this.island?.emote("happy");
    this.stop();
    return true;
  }

  pause() {
    if (!this.isPillActive() || this.snap.phase === "idle" || this.snap.paused) return;
    this.snap = AiradoroEngine.pause(this.snap);
    this.stopTimer();
    this.paint();
    State.notify();
  }

  resume() {
    if (!this.isPillActive() || !this.snap.paused) return;
    this.snap = AiradoroEngine.resume(this.snap);
    this.ensureTimer();
    this.paint();
    this.tick();
    State.notify();
  }

  stop() {
    this.snap = AiradoroEngine.stop();
    this.noticeUntil = null;
    this.activeTask = null;
    this.activeTaskId = null;
    this.stopTimer();
    this.paintIdle();
    State.notify();
  }

  remaining(nowMs = Date.now()): number | null {
    return AiradoroEngine.remaining(this.snap, nowMs);
  }

  banner(nowMs = Date.now()): string | null {
    if (!this.snap.notice || this.noticeUntil == null || nowMs >= this.noticeUntil) {
      return null;
    }
    switch (this.snap.notice) {
      case "restStarts":
        return t("Airadoro · Rest");
      case "workStarts":
        return t("Airadoro · Work");
    }
  }

  pillLabel(nowMs = Date.now()): string {
    const b = this.banner(nowMs);
    if (b) return b;
    if (this.snap.phase !== "idle") {
      const rem = this.remaining(nowMs);
      if (rem != null) return AiradoroEngine.clock(rem);
    }
    return "Airadoro";
  }

  private ensureTimer() {
    this.stopTimer();
    if (this.snap.phase === "idle" || this.snap.paused || this.snap.deadline == null) return;
    const delay = Math.max(50, this.snap.deadline - Date.now() + 50);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.tick();
    }, delay);
  }

  private stopTimer() {
    if (this.timer != null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private tick() {
    if (!this.isPillActive()) {
      this.stop();
      return;
    }
    const config = getAiradoroConfig();
    const { snap, events } = AiradoroEngine.tick(this.snap, config);
    const changed =
      snap.phase !== this.snap.phase ||
      snap.deadline !== this.snap.deadline ||
      snap.paused !== this.snap.paused;
    this.snap = snap;
    this.paint();
    if (events.length > 0) {
      this.surface(events[events.length - 1]);
    }
    this.ensureTimer();
    if (changed) State.notify();
  }

  private surface(event: AiradoroEvent) {
    this.noticeUntil = Date.now() + 8000;
    const soundName = event === "workStarts" ? "work" : "finish";
    Sound.play(soundName);

    if (this.canSurface()) {
      State.focusId = AIRADORO_ID;
      const task = this.getTask();
      if (task) task.pillBadge = null;

      if (State.mode !== "expanded") {
        this.island?.alert("airadoro");
      } else if (State.view !== "airadoro") {
        this.island?.setView("airadoro");
      }
    } else if (State.focusId !== AIRADORO_ID) {
      State.setPillBadge(AIRADORO_ID, "finished");
    }
  }

  private canSurface(): boolean {
    if (State.pendingApproval != null) return false;
    if (State.mode !== "expanded") return true;
    switch (State.view) {
      case "overview":
      case "airadoro":
      case "empty":
      case "finished":
      case "error":
        return true;
      default:
        return false;
    }
  }

  private getTask(): AgentTask | undefined {
    return State.tasks.find((t) => t.id === AIRADORO_ID);
  }

  private paint() {
    const task = this.getTask();
    if (!task) return;

    if (this.snap.phase === "idle") {
      this.paintIdle();
      return;
    }

    if (this.snap.paused) {
      task.state = "idle";
      task.steps = [t("Paused")];
      return;
    }

    task.state = this.snap.phase === "work" ? "working" : "idle";
    const step = this.snap.phase === "work" ? t("Airadoro · Work") : t("Airadoro · Rest");
    task.steps = [step];
  }

  private paintIdle() {
    const task = this.getTask();
    if (!task) return;
    task.state = "idle";
    task.steps = [];
    task.pillBadge = null;
    task.name = "Airadoro";
  }
}

export const Airadoro = new AiradoroManager();

export function registerAiradoroHandlers(island: Island) {
  Airadoro.register(island);
}
