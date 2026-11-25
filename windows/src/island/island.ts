// The island: DOM shell, sizing animation, Mochi placement, mouse handling.
// Mirrors IslandRootView.swift + IslandWindowController.swift.

import { Tracked, Spring, clamp } from "../core/anim";
import { Bridge, IS_TAURI, onDragDrop, onEvent, type DragDropPayload } from "../core/bridge";
import {
  CLOSED_BOT_D, CLOSED_H, SLIM_BAR_H, SLIM_BAR_W, closedContent, closedIsland, closedWidth, type ClosedContent,
} from "../core/closed";
import {
  CHAT_OVERLAY_H, COMPACT_W, EXPANDED_CORNER, EXPANDED_W, NOTCH_H, NOTCH_W, PANEL_H, PANEL_W,
  ROUNDED_CORNER, VIEW_LAYOUTS, botPosition, chatPromptHeight,
  islandSize,
  QUESTION_PICKER_H,
  type BotEmoteName, type IslandMode, type IslandViewName,
} from "../core/layout";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { SPOTIFY_ID, Spotify, currentArtwork, extractArtworkPalette, isAd, islandDances, spotifyPosition } from "../core/spotify";
import { SpotifyLyrics, activeLyricLine } from "../core/lyrics";
import { BotEngine, hexToRGB } from "../mochi/engine";
import { Greeting } from "../mochi/greeting";
import { syncMiniBotStates, tickMiniBots } from "../mochi/minibots";
import { SeasonCache, parseOutfit } from "../mochi/wardrobe";
import { UploadCanvas } from "../upload/canvas";
import { USC, UploadSeq, uploadProgressCurve } from "../upload/sequence";
import { dominantPct, planColor } from "../core/plan";
import { dueAgendaReminders, loadAgendaTasks, markReminderNotified, pendingCountForDate, tasksForDay } from "../core/agenda";
import { dayKey } from "../core/calendar";
import { Weather, WEATHER_TTL_SEC, resolveDayPhase, wmoCondition } from "../core/weather";
import { Clipboard } from "../core/clipboard";
import { AIRADORO_ID, AiradoroEngine } from "../core/airadoro";
import { Airadoro } from "./airadoro";
import { language, t, tl } from "../i18n/i18n";
import { claudeCompactPillVisible, closePlanCard, openPlanColor, planCardOpen } from "../views/usage";
import { buildHeader, buildViews, type ViewActions, type ViewHost } from "../views/views";
import { h } from "../views/dom";
import { buildSessionDropList, type SessionDropList } from "../views/session-drop";
import { DROP_TEXT_RIGHT_WITH_LIST, dropTargetAt, dropTargets } from "../core/launch";
import { IslandStateMachine } from "./fsm";
import { refreshHookPills } from "./integrations";
import { restoreAlertFocus } from "./hooks";
import { DesktopLink } from "./desktop";
import type { ViewCommand } from "./shortcuts";
import { DRAG_THRESHOLD } from "../mochi/desktop-logic";
import { Updates } from "./update";
import { UPDATE_BLUE, showsUpdateHint } from "../whats-new/whats-new";

const BOT_OVERHANG = 40;
const SVG_NS = "http://www.w3.org/2000/svg";
const PLAN_RING_CIRCUMFERENCE = 2 * Math.PI * 4.5;

function makeCompactSvg(paths: string[]): SVGSVGElement {
  const el = document.createElementNS(SVG_NS, "svg");
  el.setAttribute("viewBox", "0 0 16 16");
  el.setAttribute("fill", "none");
  el.setAttribute("width", "11");
  el.setAttribute("height", "11");
  el.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    p.setAttribute("stroke", "currentColor");
    p.setAttribute("stroke-width", "1.6");
    p.setAttribute("stroke-linecap", "round");
    p.setAttribute("stroke-linejoin", "round");
    el.appendChild(p);
  }
  return el;
}

function makePlanRingSvg(): { svg: SVGSVGElement; arc: SVGCircleElement } {
  const el = document.createElementNS(SVG_NS, "svg");
  el.setAttribute("viewBox", "0 0 12 12");
  el.setAttribute("width", "12");
  el.setAttribute("height", "12");
  el.setAttribute("class", "compact-plan-ring");
  el.setAttribute("aria-hidden", "true");
  const track = document.createElementNS(SVG_NS, "circle");
  track.setAttribute("cx", "6");
  track.setAttribute("cy", "6");
  track.setAttribute("r", "4.5");
  track.setAttribute("fill", "none");
  track.setAttribute("stroke", "rgba(255,255,255,0.16)");
  track.setAttribute("stroke-width", "1.75");
  const arc = document.createElementNS(SVG_NS, "circle");
  arc.setAttribute("cx", "6");
  arc.setAttribute("cy", "6");
  arc.setAttribute("r", "4.5");
  arc.setAttribute("fill", "none");
  arc.setAttribute("stroke", "var(--plan)");
  arc.setAttribute("stroke-width", "1.75");
  arc.setAttribute("stroke-linecap", "round");
  arc.setAttribute("stroke-dasharray", PLAN_RING_CIRCUMFERENCE.toFixed(2));
  arc.setAttribute("stroke-dashoffset", PLAN_RING_CIRCUMFERENCE.toFixed(2));
  arc.setAttribute("transform", "rotate(-90 6 6)");
  el.append(track, arc);
  return { svg: el, arc };
}

function makeEarSvg(side: "left" | "right"): SVGSVGElement {
  const el = document.createElementNS(SVG_NS, "svg");
  el.setAttribute("class", `island-ear ${side}`);
  el.setAttribute("viewBox", "0 0 32 30");
  el.setAttribute("fill", "none");
  el.setAttribute("preserveAspectRatio", "none");
  el.setAttribute("shape-rendering", "geometricPrecision");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute(
    "d",
    side === "left"
      ? "M 0 0 C 13.43 0 30 16.57 30 30 L 32 30 L 32 0 Z"
      : "M 2 30 C 2 16.57 18.57 0 32 0 L 0 0 L 0 30 Z",
  );
  path.setAttribute("fill", "currentColor");
  el.append(path);
  return el;
}
const UPDATE_BLUE_RGB = hexToRGB(UPDATE_BLUE);
const CLAUDE_DESKTOP_ID = "agent_claude-desktop";
/** Extra canvas on each side of Mochi, for the witch hat's brim and the Santa hat's tip. */
const BOT_SIDE = 24;
/** Same margin as the Rust hit test (src-tauri/src/island.rs). */
const HIT_MARGIN = 14;

/** The views with a text field: the island takes the keyboard while one is on. */
const TYPING_VIEWS: ReadonlySet<IslandViewName> = new Set(["prompt", "launch", "agenda", "clipboard"]);

/** Modal/alert views where the bottom navigation dock steps aside so card actions fill cleanly. */
const DOCK_HIDDEN_VIEWS: ReadonlySet<IslandViewName> = new Set([
  "greeting", "upload", "uploading", "choose", "approval", "question",
  "error", "finished", "confused", "note", "update", "whatsNew", "reminder",
]);

/** The three views the drop sequence owns; leaving them stops the engine. */
const UPLOAD_VIEWS: ReadonlySet<IslandViewName> = new Set(["upload", "uploading", "choose"]);

/** Seconds between the drop and the moment the progress bar starts filling. */
const PRE_PROGRESS = USC.T_PROG_START - USC.T_DROP;

const modeOrder = (m: IslandMode) => (m === "hidden" ? 0 : m === "compact" ? 1 : 2);

export class Island {
  readonly fsm = new IslandStateMachine();
  /** Mochi on the desktop: his life cycle and the drag out of the island. */
  readonly desktop: DesktopLink;

  private root: HTMLElement;
  private islandEl!: HTMLElement;
  private clipEl!: HTMLElement;
  private contentEl!: HTMLElement;
  private viewsEl!: HTMLElement;
  private botCanvas!: HTMLCanvasElement;
  private botGlow!: HTMLElement;
  private greetingCanvas!: HTMLCanvasElement;
  private miniGrid!: HTMLElement;
  private clockEl!: HTMLElement;
  private clockTimer?: number;
  /** The closed island's one line (core/closed.ts), and what it last showed. */
  private closedEl!: HTMLElement;
  private closedDot!: HTMLElement;
  private closedText!: HTMLElement;
  private closedKey = "";
  /** Width of the closed island for what it shows now. */
  private closedW = 120;
  /** Mochi's little life in the closed island: where he looks, and until when
   *  the loop runs for what he is doing (a blink, a glance). */
  private closedLook = { x: 0, y: 0 };
  private closedAwakeUntil = 0;
  private closedLife: number | null = null;
  /** The size the window was last folded to, so a new one is only sent on a change. */
  private collapsedTo = { w: 0, h: 0 };
  private countdown!: HTMLElement;
  private compactPlan!: HTMLElement;
  private compactPlanArc!: SVGCircleElement;
  private compactPlanLabel!: HTMLElement;
  private compactAgenda!: HTMLElement;
  private compactAgendaLabel!: HTMLElement;
  private compactAgendaCount!: HTMLElement;
  private compactWeather!: HTMLElement;
  private compactWeatherIcon!: HTMLElement;
  private compactWeatherLabel!: HTMLElement;
  private compactWeatherDot!: HTMLElement;
  private compactAiradoro!: HTMLElement;
  private compactAiradoroLabel!: HTMLElement;
  private compactAiradoroTimer: number | null = null;
  private compactBotCx = 24;
  private compactGridH = 16;
  private compactTargetW = COMPACT_W;
  private compactTargetH = 34;
  private compactLyric!: HTMLElement;
  private compactLyricText!: HTMLElement;
  private compactLyricTimer: number | null = null;
  private wakeStrip!: HTMLElement;
  private musicBackdrop!: HTMLElement;
  private musicBackdropImg!: HTMLImageElement;
  private weatherBackdrop!: HTMLElement;

  private header!: ViewHost & { dockEl?: HTMLElement };
  private views!: Map<IslandViewName, ViewHost>;
  private uploadCanvas!: UploadCanvas;
  /** The sessions listed on the drop card while a file is over it. */
  private sessionDrop!: SessionDropList;

  private width = new Tracked(NOTCH_W);
  private height = new Tracked(0);
  private radius = new Tracked(ROUNDED_CORNER);
  private botCx = new Spring(46);
  private botCy = new Spring(16);
  private botSize = new Spring(10);

  private engine = new BotEngine();
  private greeting = new Greeting();
  private greetingShown = false;
  private seasons = new SeasonCache();

  private running = false;
  private lastFrame = 0;
  private dirty = true;
  private canvasPx = 0;
  /** The pixel ratio Mochi's bitmap was sized for: it changes with the monitor. */
  private canvasDpr = 0;

  // Rust starts the window at full size so the launch greeting has room.
  private collapsed = false;
  private collapseTimer: number | null = null;
  private wasInIsland = false;
  /** A reply is being typed in a card (WhatsApp): the island stays open. */
  private holdingOpen = false;
  /** Last shape handed to Rust for the click-through test. */
  private pushedRect = { x: -1, y: -1, w: -1, h: -1 };

  // Bot hover → love (IslandWindowController.botHoverIn)
  private botHovering = false;
  private botHoverTimer: number | null = null;
  private lastLoveTime = 0;
  private botHoverStart = { x: 0, y: 0 };

  private confusedRecovery: number | null = null;
  private prevViewBeforeConfused: IslandViewName = "overview";
  private lastSyncedView: IslandViewName | null = null;

  /** The launch greeting ended, or the island came out of hidden — two of the
   *  moments the Monday recap may open (see src/recap/recap.ts). */
  onGreetingDone: (() => void) | null = null;
  onWake: (() => void) | null = null;

  /** Where a press on Mochi started: moving past DRAG_THRESHOLD drags him out. */
  private botPress: { x: number; y: number } | null = null;

  /** The next reveal from hidden makes no peek (music starting, as on macOS). */
  private silentReveal = false;

  /** Drop sequence bookkeeping: last tick played, and whether the ✓ has fired. */
  private uploadTens = 0;
  private uploadDone = false;
  private dragLeaveTimer: number | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.desktop = new DesktopLink({
      reveal: () => this.reveal(),
      wardrobeFromDesktop: () => this.wardrobeFromDesktop(),
      dizzyFromDesktop: () => this.handleDizzy(),
    });
    this.build();
    this.wireFsm();
    this.wireInput();
    this.engine.onDizzy = () => this.handleDizzy();
    this.greeting.onComplete = () => {
      this.fsm.greetComplete();
      this.onGreetingDone?.();
    };
    State.subscribe(() => {
      this.dirty = true;
      this.ensureRunning();
    });
    Weather.subscribe(() => {
      this.dirty = true;
      this.ensureRunning();
    });
    void Weather.ensureLoaded(false);
    window.setInterval(() => {
      void Weather.ensureLoaded(false);
    }, WEATHER_TTL_SEC * 1000);
  }

  /** The request has its answer: the card goes and the session carries on. */
  private closeApproval() {
    State.endApproval();
    if (State.pendingApproval) {
      const view = State.pendingApproval.questions ? "question" : "approval";
      this.setView(view);
      Sound.play(view);
      return;
    }
    this.fsm.pinned = false;
    this.setView(State.defaultView());
  }

  /**
   * Folds a card that is waiting for an answer down to the compact island,
   * without answering it (Mac #290). Nothing is decided: the request keeps
   * waiting, the island stays on screen, and opening it shows the card again.
   */
  foldApproval() {
    if (!State.pendingApproval || State.mode !== "expanded") return;
    State.isPinned = true;
    this.fsm.pinned = true;
    this.fsm.forcePetit();
  }

  // ── DOM ─────────────────────────────────────────────────────────────────────

  private build() {
    const actions: ViewActions = {
      setView: (v) => this.setView(v),
      cancelDrop: () => this.discardDrop(),
      collapse: () => this.collapse(),
      foldApproval: () => this.foldApproval(),
      setFocus: (id) => {
        State.setFocus(id);
        Sound.play("blip");
        // A pill with a waiting request opens on its card: going back to it
        // after looking at another pill brings the card up again.
        const req = State.pendingApproval;
        if (req?.pillId === id) this.setView(req.questions ? "question" : "approval");
      },
      openTerminal: () => {
        const task = State.focusTask;
        // Sessions from the Claude desktop app live there, not in a terminal.
        if (task?.id === CLAUDE_DESKTOP_ID) void Bridge.openClaudeDesktop();
        else void Bridge.openSession(task?.sessionId ?? null, task?.sessionCwd ?? null);
      },
      // The ↗ button — same targets as openAgentTarget() on macOS.
      openTarget: () => {
        const task = State.focusTask;
        if (!task) return;
        const urls: Record<string, string> = {
          integration_resend: "https://resend.com/emails",
          integration_vercel: "https://vercel.com/dashboard",
          integration_github: "https://github.com/pulls",
          integration_stripe: "https://dashboard.stripe.com/payments",
          integration_notion: "https://notion.so",
          integration_calcom: "https://app.cal.com/bookings",
        };
        if (task.id === CLAUDE_DESKTOP_ID) void Bridge.openClaudeDesktop();
        else if (task.id === "integration_claude" || task.sessionId) {
          void Bridge.openSession(task.sessionId ?? null, task.sessionCwd ?? null);
        } else if (task.id === "integration_n8n") void Bridge.openN8n();
        // WhatsApp Desktop at the open conversation; WhatsApp Web when it isn't installed.
        else if (task.id === "integration_whatsapp") void Bridge.whatsappOpenApp();
        else if (task.id === "integration_gitea") void Bridge.openGitea();
        else if (task.id === SPOTIFY_ID) void Bridge.spotifyOpen();
        else if (urls[task.id]) void Bridge.openUrl(urls[task.id]);
      },
      openUrl: (url) => {
        if (url) void Bridge.openUrl(url);
      },
      decide: (d) => {
        const req = State.pendingApproval;
        void Bridge.log(`decide ${d} req=${req?.requestId ?? "none"}`);
        if (!req) return;
        Sound.play(d === "deny" ? "blip" : "approve");
        void Bridge.approvalDecision(req.requestId, d);
        this.closeApproval();
      },
      answer: (answers) => {
        const req = State.pendingApproval;
        if (!req) return;
        Sound.play("approve");
        void Bridge.approvalAnswer(req.requestId, answers);
        this.closeApproval();
      },
      answerInTerminal: () => {
        const req = State.pendingApproval;
        if (!req) return;
        Sound.play("blip");
        void Bridge.approvalDecline(req.requestId);
        this.closeApproval();
      },
      toggleSound: () => {
        State.settings.soundEnabled = !State.settings.soundEnabled;
        Sound.setEnabled(State.settings.soundEnabled);
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      setVolume: (v) => {
        State.settings.soundVolume = v;
        Sound.setVolume(v);
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      setAutoClose: (s) => {
        State.settings.autoCloseInterval = s;
        this.fsm.homeToPetitDelay = s;
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      openSettingsWindow: (page?: string) => void Bridge.openSettingsWindow(page),
      blip: () => Sound.play("blip"),
      chooseOutfit: (selection) => {
        if (parseOutfit(State.settings.mochiOutfit) === selection) return;
        State.settings.mochiOutfit = selection;
        void Bridge.saveSettings(State.settings);
        Sound.play("pop");
        this.engine.triggerEmote("proud");
        State.notify();
      },
      previewOutfit: (outfit) => {
        State.wardrobePreview = outfit;
        State.notify();
      },
      keyboard: (on) => {
        // The chat and launch views manage the keyboard on their own.
        if (on) void Bridge.focusWindow(true);
        else if (!TYPING_VIEWS.has(State.view) && State.mode === "expanded") void Bridge.focusWindow(false);
      },
      launched: () => {
        Sound.play("send");
        this.engine.triggerEmote("happy");
        this.collapse();
      },
      emote: (name) => this.emote(name),
      focusTask: (title, taskId) => {
        if (Airadoro.startForTask(title, taskId)) {
          State.setFocus(AIRADORO_ID);
          this.setView("overview");
        }
      },
      sendToChat: (text) => {
        State.promptContext = {
          kind: "window",
          appName: t("Clipboard"),
          title: text.trim().slice(0, 140),
          url: /^https?:\/\/\S+$/i.test(text.trim()) ? text.trim() : undefined,
        };
        this.setView("prompt");
      },
      pickConvertFile: () => {
        void this.pickFileForConvert();
      },
      holdOpen: (on) => {
        if (this.holdingOpen === on) return;
        this.holdingOpen = on;
        if (on) {
          this.fsm.pinned = true;
          this.fsm.cancelTimers();
        } else {
          this.fsm.pinned = State.isPinned || State.pendingApproval != null;
          if (!this.fsm.pinned && !this.wasInIsland && this.fsm.state === "home") this.fsm.mouseLeft();
        }
      },
    };

    this.wakeStrip = h("div", { id: "wake-strip" });
    this.closedDot = h("span", { class: "dot" });
    this.closedText = h("span", { class: "text" });
    this.closedEl = h("div", { id: "island-closed" }, this.closedDot, this.closedText);
    this.botGlow = h("div", { id: "bot-glow" });
    this.botCanvas = h("canvas", { id: "bot-canvas" });
    this.greetingCanvas = h("canvas", { id: "greeting-canvas" });
    this.miniGrid = h("div", { id: "mini-grid" });
    this.clockEl = h("div", { id: "island-clock" });
    this.countdown = h("div", { id: "countdown" });
    const planRing = makePlanRingSvg();
    this.compactPlanArc = planRing.arc;
    this.compactPlanLabel = h("span", { class: "compact-plan-label" });
    this.compactPlan = h(
      "button",
      {
        id: "compact-plan",
        title: tl("Claude plan usage"),
        onmousedown: (e) => {
          e.stopPropagation();
        },
        onclick: (e) => {
          e.stopPropagation();
          const me = e as MouseEvent;
          if (me.button === 0) this.openClaudePlan();
        },
      },
      planRing.svg,
      this.compactPlanLabel,
    );
    const agendaIcon = h(
      "span",
      { class: "compact-agenda-ico" },
      makeCompactSvg([
        "M3.5 4.5h9a1.2 1.2 0 0 1 1.2 1.2v6.8a1.2 1.2 0 0 1-1.2 1.2h-9a1.2 1.2 0 0 1-1.2-1.2V5.7a1.2 1.2 0 0 1 1.2-1.2z",
        "M5.5 2.5v2",
        "M10.5 2.5v2",
        "M2.5 7.2h11",
      ]),
    );
    this.compactAgendaLabel = h("span", { class: "compact-agenda-label" });
    this.compactAgendaCount = h("span", { class: "compact-agenda-count" });
    this.compactAgenda = h(
      "button",
      {
        id: "compact-agenda",
        title: tl("Calendar"),
        onmousedown: (e) => {
          e.stopPropagation();
        },
        onclick: (e) => {
          e.stopPropagation();
          const me = e as MouseEvent;
          if (me.button === 0) this.openAgenda();
        },
      },
      agendaIcon,
      this.compactAgendaLabel,
      this.compactAgendaCount,
    );
    this.compactWeatherIcon = h("span", { class: "compact-weather-ico" });
    this.compactWeatherLabel = h("span", { class: "compact-weather-label" });
    this.compactWeatherDot = h("i", { class: "compact-weather-dot" });
    this.compactWeather = h(
      "button",
      {
        id: "compact-weather",
        title: tl("Weather"),
        onmousedown: (e) => {
          e.stopPropagation();
        },
        onclick: (e) => {
          e.stopPropagation();
          const me = e as MouseEvent;
          if (me.button === 0) this.openWeather();
        },
      },
      this.compactWeatherIcon,
      this.compactWeatherLabel,
      this.compactWeatherDot,
    );
    this.compactAiradoroLabel = h("span", { class: "compact-airadoro-label" });
    const airadoroIcon = h(
      "span",
      { class: "compact-airadoro-ico" },
      makeCompactSvg([
        "M8 4.8V8l2.2 1.4",
        "M8 2.3a5.7 5.7 0 1 0 0 11.4 5.7 5.7 0 0 0 0-11.4z",
      ]),
    );
    this.compactAiradoro = h(
      "button",
      {
        id: "compact-airadoro",
        title: "Airadoro",
        onmousedown: (e) => {
          e.stopPropagation();
        },
        onclick: (e) => {
          e.stopPropagation();
          const me = e as MouseEvent;
          if (me.button === 0) {
            Sound.play("click");
            State.setFocus(AIRADORO_ID);
            this.expand("overview");
          }
        },
      },
      airadoroIcon,
      this.compactAiradoroLabel,
    );
    this.compactLyricText = h("span", { class: "compact-lyric-text" });
    this.compactLyric = h(
      "button",
      {
        id: "compact-lyric",
        title: tl("Lyrics"),
        onmousedown: (e) => {
          e.stopPropagation();
        },
        onclick: (e) => {
          e.stopPropagation();
          const me = e as MouseEvent;
          if (me.button === 0) {
            Sound.play("click");
            State.setFocus(SPOTIFY_ID);
            this.expand("music");
          }
        },
      },
      h("i", { class: "compact-lyric-note", text: "♪" }),
      this.compactLyricText,
    );

    this.header = buildHeader(actions);
    this.views = buildViews(actions, () => this.animateGeometry(false));
    this.viewsEl = h("div", { id: "views" });
    for (const v of this.views.values()) this.viewsEl.append(v.el);
    this.contentEl = h("div", { id: "content" }, this.header.el, this.viewsEl, this.header.dockEl);

    // The drop sequence draws the card, the bar and its own Mochi. It sits under
    // the header, which stays visible on top of it exactly as on macOS.
    this.uploadCanvas = new UploadCanvas({
      ask: () => {
        State.promptContext = State.droppedFile
          ? { kind: "file", name: State.droppedFile.name, path: State.droppedFile.path }
          : null;
        this.setView("prompt");
      },
      convert: () => {
        this.setView("convert");
      },
      cancel: () => this.discardDrop(),
    });
    this.sessionDrop = buildSessionDropList();
    this.uploadCanvas.el.append(this.sessionDrop.el);

    this.musicBackdropImg = h("img", {
      class: "music-backdrop-art",
      alt: "",
      draggable: "false",
      crossOrigin: "anonymous",
    }) as HTMLImageElement;
    this.musicBackdropImg.addEventListener("load", () => this.applyMusicPalette());
    this.musicBackdrop = h(
      "div",
      { class: "music-backdrop" },
      this.musicBackdropImg,
      h("div", { class: "music-backdrop-fallback" }),
      h("div", { class: "music-backdrop-vignette" }),
    );
    this.weatherBackdrop = h("div", { class: "weather-backdrop" });

    this.clipEl = h(
      "div",
      { id: "island-clip" },
      this.musicBackdrop,
      this.weatherBackdrop,
      this.greetingCanvas,
      this.uploadCanvas.el,
      this.contentEl,
    );
    this.islandEl = h(
      "div",
      { id: "island" },
      makeEarSvg("left"),
      makeEarSvg("right"),
      this.clipEl,
      this.botGlow,
      this.botCanvas,
      this.miniGrid,
      this.compactPlan,
      this.compactAgenda,
      this.compactWeather,
      this.compactAiradoro,
      this.compactLyric,
      this.clockEl,
      this.closedEl,
      this.countdown,
    );

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.greetingCanvas.width = Math.round(EXPANDED_W * dpr);
    this.greetingCanvas.height = Math.round(150 * dpr);
    this.greetingCanvas.style.width = `${EXPANDED_W}px`;
    this.greetingCanvas.style.height = "150px";

    this.root.append(this.wakeStrip, this.islandEl);
    this.applyGeometry();
  }

  // ── FSM ─────────────────────────────────────────────────────────────────────

  private wireFsm() {
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    this.fsm.openOnHover = State.settings.openOnHover;
    this.fsm.onTransition = (from, to) => {
      // The greeting is over, however it ended: back to his desktop spot.
      if (from === "coucou" && to !== "coucou") this.desktop.launch();
      switch (to) {
        case "hidden":
          this.setMode("hidden");
          break;
        case "petit":
          if (from === "coucou") this.greeting.interrupt();
          else if (from === "hidden" && !this.silentReveal) Sound.play("peek");
          this.setMode("compact");
          if (from === "coucou") State.view = State.defaultView();
          if (!this.wasInIsland) this.fsm.mouseLeft();
          break;
        case "home":
          this.expand(this.openingView());
          if (!this.wasInIsland) this.fsm.mouseLeft();
          // Hooks may have been installed in a terminal since: the idle cards
          // say so on the next open, without polling while the island is shut.
          void refreshHookPills();
          break;
        case "coucou":
          this.expand("greeting");
          this.greeting.start();
          break;
      }
      State.notify();
      if (from === "hidden") this.onWake?.();
    };
  }

  launch() {
    this.fsm.launch();
  }

  // ── Mode / view ─────────────────────────────────────────────────────────────

  private setMode(mode: IslandMode) {
    const prev = State.mode;
    if (mode === prev) return;
    if (prev === "compact") this.engine.tgEs = 1;
    State.mode = mode;
    if (mode === "expanded") Sound.play("open");
    if (prev === "expanded") {
      Sound.play("close");
      // A folded card is still waiting: it keeps the island pinned.
      if (!State.pendingApproval) State.isPinned = false;
      void Bridge.focusWindow(false);
      // Another pill's alert borrowed the front: the pill you had comes back (Mac).
      restoreAlertFocus();
    }
    if (mode !== "expanded") {
      closePlanCard();
      this.engine.resetMorph();
      // Nothing can be seen of the sequence once the island is shut, and leaving
      // it running would keep the frame loop awake — the island must cost
      // nothing while hidden.
      UploadSeq.deactivate();
    }
    // Folding all the way: the closed island's width for what it will show.
    if (mode === "hidden") this.updateClosed();
    else this.closedEl.classList.remove("on");
    this.scheduleClosedLife();
    if (mode === "compact") this.applyCompactLayout();
    this.updateWindowCollapsed();
    this.animateGeometry(modeOrder(mode) < modeOrder(prev));
    State.notify();
  }

  /** True while the drop sequence owns the island body. */
  private get uploadActive(): boolean {
    return State.mode === "expanded" && UploadSeq.isActive && UPLOAD_VIEWS.has(State.view);
  }

  /** Navigating out of the drop flow ends the sequence, as on macOS. */
  private stopSequenceIfLeaving(view: IslandViewName) {
    if (UploadSeq.isActive && !UPLOAD_VIEWS.has(view)) UploadSeq.deactivate();
  }

  /** Click on compact plan gauge: opens the Claude plan card on the overview. */
  openClaudePlan() {
    Sound.resume();
    State.lastActivity = performance.now();
    this.fsm.userInteracted();
    State.planDetailIsCodex = false;
    State.showingPlanDetail = true;
    this.fsm.forceHome();
    this.expand("overview");
    State.notify();
  }

  /** Click on compact agenda badge: opens the Calendar & Task Planner view. */
  openAgenda() {
    Sound.resume();
    State.lastActivity = performance.now();
    this.fsm.userInteracted();
    this.fsm.forceHome();
    this.expand("agenda");
    State.notify();
  }

  /** Click on compact weather pill: opens the Live Weather view. */
  openWeather() {
    Sound.resume();
    State.lastActivity = performance.now();
    this.fsm.userInteracted();
    this.fsm.forceHome();
    this.expand("weather");
    State.notify();
  }

  expand(view: IslandViewName) {
    this.stopSequenceIfLeaving(view);
    if (view !== "overview") closePlanCard();
    State.view = view;
    if (State.mode !== "expanded") this.setMode("expanded");
    else this.animateGeometry(false);
    State.lastActivity = performance.now();
    State.notify();
  }

  setView(view: IslandViewName) {
    this.stopSequenceIfLeaving(view);
    if (view !== "overview") closePlanCard();
    if (State.mode !== "expanded") {
      this.fsm.forceHome();
      State.view = view;
      this.animateGeometry(false);
      State.notify();
      return;
    }
    const grew = VIEW_LAYOUTS[view].height >= VIEW_LAYOUTS[State.view].height;
    State.view = view;
    State.lastActivity = performance.now();
    this.animateGeometry(!grew);
    State.notify();
  }

  collapse() {
    // A waiting card is only ever folded, never dropped by a close.
    if (State.pendingApproval) {
      this.foldApproval();
      return;
    }
    State.isPinned = false;
    this.fsm.pinned = false;
    // Drive the state machine rather than the mode: setting the mode behind its
    // back left it thinking the island was still open, and a click on the compact
    // island then did nothing — the island could never be reopened.
    if (this.isSlimShape) this.fsm.forceHidden();
    else this.fsm.forcePetit();
  }

  /** Alert from the hook server: open on this view. Pinned alerts never auto-close. */
  alert(view: IslandViewName) {
    this.fsm.pinned = State.isPinned;
    this.fsm.forceHome();
    this.expand(view);
  }

  /** A new Coucou waits and Mochi has nothing else to say (he is blue). */
  private updateHintOn(): boolean {
    return !State.paused && showsUpdateHint(Updates.waiting(), State.effectiveState, State.pendingApproval != null);
  }

  /**
   * What a click or a hover opens on: while Mochi is blue, the new version
   * ("Coucou X is out", Update now); otherwise the usual view. A waiting
   * permission or question always comes first.
   */
  private openingView(): IslandViewName {
    return this.updateHintOn() ? "update" : State.defaultView();
  }

  reveal() {
    this.fsm.reveal();
  }

  /** Music started playing: the compact island, without the peek sound (musicReveal). */
  revealSilently() {
    this.silentReveal = true;
    this.fsm.reveal();
    this.silentReveal = false;
  }

  /** Right-click on Mochi: wardrobe open ↔ back to the usual view. */
  toggleWardrobe() {
    if (State.paused || State.mode === "hidden") return;
    // The greeting and the drop sequence draw a Mochi of their own.
    if (State.mode === "expanded" && (State.view === "greeting" || this.uploadActive)) return;
    if (State.mode === "expanded" && State.view === "wardrobe") this.setView(State.defaultView());
    else this.setView("wardrobe");
  }

  /**
   * Right-click on the desktop Mochi (macOS openWardrobeFromDesktop): opens the
   * wardrobe from any state, or goes back if it is already open.
   */
  wardrobeFromDesktop() {
    this.wardrobeAnywhere();
  }

  /**
   * The wardrobe from any state — compact or hidden island included — or back
   * to the usual view if it is already open. The desktop Mochi's right-click
   * and the wardrobe shortcut (`open-wardrobe`) both land here.
   */
  wardrobeAnywhere() {
    if (State.mode === "expanded" && State.view === "wardrobe") {
      this.setView(State.defaultView());
      return;
    }
    if (State.paused) return;
    this.alert("wardrobe");
  }

  /** An alert stopped waiting for an answer: let the island auto-close again. */
  dropPin() {
    this.fsm.pinned = false;
    // The countdown the pin held back starts now, if the mouse is elsewhere.
    if (!this.wasInIsland) this.fsm.mouseLeft();
  }

  // ── Keyboard shortcuts (island/shortcuts.ts) ────────────────────────────────

  emote(name: BotEmoteName) {
    this.engine.triggerEmote(name);
    this.ensureRunning();
  }

  /** Ctrl+P: keep the open island from folding away, or let it fold again. */
  setPinned(on: boolean) {
    State.isPinned = on;
    this.fsm.pinned = on;
    if (on) {
      // The countdown bar reads the state machine's deadline, cleared with it.
      this.fsm.cancelTimers();
    } else if (!this.wasInIsland && this.fsm.state === "home") {
      this.fsm.mouseLeft();
    }
    State.notify();
  }

  /** The island takes the keyboard, so its own shortcuts work (Mac: makeKey).
   *  It gives it back when it closes, or when the chat is left. */
  takeKeyboard() {
    void Bridge.focusWindow(true);
  }

  /** The desktop shortcut needs a desktop Mochi: none on GNOME's Wayland. */
  canLeaveIsland(): boolean {
    return this.desktop.supported;
  }

  /** The desktop shortcut (macOS DesktopMochiController.flyOutOrHome). */
  flyOutOrHome() {
    // The greeting and the drop sequence draw a Mochi of their own: he stays
    // for them, as he does for a drag (canDragOut).
    const busy = State.mode === "expanded" && (State.view === "greeting" || this.uploadActive);
    if (busy && !State.mochiOnDesktop) return;
    this.desktop.flyOutOrHome();
  }

  /** Ctrl+O / Ctrl+E go to the view on screen. */
  viewCommand(command: ViewCommand) {
    this.views.get(State.view)?.command?.(command);
  }

  // ── File drop ───────────────────────────────────────────────────────────────

  private onDragDrop(e: DragDropPayload) {
    if (e.type !== "over") void Bridge.log(`drag ${e.type} ${e.paths?.length ?? 0} file(s)`);
    if (State.paused) return;
    if (this.dragLeaveTimer != null && e.type !== "leave") {
      window.clearTimeout(this.dragLeaveTimer);
      this.dragLeaveTimer = null;
    }
    // Tauri's own drag events say where the pointer is (Linux, where the page
    // hears no mouse during a drag); Windows has the cursor poll (onCursor).
    if (e.position && e.type !== "leave") {
      const dpr = window.devicePixelRatio || 1;
      const rect = this.islandRect();
      this.updateDropTarget(e.position.x / dpr - rect.x, e.position.y / dpr - rect.y);
    }
    switch (e.type) {
      case "enter":
      case "over": {
        if (State.fileDragOver) return;
        State.fileDragOver = true;
        this.engine.animateMorph(1);
        // enterZone must run before the island expands, so the sequence is
        // already active by the time the view becomes `upload`.
        UploadSeq.enterZone(State.mouseInIsland.x, State.mouseInIsland.y);
        this.alert("upload");
        break;
      }
      case "leave": {
        State.dropSessionTarget = null;
        if (!State.fileDragOver) return;
        State.fileDragOver = false;
        this.engine.animateMorph(0);
        // The island stays open briefly for recovery, but auto-exits upload mode
        // if the drop occurred outside or the drag was aborted.
        UploadSeq.exitZone();
        State.notify();
        if (this.dragLeaveTimer != null) window.clearTimeout(this.dragLeaveTimer);
        this.dragLeaveTimer = window.setTimeout(() => {
          this.dragLeaveTimer = null;
          if (!State.fileDragOver && State.view === "upload") {
            this.engine.animateMorph(0);
            this.setView(State.defaultView());
            if (!this.wasInIsland) {
              this.fsm.mouseLeft();
            }
          }
        }, 800);
        break;
      }
      case "drop": {
        State.fileDragOver = false;
        // Let go over one of the sessions on the drop card: into its prompt.
        const target = State.dropSessionTarget;
        State.dropSessionTarget = null;
        if (target && e.paths?.length) {
          this.dropIntoSession(target, e.paths);
          return;
        }
        const path = e.paths?.[0];
        if (!path) {
          this.engine.animateMorph(0);
          this.setView(State.defaultView());
          return;
        }
        this.swallow(path);
        break;
      }
    }
  }

  /** The session pill under the pointer on the drop card (island points), if any. */
  private updateDropTarget(x: number, y: number) {
    const targets = State.view === "upload" && State.fileDragOver && !UploadSeq.dropped ? dropTargets(State.tasks) : [];
    const i = targets.length > 0 ? dropTargetAt(x, y, targets.length) : null;
    State.dropSessionTarget = i == null ? null : targets[i].id;
  }

  /**
   * A file let go over a session on the drop card (SessionDrop.send): the
   * island folds, Rust brings the session's window forward and pastes the
   * paths there. When it can only copy them, a note says so.
   */
  private dropIntoSession(taskId: string, paths: string[]) {
    const task = State.tasks.find((x) => x.id === taskId);
    UploadSeq.deactivate();
    this.engine.animateMorph(0);
    this.setView(State.defaultView());
    this.collapse();
    if (!task?.sessionId) return;
    void Bridge.log(`drop: ${paths.length} file(s) into ${task.name}`);
    void Bridge.dropIntoSession(task.sessionId, task.sessionCwd ?? null, paths).then((outcome) => {
      if (outcome === "pasted") {
        Sound.play("send");
        this.engine.triggerEmote("happy");
        return;
      }
      Sound.play("error");
      if (outcome !== "copied") return;
      State.noteMessage = t("Copied: paste it into the session's terminal.");
      this.alert("note");
      window.setTimeout(() => {
        if (State.mode === "expanded" && State.view === "note") this.collapse();
      }, 4000);
    });
  }

  /**
   * Mochi eats the file. Nothing here waits on the file system: the copy into
   * the inbox runs in the background and swaps the path in when it lands, so a
   * slow disk can never stall the animation — same as FileDropHandler on macOS.
   */
  private swallow(path: string) {
    const name = path.split(/[\\/]/).pop() || "file";
    State.startNewChatSession();
    State.droppedOriginalPath = path;
    State.droppedFile = { name, path };
    State.promptContext = { kind: "file", name, path };
    void Bridge.chatReset();

    UploadSeq.performDrop(State.uploadDuration);
    this.uploadTens = 0;
    this.uploadDone = false;

    this.engine.gulp();
    Sound.play("approve");
    this.engine.triggerEmote("happy");
    this.engine.animateMorph(0);

    State.uploadProgress = 0;
    this.setView("uploading");
    this.ensureRunning();

    void Bridge.ingestFile(path)
      .then((file) => {
        // Cancelled (or replaced by another drop) while the copy was running.
        if (State.droppedFile?.path !== path) return;
        State.droppedFile = { name: file.name, path: file.path };
        State.promptContext = { kind: "file", name: file.name, path: file.path };
        State.notify();
      })
      .catch((err) => {
        if (State.droppedFile?.path !== path) return;
        UploadSeq.deactivate();
        State.noteMessage = String(err).replace(/^Error:\s*/, "");
        this.engine.animateMorph(0);
        this.setView("note");
        Sound.play("error");
        window.setTimeout(() => {
          // Only the note still on screen: setView would reopen a folded island
          // and replace a view the user opened since.
          if (State.mode === "expanded" && State.view === "note") this.setView(State.defaultView());
        }, 2400);
      });
  }

  /** "Cancel" on the dropped file: forget it, so the chat does not pick it up. */
  private discardDrop() {
    State.droppedOriginalPath = null;
    State.droppedFile = null;
    State.promptContext = null;
    this.setView(State.defaultView());
  }

  private async pickFileForConvert() {
    Sound.play("blip");
    this.fsm.pinned = true;
    this.fsm.cancelTimers();
    const picked = await Bridge.converterPickFile();
    this.fsm.pinned = State.isPinned || State.pendingApproval != null;
    if (!picked) {
      if (!this.fsm.pinned && !this.wasInIsland && this.fsm.state === "home") this.fsm.mouseLeft();
      return;
    }
    const name = picked.split(/[\\/]/).pop() || "file";
    State.droppedOriginalPath = picked;
    State.droppedFile = { name, path: picked };
    this.setView("convert");
  }

  /**
   * Sounds and view changes hung off the canvas timeline: a `tick` every 10 %,
   * the ✓ chime when the bar completes, then `choose` once Mochi has grown back.
   */
  private stepSequence() {
    const since = UploadSeq.sinceDrop();
    if (since == null) return;
    const dur = State.uploadDuration;
    const p = Math.max(0, Math.min(1, (since - PRE_PROGRESS) / dur));

    // The bar and the percentage follow the same eased curve as Mochi.
    State.uploadProgress = uploadProgressCurve(p);
    if (State.view === "uploading") this.views.get("uploading")?.sync();

    const tens = Math.floor(p * 10);
    if (tens > this.uploadTens && tens < 10) {
      this.uploadTens = tens;
      Sound.play("tick");
    }

    if (!this.uploadDone && since >= PRE_PROGRESS + dur) {
      this.uploadDone = true;
      Sound.play("approve");
      this.engine.triggerEmote("happy");
    }
    // The extra second is the grow-back, after which the choose card is up.
    if (since >= PRE_PROGRESS + dur + 1 && State.view === "uploading") {
      this.setView("choose");
    }
  }

  // ── Geometry ────────────────────────────────────────────────────────────────

  /** Slim Edge-Drop style notch bar when Shape = "slim". */
  private get isSlimShape(): boolean {
    return (State.settings.islandShape || "notch") === "slim";
  }

  /** The closed island stays on screen (anything but "hidden", or always in Slim mode). */
  private get closedShows(): boolean {
    return this.isSlimShape || closedIsland(State.settings.closedIsland) !== "hidden";
  }

  private currentSyncedLyric(): string | null {
    const track = Spotify.state.track;
    if (!State.spotifyPlaying || !track || isAd(track)) return null;
    return activeLyricLine(SpotifyLyrics.current, spotifyPosition(Spotify.state, Date.now()));
  }

  private currentCompactMusicLabel(): string | null {
    const track = Spotify.state.track;
    if (!State.spotifyPlaying || !track || isAd(track)) return null;
    const lyric = this.currentSyncedLyric();
    if (lyric) return lyric;
    if (!track.title) return null;
    return track.artist ? `${track.title} · ${track.artist}` : track.title;
  }

  private applyCompactLayout() {
    const hover = this.wasInIsland && State.mode === "compact";
    const padX = hover ? 16 : 14;
    const gap = 6;
    const otherCount = 0; // Mini-grid (mochi on the right) hidden per user request
    const hasWeather = false; // Weather pill on compact notch hidden per user request
    const musicLabel = State.mode === "compact" ? this.currentCompactMusicLabel() : null;
    const hasLyric = Boolean(musicLabel);
    const hasClock = State.settings.showClock && !hasLyric;
    const hasAiradoro = Airadoro.snapshot.phase !== "idle";
    const pendingToday = pendingCountForDate(loadAgendaTasks(), dayKey(new Date()));
    const hasAgenda = pendingToday > 0;
    const hasPlan = claudeCompactPillVisible();
    const hasAnyInfo = hasPlan || hasAgenda || hasAiradoro || hasClock || hasLyric || hasWeather || otherCount > 0;

    const gridW = otherCount === 0 ? 0 : otherCount === 1 ? 16 : 30;
    const gridH = otherCount === 0 ? 0 : otherCount <= 2 ? 16 : 30;
    this.compactGridH = gridH;

    if (!hasAnyInfo) {
      const w = hover ? COMPACT_W + 18 : COMPACT_W;
      const h = NOTCH_H + (hover ? 2 : 0);
      this.compactBotCx = w / 2;
      this.compactTargetW = w;
      this.compactTargetH = h;
      return;
    }

    // Left cluster: Mochi + Weather pill + optional Clock / Lyrics.
    let leftCursor = padX;
    this.compactBotCx = leftCursor + 20;
    leftCursor = this.compactBotCx + 16;

    if (hasWeather) {
      this.compactWeather.style.left = `${leftCursor}px`;
      leftCursor += Math.max(48, Math.ceil(this.compactWeather.offsetWidth || 56)) + gap;
    }

    // Measure right cluster widths (from right edge inward).
    const airaW = hasAiradoro ? Math.max(48, Math.ceil(this.compactAiradoro.offsetWidth || 54)) : 0;
    const agendaW = hasAgenda ? Math.max(44, Math.min(116, Math.ceil(this.compactAgenda.offsetWidth || 76))) : 0;
    const planW = hasPlan ? Math.max(40, Math.ceil(this.compactPlan.offsetWidth || 46)) : 0;
    const clockW = hasClock ? Math.max(72, Math.ceil(this.clockEl.scrollWidth || 84)) : 0;

    let rightNeeded = padX;
    if (gridW > 0) rightNeeded += gridW + gap;
    if (hasPlan) rightNeeded += planW + gap;
    if (hasAgenda) rightNeeded += agendaW + gap;
    if (hasAiradoro) rightNeeded += airaW + gap;

    const maxLyricW = Math.max(180, EXPANDED_W - leftCursor - rightNeeded - gap * 2);
    const lyricW = hasLyric
      ? Math.max(110, Math.min(maxLyricW, Math.ceil((this.compactLyricText.scrollWidth || 110) + 28)))
      : 0;

    const centerNeeded = hasLyric ? lyricW + gap * 2 : hasClock ? clockW + gap * 2 : 0;
    const minNeededW = leftCursor + centerNeeded + rightNeeded;
    const baseW = Math.max(COMPACT_W, Math.round(minNeededW));
    const w = hover ? baseW + 18 : baseW;
    const h = (otherCount >= 3 ? 38 : NOTCH_H) + (hover ? 2 : 0);

    // Anchor right-side indicators cleanly from the right edge of the capsule.
    let rightEdge = w - padX;
    if (otherCount > 0) {
      rightEdge -= gridW;
      this.miniGrid.style.left = `${rightEdge}px`;
      this.miniGrid.style.width = `${gridW}px`;
      this.miniGrid.style.height = `${gridH}px`;
      rightEdge -= gap;
    }
    if (hasPlan) {
      rightEdge -= planW;
      this.compactPlan.style.left = `${rightEdge}px`;
      rightEdge -= gap;
    }
    if (hasAgenda) {
      rightEdge -= agendaW;
      this.compactAgenda.style.left = `${rightEdge}px`;
      rightEdge -= gap;
    }
    if (hasAiradoro) {
      rightEdge -= airaW;
      this.compactAiradoro.style.left = `${rightEdge}px`;
      rightEdge -= gap;
    }

    if (hasLyric) {
      this.compactLyric.style.left = `${leftCursor}px`;
      this.compactLyric.style.right = `${Math.max(padX, w - rightEdge)}px`;
    } else if (hasClock) {
      const availCenter = Math.max(leftCursor, (w - clockW) / 2);
      const maxLeft = rightEdge - clockW;
      this.clockEl.style.left = `${Math.min(availCenter, Math.max(leftCursor, maxLeft))}px`;
      this.clockEl.style.width = `${clockW}px`;
    }

    this.compactTargetW = w;
    this.compactTargetH = h;
  }

  private targetSize(): { w: number; h: number; r: number } {
    if (State.mode === "hidden" && this.closedShows) {
      if (this.isSlimShape) return { w: SLIM_BAR_W, h: SLIM_BAR_H, r: 24 };
      return { w: this.closedW, h: CLOSED_H, r: 13 };
    }
    if (State.mode === "compact") {
      return { w: this.compactTargetW, h: this.compactTargetH, r: ROUNDED_CORNER };
    }
    let { w, h } = islandSize(State.mode, State.view, State.chatHistory.length);
    if (State.mode === "expanded") {
      w = EXPANDED_W;
      if (State.view === "prompt") {
        h = Math.max(308, Math.min(362, this.chatHeight));
      } else if (State.view === "overview") {
        const overviewEl = this.views.get("overview")?.el;
        const inDetail = planCardOpen() || Boolean(overviewEl?.classList.contains("is-detail"));
        if (inDetail) {
          h = 288;
        } else {
          const hasAgents = State.tasks.some((t) => t.id !== SPOTIFY_ID && t.id !== AIRADORO_ID);
          h = hasAgents ? 320 : 302;
        }
      } else if (State.view === "empty") {
        const hasAgents = State.tasks.some((t) => t.id !== SPOTIFY_ID && t.id !== AIRADORO_ID);
        h = hasAgents ? 316 : 300;
      } else if (State.view === "clipboard") {
        const clips = Clipboard.entries.length;
        h = Math.max(264, Math.min(316, 204 + clips * 36));
      } else if (State.view === "agenda") {
        const tasksToday = tasksForDay(loadAgendaTasks(), dayKey(new Date())).length;
        h = Math.max(292, Math.min(324, 256 + tasksToday * 22));
      }
    }
    if (State.mode === "expanded" && State.view === "question" && State.pendingApproval?.questions) {
      h = Math.max(h, QUESTION_PICKER_H);
    } else if (State.mode === "expanded" && State.view === "prompt" && State.chatOverlay !== "none") {
      h = Math.max(h, CHAT_OVERLAY_H);
    }
    const r = State.mode === "expanded" ? (this.isSlimShape ? 24 : EXPANDED_CORNER) : ROUNDED_CORNER;
    return { w, h, r };
  }

  private animateGeometry(shrinking: boolean) {
    const { w, h, r } = this.targetSize();
    const fast = State.settings.animationSpeed === "fast";
    if (shrinking) {
      const dur = fast ? 190 : 340;
      this.width.curveTowards(w, dur);
      this.height.curveTowards(h, dur);
      this.radius.curveTowards(r, dur);
    } else {
      const resp = fast ? 0.28 : 0.5;
      const damp = fast ? 0.78 : 0.72;
      this.width.springTo(w, resp, damp);
      this.height.springTo(h, resp, damp);
      this.radius.springTo(r, resp, damp);
    }
    this.ensureRunning();
  }

  private getScale(): number {
    const s = State.settings.islandScale;
    return s === "compact" ? 0.9 : s === "large" ? 1.1 : 1.0;
  }

  private get isFloatingIsland(): boolean {
    return (State.settings.islandShape || "notch") === "island";
  }

  private applyGeometry() {
    const scale = this.getScale();
    const w = this.width.value;
    const hh = this.height.value;
    const r = this.radius.value;
    const floating = this.isFloatingIsland;
    const topOffset = floating && hh > 0 ? 6 : 0;
    this.islandEl.style.top = `${topOffset}px`;
    this.islandEl.style.width = `${w}px`;
    this.islandEl.style.height = `${hh}px`;
    this.islandEl.style.borderRadius = floating
      ? State.mode === "expanded"
        ? `${r}px`
        : "999px"
      : this.isSlimShape && hh <= 8
        ? "0 0 24px 24px / 0 0 100% 100%"
        : `0 0 ${r}px ${r}px`;
    this.islandEl.style.transformOrigin = `top center`;
    this.islandEl.style.transform = `translateX(-50%) scale(${scale})`;
    const ear = !floating && hh > 2 ? Math.max(0, Math.min(12, hh * 0.45, r * 0.85)) : 0;
    this.islandEl.style.setProperty("--ear", `${ear.toFixed(2)}px`);
    const slimEarH = this.isSlimShape && !floating && hh > 10 ? Math.max(0, Math.min(28, hh * 0.45, r * 1.15)) : 0;
    const slimEarW = slimEarH > 0 ? slimEarH * (32 / 30) : 0;
    this.islandEl.style.setProperty("--slim-ear-w", `${slimEarW.toFixed(2)}px`);
    this.islandEl.style.setProperty("--slim-ear-h", `${slimEarH.toFixed(2)}px`);
    this.islandEl.style.setProperty("--slim-ear-overlap", `${(slimEarW - slimEarH).toFixed(2)}px`);
    // These follow the island as it resizes, so they belong here rather than in
    // the state-driven DOM sync.
    this.miniGrid.style.top = `${Math.max(0, (hh - this.compactGridH) / 2)}px`;
    this.clockEl.style.height = `${hh}px`;
    this.greetingCanvas.style.left = `${(w - EXPANDED_W) / 2}px`;
    this.uploadCanvas.el.style.left = `${(w - EXPANDED_W) / 2}px`;

    const rect = this.islandRect();
    const p = this.pushedRect;
    if (
      Math.abs(p.x - rect.x) > 0.5 ||
      Math.abs(p.y - rect.y) > 0.5 ||
      Math.abs(p.w - rect.w) > 0.5 ||
      Math.abs(p.h - rect.h) > 0.5
    ) {
      this.pushedRect = rect;
      void Bridge.setIslandRect(rect.x, rect.y, rect.w, rect.h);
    }
  }

  /** Island rect in window coordinates (origin top-left of the 720×380 window). */
  private islandRect(): { x: number; y: number; w: number; h: number } {
    const scale = this.getScale();
    const w = this.width.value * scale;
    const hh = this.height.value * scale;
    const topOffset = this.isFloatingIsland && hh > 0 ? 6 * scale : 0;
    const viewportW = window.innerWidth > 0 ? window.innerWidth : PANEL_W;
    return { x: (viewportW - w) / 2, y: topOffset, w, h: hh };
  }

  // ── Window collapse (hidden → tiny wake strip, zero polling) ────────────────

  private updateWindowCollapsed() {
    if (this.collapseTimer != null) {
      window.clearTimeout(this.collapseTimer);
      this.collapseTimer = null;
    }
    if (State.mode === "hidden") {
      // Let the island finish folding, then shrink the window to it — to the
      // closed island, or to the wake strip when that shows nothing: from
      // there nothing polls the cursor at all.
      this.collapseTimer = window.setTimeout(() => {
        this.collapseTimer = null;
        if (State.mode !== "hidden") return;
        this.collapsed = true;
        this.sendCollapsedSize(true);
      }, 420);
    } else if (this.collapsed) {
      // Grow the window back before the island animates open.
      this.collapsed = false;
      this.collapsedTo = { w: 0, h: 0 };
      void Bridge.setCollapsed(false);
    }
  }

  /**
   * Mochi in the closed island now and then blinks or glances around, as he
   * does on a Mac without a notch: a few frames every few seconds, the loop
   * asleep in between. Nothing runs for the other closed islands.
   */
  private scheduleClosedLife() {
    if (this.closedLife != null) window.clearTimeout(this.closedLife);
    this.closedLife = null;
    this.closedLook = { x: 0, y: 0 };
    if (State.mode !== "hidden" || closedIsland(State.settings.closedIsland) !== "mochi") {
      return;
    }
    this.closedLife = window.setTimeout(() => {
      this.closedLife = null;
      if (State.mode !== "hidden" || State.paused) return this.scheduleClosedLife();
      this.closedLook = { x: 0, y: 0 };
      this.engine.blink();
      this.closedAwakeUntil = performance.now() + 700;
      this.ensureRunning();
      this.scheduleClosedLife();
    }, 2400 + Math.random() * 2800);
  }

  /** The pointer is on the folded window (Rust's `closed-hover`): the island wakes. */
  wakeFromClosed() {
    if (State.mode !== "hidden") return;
    Sound.resume();
    this.fsm.mouseEntered();
  }

  /** Tells Rust the folded window's size: the closed island's, or none (the strip). */
  private sendCollapsedSize(force = false) {
    const scale = this.getScale();
    const size = this.closedShows
      ? this.isSlimShape
        ? { w: Math.round(SLIM_BAR_W * scale), h: Math.round(SLIM_BAR_H * scale) }
        : { w: Math.round(this.closedW * scale), h: Math.round(CLOSED_H * scale) }
      : { w: 0, h: 0 };
    if (!force && size.w === this.collapsedTo.w && size.h === this.collapsedTo.h) return;
    this.collapsedTo = size;
    if (size.w > 0) void Bridge.setCollapsed(true, size.w + 24, size.h + (this.isFloatingIsland ? 10 : this.isSlimShape ? 2 : 0));
    else void Bridge.setCollapsed(true);
  }

  /**
   * What the closed island shows, redrawn when it changes (the minute, the
   * song, the plan): a new width animates the island and, once folded,
   * resizes the window to it.
   */
  private updateClosed() {
    const style = closedIsland(State.settings.closedIsland);
    const track = Spotify.state.track;
    const content: ClosedContent | null = !this.isSlimShape && (State.mode === "hidden" || this.collapsed)
      ? closedContent(style, {
        now: new Date(),
        locale: language(),
        planUsage: State.planUsage,
        music: State.spotifyPlaying && track ? { title: track.title, artist: track.artist } : null,
        lyric: this.currentSyncedLyric(),
      })
      : null;
    const key = content ? `${style}|${content.text}|${content.dot ?? ""}|${content.note}` : style;
    const shown = State.mode === "hidden" && this.closedShows;
    this.closedEl.classList.toggle("on", shown && content != null);
    if (key === this.closedKey) return;
    this.closedKey = key;
    this.closedText.textContent = content?.text ?? "";
    this.closedEl.classList.toggle("note", content?.note === true);
    this.closedDot.style.display = content?.dot ? "" : "none";
    if (content?.dot) this.closedDot.style.background = content.dot;
    // Measured as drawn: the font and the language decide the width.
    const extras = (content?.dot ? 12 : 0) + (content?.note ? 16 : 0);
    const w = closedWidth(content ? this.closedText.scrollWidth : 0, extras);
    if (w !== this.closedW) {
      this.closedW = w;
      if (State.mode === "hidden") {
        this.animateGeometry(w < this.width.value);
        if (this.collapsed) this.sendCollapsedSize();
      }
    }
  }

  // ── Input ───────────────────────────────────────────────────────────────────

  private wireInput() {
    // Folded, the window is only the closed island (or the wake strip): the
    // pointer coming onto it is all there is to hear, and it wakes the island.
    const wake = () => {
      Sound.resume();
      if (State.mode === "hidden") this.fsm.mouseEntered();
    };
    this.wakeStrip.addEventListener("mouseenter", wake);
    this.root.addEventListener("mouseover", () => {
      if (this.collapsed) wake();
    });

    this.islandEl.addEventListener("mousedown", (e) => {
      Sound.resume();
      State.lastActivity = performance.now();
      // A click makes a hover-opened island an ordinary open one.
      this.fsm.userInteracted();
      // A press on Mochi may become a drag out to the desktop.
      if (e.button === 0 && this.isBotHit(e.clientX, e.clientY)) {
        this.botPress = { x: e.clientX, y: e.clientY };
      }
      // Right-click on Mochi opens the wardrobe, and closes it again.
      if (e.button === 2 && this.isBotHit(e.clientX, e.clientY)) {
        this.cancelBotHover();
        this.toggleWardrobe();
        return;
      }
      if (State.mode !== "expanded") {
        this.fsm.click();
        return;
      }
      if (this.isBotHit(e.clientX, e.clientY)) {
        this.cancelBotHover();
        this.engine.slap();
      }
    });

    // No browser menu over Mochi: his right-click is the wardrobe. Everywhere
    // else (the chat field) the webview keeps its own menu.
    this.islandEl.addEventListener("contextmenu", (e) => {
      if (this.isBotHit(e.clientX, e.clientY)) e.preventDefault();
    });

    // Dragging Mochi out of the island puts him on the desktop.
    window.addEventListener("mousemove", (e) => {
      if (this.desktop.carrying) {
        this.desktop.carry(e.clientX, e.clientY);
        return;
      }
      const press = this.botPress;
      if (!press) return;
      if (!(e.buttons & 1)) {
        this.botPress = null;
        return;
      }
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) <= DRAG_THRESHOLD) return;
      this.botPress = null;
      if (!this.canDragOut()) return;
      this.cancelBotHover();
      this.desktop.pickUp(e.clientX, e.clientY);
    });
    window.addEventListener("mouseup", (e) => {
      this.botPress = null;
      if (this.desktop.carrying) this.desktop.carryEnd(e.clientX, e.clientY);
    });

    // Only keys typed into the island itself land here, never Escape typed in
    // a terminal — so it may fold a waiting card away, as Escape in the notch
    // does on macOS.
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && State.mode === "expanded") {
        if (State.pendingApproval) this.foldApproval();
        else if (!State.isPinned) this.collapse();
      }
      State.lastActivity = performance.now();
    });

    void onDragDrop((e) => this.onDragDrop(e));
    void onEvent<string>("clipboard-text", (text) => Clipboard.capture(text));
    if (Clipboard.paused) void Bridge.clipboardSetPaused(true);

    // Outside Tauri (plain browser) drive the cursor from DOM events so the
    // island can be inspected with `npm run dev`.
    if (!IS_TAURI) this.followPageCursor();
  }

  /**
   * Takes the cursor from the page's own mouse events instead of Rust's poll.
   * Used where the OS has no global cursor position (Wayland): the events only
   * fire while the pointer is over the island, so leaving the window is
   * reported as a cursor far away, which is what the poll would have said.
   */
  followPageCursor() {
    window.addEventListener("mousemove", (e) => this.onCursor(e.clientX, e.clientY));
    window.addEventListener("mouseout", (e) => {
      if (e.relatedTarget == null) this.onCursor(-10_000, -10_000);
    });
  }

  /**
   * Pointer on/off the island as the compositor sees it (Linux only). Null
   * until the first report, so a platform that never sends it is not gated.
   */
  private pointerInside: boolean | null = null;

  setPointerInside(inside: boolean) {
    this.pointerInside = inside;
  }

  /** Cursor in window-logical coordinates. */
  onCursor(x: number, y: number) {
    // WebKitGTK can deliver a mousemove after the pointer has left the layer
    // surface; trusting it re-enters the island and the auto-close never runs.
    if (this.pointerInside === false) {
      x = -10_000;
      y = -10_000;
    }
    State.mouse = { x, y };
    const rect = this.islandRect();
    State.mouseInIsland = { x: x - rect.x, y: y - rect.y };

    // Windows sends no cursor position with an OLE drag, so the drop sequence is
    // fed from the Win32 cursor poll instead — it runs throughout the drag.
    if (UploadSeq.isActive && !UploadSeq.dropped) {
      UploadSeq.updateCursor(State.mouseInIsland.x, State.mouseInIsland.y);
      this.updateDropTarget(State.mouseInIsland.x, State.mouseInIsland.y);
    }

    const inIsland =
      x >= rect.x - HIT_MARGIN && x <= rect.x + rect.w + HIT_MARGIN &&
      y >= rect.y - HIT_MARGIN && y <= rect.y + rect.h + HIT_MARGIN;

    // Recorded before the state machine hears of it: a transition it makes
    // right away (open on hover) reads where the pointer is, and must not see
    // the pointer as still outside.
    const wasIn = this.wasInIsland;
    this.wasInIsland = inIsland;
    if (inIsland && !wasIn) {
      if (this.fsm.state === "coucou") this.greeting.hover();
      this.fsm.mouseEntered();
      if (State.mode === "compact") {
        this.engine.blink();
        this.engine.tgEs = 1.05;
        this.applyCompactLayout();
        this.animateGeometry(false);
      }
    }
    if (!inIsland && wasIn) {
      this.fsm.mouseLeft();
      if (State.mode === "compact") {
        this.engine.tgEs = 1;
        this.applyCompactLayout();
        this.animateGeometry(true);
      }
    }

    // Bot hover → love
    const overBot = State.mode === "expanded" && State.stateOverride == null && this.isBotHit(x, y);
    if (overBot && !this.botHovering) this.botHoverIn(x, y);
    if (!overBot && this.botHovering) this.cancelBotHover();
    this.botHovering = overBot;
    if (this.botHovering) {
      const d = Math.hypot(x - this.botHoverStart.x, y - this.botHoverStart.y);
      if (d > 40) {
        this.botHoverStart = { x, y };
        this.scheduleLove();
      }
    }

    this.ensureRunning();
  }

  /** The greeting and the drop sequence draw a Mochi of their own: not that one. */
  private canDragOut(): boolean {
    if (State.mode === "hidden" || !this.desktop.canPickUp()) return false;
    return !(State.mode === "expanded" && (State.view === "greeting" || this.uploadActive));
  }

  private isBotHit(x: number, y: number): boolean {
    // Out on the desktop, the island's Mochi is invisible: nothing to hit.
    if (State.mochiOnDesktop) return false;
    const scale = this.getScale();
    const rect = this.islandRect();
    const cx = rect.x + this.botCx.value * scale;
    const cy = rect.y + this.botCy.value * scale;
    const radius = (this.botSize.value * scale) / 2;
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
  }

  private botHoverIn(x: number, y: number) {
    if (performance.now() / 1000 - this.lastLoveTime < 6) return;
    this.botHoverStart = { x, y };
    this.engine.blink();
    this.engine.tgEs = 1.08;
    Sound.play("hover");
    this.scheduleLove();
  }

  private scheduleLove() {
    if (this.botHoverTimer != null) window.clearTimeout(this.botHoverTimer);
    this.botHoverTimer = window.setTimeout(() => {
      this.botHoverTimer = null;
      if (!this.botHovering || State.stateOverride != null) return;
      if (performance.now() / 1000 - this.lastLoveTime < 6) return;
      this.lastLoveTime = performance.now() / 1000;
      this.engine.triggerEmote("love");
      Sound.play("love");
    }, 1900);
  }

  private cancelBotHover() {
    if (this.botHoverTimer != null) window.clearTimeout(this.botHoverTimer);
    this.botHoverTimer = null;
    this.engine.tgEs = 1;
  }

  /** Three slaps → dizzy + confused view for 3.3 s, then back. */
  handleDizzy() {
    this.prevViewBeforeConfused = State.view;
    State.stateOverride = "dizzy";
    this.engine.setState("dizzy");
    Sound.play("dizzy");
    this.alert("confused");
    if (this.confusedRecovery != null) window.clearTimeout(this.confusedRecovery);
    this.confusedRecovery = window.setTimeout(() => {
      this.confusedRecovery = null;
      State.stateOverride = null;
      this.engine.setState(State.effectiveState);
      if (State.view === "confused") {
        const fallback = State.defaultView();
        this.setView(this.prevViewBeforeConfused === "confused" ? fallback : this.prevViewBeforeConfused);
      }
      this.engine.triggerEmote("happy");
    }, 3300);
  }

  // ── Frame loop ──────────────────────────────────────────────────────────────

  ensureRunning() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    requestAnimationFrame(this.frame);
  }

  private frame = (nowMs: number) => {
    const dt = Math.min(0.05, (nowMs - this.lastFrame) / 1000);
    this.lastFrame = nowMs;

    this.width.step(dt, nowMs);
    this.height.step(dt, nowMs);
    this.radius.step(dt, nowMs);
    this.applyGeometry();

    if (this.dirty) {
      this.dirty = false;
      this.syncDom();
    }

    this.updateBotTargets();
    this.botCx.step(dt);
    this.botCy.step(dt);
    this.botSize.step(dt);

    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    if (greetingActive) {
      const gctx = this.greetingCanvas.getContext("2d");
      if (gctx) {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        if (this.greetingCanvas.width !== Math.round(EXPANDED_W * dpr)) {
          this.greetingCanvas.width = Math.round(EXPANDED_W * dpr);
          this.greetingCanvas.height = Math.round(150 * dpr);
        }
        gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.greeting.draw(gctx);
      }
    } else {
      // Kept running even while the drop canvas is up, so the island's own Mochi
      // is already in the right place the moment the canvas fades out.
      this.drawBot(dt);
    }

    const uploadActive = this.uploadActive;
    // A file over the drop card: the sessions it could go to, on the right.
    const listing = uploadActive && State.view === "upload" && State.fileDragOver && !UploadSeq.dropped;
    this.sessionDrop.sync(listing);
    this.uploadCanvas.textRight = listing && dropTargets(State.tasks).length > 0 ? DROP_TEXT_RIGHT_WITH_LIST : this.uploadCanvas.defaultTextRight;
    if (uploadActive) this.uploadCanvas.draw(UploadSeq.frame(), nowMs / 1000);
    this.uploadCanvas.el.classList.toggle("on", uploadActive);
    this.viewsEl.classList.toggle("hidden-by-upload", uploadActive);

    tickMiniBots(dt);
    // A ticker scroll that loses its frames freezes mid-way, rows overlapping.
    const viewAnimating = this.views.get(State.view)?.tick?.(nowMs) === true;
    if (UploadSeq.isActive) this.stepSequence();
    this.updateCountdown(nowMs);

    // Nothing is drawn while the island is hidden, so nothing may keep the loop
    // alive either. This used to read `... || this.engine.busy || State.mode !==
    // "hidden"`, and engine.busy is permanently true for any state with a
    // looping animation — breathing, ratelimit sweat, sleeping z's, the search
    // sweep — so a hidden island went on burning frames in exactly the states it
    // spends most of its life in. Geometry still has to finish retracting.
    const settling =
      this.width.animating || this.height.animating || this.radius.animating;
    const botMoving = !this.botCx.settled || !this.botCy.settled || !this.botSize.settled;
    // Closed, only the folding — and Mochi reaching his place in the closed island.
    const closedMochiActive = !this.isSlimShape && closedIsland(State.settings.closedIsland) === "mochi" && !State.paused && !State.mochiOnDesktop;
    const busy = State.mode === "hidden"
      ? settling || closedMochiActive || (closedIsland(State.settings.closedIsland) === "mochi" && (botMoving || nowMs < this.closedAwakeUntil))
      : settling ||
      !this.botCx.settled || !this.botCy.settled || !this.botSize.settled ||
      greetingActive || this.engine.busy || UploadSeq.isActive || viewAnimating;

    if (busy) {
      requestAnimationFrame(this.frame);
    } else {
      this.running = false;
      Sound.idle();
    }
  };

  private updateBotTargets() {
    let p = botPosition(State.mode, State.view, this.height.value, State.uploadProgress);
    if (State.mode === "compact") {
      p = { cx: this.compactBotCx, cy: this.compactTargetH / 2, diameter: 20, opacity: 1 };
    } else if (State.mode === "expanded" && VIEW_LAYOUTS[State.view].botY === 19) {
      p = { ...p, cx: this.width.target / 2 };
    }
    // The closed island with Mochi in it, as on a Mac without a notch.
    if (State.mode === "hidden" && !this.isSlimShape && closedIsland(State.settings.closedIsland) === "mochi") {
      p = { cx: this.width.value / 2, cy: this.height.value / 2, diameter: CLOSED_BOT_D, opacity: 1 };
    }
    this.botCx.target = p.cx;
    this.botCy.target = p.cy;
    this.botSize.target = p.diameter / 0.6;

    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    // The drop canvas draws its own Mochi; two of them would overlap. Out on the
    // desktop, he isn't here at all.
    const away = State.mochiOnDesktop;
    const visible = p.opacity > 0 && !greetingActive && !this.uploadActive && !away;
    this.botCanvas.style.opacity = visible ? "1" : "0";

    this.botGlow.style.display = "none";
  }

  private drawBot(dt: number) {
    const size = this.botSize.value;
    const w = Math.max(1, Math.round(size));
    const hCss = w + BOT_OVERHANG;
    const wCss = w + BOT_SIDE * 2;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    // Drawn at the current ratio, so a bitmap sized for another monitor's
    // would show Mochi too big and cut, or too small.
    if (this.canvasPx !== w || this.canvasDpr !== dpr) {
      this.canvasPx = w;
      this.canvasDpr = dpr;
      this.botCanvas.width = Math.round(wCss * dpr);
      this.botCanvas.height = Math.round(hCss * dpr);
      this.botCanvas.style.width = `${wCss}px`;
      this.botCanvas.style.height = `${hCss}px`;
    }
    this.botCanvas.style.left = `${this.botCx.value - wCss / 2}px`;
    this.botCanvas.style.top = `${this.botCy.value - BOT_OVERHANG / 2 - hCss / 2}px`;

    const ctx = this.botCanvas.getContext("2d");
    if (!ctx) return;

    const focus = State.focusTask;
    // A new Coucou waits: over an idle or sleeping Mochi, the blue and the arrow
    // badge (whats-new.ts). Anything Mochi has to say comes first.
    this.engine.setUpdateHint(this.updateHintOn() ? UPDATE_BLUE_RGB : null);
    // While a plan card is open Mochi wears the plan's colour, like its pill.
    this.engine.bodyColor = planCardOpen()
      ? hexToRGB(openPlanColor())
      : this.engine.showsUpdateHint
        ? UPDATE_BLUE_RGB
        : focus?.isIntegration
          ? hexToRGB(focus.color)
          : null;
    this.engine.particleOverhang = BOT_OVERHANG;
    const tune = State.settings.mochiTune;
    if (tune) {
      this.engine.tune = tune;
      Sound.robotAccentEnabled = tune.robotSound !== false;
    }
    this.engine.lookX = this.lookX();
    this.engine.lookY = this.lookY();
    if (this.engine.morph > 0.3) {
      this.engine.slotHTarget = State.fileDragOver ? 0.2 : 0;
    } else {
      this.engine.slotHTarget = 0;
      if (this.engine.morph < 0.05) {
        this.engine.slotH = 0;
        this.engine.slotHVel = 0;
      }
    }
    // Only the main Mochi is dressed — the one of the main tool's pill (Settings →
    // Active pills): a focused integration pill shows its own colours, unless
    // the wardrobe is open (BotCanvasView.showOutfit, macOS).
    // In the wardrobe the hovered outfit swaps in at once, without the drop-in.
    const inWardrobe = State.mode === "expanded" && State.view === "wardrobe";
    const mainFocused = State.focusId == null || State.focusId === State.mainPillId;
    const showOutfit = mainFocused || State.mode !== "expanded" || inWardrobe;
    const outfit = State.wardrobePreview ?? this.seasons.get(parseOutfit(State.settings.mochiOutfit));
    this.engine.setOutfit(showOutfit ? outfit : "none", !inWardrobe);
    // Dances while music plays: always in the compact island, expanded only on
    // the music pill's card (BotCanvasView, macOS). Asked every frame.
    this.engine.setDancing(islandDances({
      music: State.spotifyPlaying,
      state: State.effectiveState,
      mode: State.mode,
      view: State.view,
      focusId: State.focusTask?.id,
    }));

    this.engine.update(dt);
    // Cleared in device pixels, the whole canvas. At a fractional scale (150 %)
    // the canvas is a whole number of pixels but `hCss * dpr` is not: clearing
    // in CSS units left the last row half-cleared, and whatever once passed
    // through it (a hat in a roll) piled up there into a coloured bar.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.botCanvas.width, this.botCanvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, BOT_SIDE * dpr, 0);
    ctx.save();
    this.engine.applyDance(ctx, w, hCss);
    this.engine.draw(ctx, w, hCss);
    ctx.restore();
  }

  /** BotCanvasView.lookX / lookY — tanh of the distance to the bot. */
  private lookX(): number {
    // In the closed island the cursor isn't followed: he looks around by himself.
    if (State.mode === "hidden") return this.closedLook.x;
    const rect = this.islandRect();
    const botScreenX = rect.x + this.botCx.value;
    return Math.tanh((State.mouse.x - botScreenX) / 260);
  }

  private lookY(): number {
    if (State.mode === "hidden") return this.closedLook.y;
    return -Math.tanh((State.mouse.y - this.botCy.value) / 200);
  }

  private updateCountdown(nowMs: number) {
    // The state machine's own deadline, so the bar follows an auto-close delay
    // edited while the countdown runs.
    const dueAt = this.fsm.homeCollapseDueAt;
    if (State.mode !== "expanded" || State.isPinned || dueAt == null) {
      this.countdown.style.width = "0px";
      return;
    }
    const autoClose = this.fsm.homeToPetitDelay;
    const windowS = Math.min(10, autoClose * 0.6);
    const remaining = (dueAt - nowMs) / 1000;
    this.countdown.style.width =
      remaining < windowS ? `${Math.max(0, clamp(remaining / windowS, 0, 1) * 160)}px` : "0px";
  }

  // ── DOM sync ────────────────────────────────────────────────────────────────

  private syncDom() {
    this.islandEl.dataset.style = State.settings.islandStyle || "glass";
    this.islandEl.dataset.shape = State.settings.islandShape || "notch";
    const tintPct = Math.max(10, Math.min(100, Number(State.settings.glassTint ?? 50)));
    const tintAlpha = 0.45 + (tintPct / 100) * 0.5;
    this.islandEl.style.setProperty("--glass-tint", tintAlpha.toFixed(3));
    this.islandEl.style.setProperty("--glass-tint-bot", Math.min(0.98, tintAlpha + 0.04).toFixed(3));
    this.islandEl.dataset.bar = State.mode === "hidden" && this.isSlimShape ? "on" : "off";
    this.fsm.petitToHiddenDelay = this.isSlimShape ? 1.5 : 60;
    const expanded = State.mode === "expanded";
    const greetingActive = expanded && State.view === "greeting";

    const live = expanded && !greetingActive;
    const showDock = live && !this.uploadActive && !DOCK_HIDDEN_VIEWS.has(State.view);
    const musicHeroOn = live && State.view === "music" && !this.uploadActive && Spotify.state.track != null;
    this.islandEl.dataset.music = musicHeroOn ? "on" : "off";
    this.musicBackdrop.classList.toggle("on", musicHeroOn);
    if (musicHeroOn) {
      const cover = currentArtwork(Spotify.state);
      if (cover) {
        if (this.musicBackdropImg.getAttribute("src") !== cover) {
          this.musicBackdropImg.setAttribute("src", cover);
          if (this.musicBackdropImg.complete) this.applyMusicPalette();
        }
        this.musicBackdrop.classList.add("has-art");
      } else {
        this.musicBackdrop.classList.remove("has-art");
        this.musicBackdropImg.removeAttribute("src");
        this.clearMusicPalette();
      }
    }

    const snap = Weather.snapshot;
    const hNow = new Date().getHours();
    const isDayFallback = hNow >= 6 && hNow < 18;
    const dayPhase = snap
      ? resolveDayPhase(snap.isDay, snap.daily[0]?.sunrise, snap.daily[0]?.sunset)
      : resolveDayPhase(isDayFallback);

    if (live && !this.uploadActive) {
      this.islandEl.dataset.phase = dayPhase;
    } else {
      delete this.islandEl.dataset.phase;
    }

    const weatherHeroOn = live && State.view === "weather" && !this.uploadActive;
    this.islandEl.dataset.weather = weatherHeroOn ? "on" : "off";
    this.weatherBackdrop.classList.toggle("on", weatherHeroOn);
    if (weatherHeroOn) {
      if (snap) {
        const cond = wmoCondition(snap.weatherCode, snap.isDay);
        this.weatherBackdrop.dataset.mood = cond.kind === "clear" ? (snap.isDay ? "clear-day" : "clear-night") : cond.kind;
      } else {
        this.weatherBackdrop.dataset.mood = isDayFallback ? "clear-day" : "clear-night";
      }
      this.weatherBackdrop.dataset.phase = dayPhase;
    }
    this.islandEl.classList.toggle("has-dock", showDock);
    this.contentEl.style.opacity = live ? "1" : "0";
    // While the drop sequence owns the body its buttons are painted on the canvas
    // underneath, so only the header may keep taking clicks up here.
    this.contentEl.style.pointerEvents = live && !this.uploadActive ? "auto" : "none";
    this.header.el.style.pointerEvents = live ? "auto" : "none";
    if (this.header.dockEl) {
      this.header.dockEl.style.display = showDock ? "" : "none";
      this.header.dockEl.style.pointerEvents = showDock ? "auto" : "none";
    }
    this.greetingCanvas.style.display = greetingActive ? "block" : "none";

    // Leaving the greeting, however it ends, lets its sound fade out.
    if (this.greetingShown && !greetingActive) this.greeting.leave();
    this.greetingShown = greetingActive;
    // A wardrobe try-on never outlives the wardrobe.
    if (State.wardrobePreview && !(expanded && State.view === "wardrobe")) State.wardrobePreview = null;

    this.header.sync();
    for (const [name, view] of this.views) {
      const on = name === State.view;
      view.el.classList.toggle("on", on);
      if (on) view.sync();
    }

    // The chat and the launch card are the views with a text field, so they
    // are the only time the island is allowed to take keyboard focus.
    if (this.lastSyncedView !== State.view) {
      const wasChat = this.lastSyncedView != null && TYPING_VIEWS.has(this.lastSyncedView);
      this.lastSyncedView = State.view;
      if (TYPING_VIEWS.has(State.view)) {
        const view = State.view;
        void Bridge.focusWindow(true);
        window.setTimeout(() => this.views.get(view)?.focus?.(), 120);
      } else if (wasChat) {
        void Bridge.focusWindow(false);
      }
    }

    // Compact mini grid: hidden per user request
    this.miniGrid.style.opacity = "0";
    this.miniGrid.style.display = "none";
    this.miniGrid.style.pointerEvents = "none";

    // Compact Claude plan indicator
    const showPlan = claudeCompactPillVisible();
    this.compactPlan.style.opacity = showPlan ? "1" : "0";
    this.compactPlan.style.pointerEvents = showPlan ? "auto" : "none";
    if (showPlan) {
      const pct = dominantPct(State.planUsage);
      const color = planColor(pct);
      this.compactPlan.style.setProperty("--plan", color);
      const clamped = pct != null ? Math.max(0, Math.min(100, pct)) : 0;
      const offset = PLAN_RING_CIRCUMFERENCE * (1 - clamped / 100);
      this.compactPlanArc.setAttribute("stroke-dashoffset", offset.toFixed(2));
      this.compactPlanLabel.textContent = pct != null ? `${Math.round(pct)}%` : "—";
    }

    // Compact Airadoro live focus countdown pill
    const airaSnap = Airadoro.snapshot;
    const showAiradoro = State.mode === "compact" && airaSnap.phase !== "idle";
    this.compactAiradoro.style.opacity = showAiradoro ? "1" : "0";
    this.compactAiradoro.style.pointerEvents = showAiradoro ? "auto" : "none";
    this.compactAiradoro.classList.toggle("rest", airaSnap.phase === "rest");
    this.compactAiradoro.classList.toggle("paused", airaSnap.paused);
    if (showAiradoro) {
      const rem = Airadoro.remaining() ?? 0;
      this.compactAiradoroLabel.textContent = AiradoroEngine.clock(rem);
      this.compactAiradoro.title = Airadoro.taskTitle ? `🎯 ${Airadoro.taskTitle}` : "Airadoro";
    }
    const tickCompactAiradoro = showAiradoro && !airaSnap.paused;
    if (tickCompactAiradoro && this.compactAiradoroTimer == null) {
      this.compactAiradoroTimer = window.setInterval(() => {
        if (State.mode !== "compact" || Airadoro.snapshot.phase === "idle" || Airadoro.snapshot.paused) {
          if (this.compactAiradoroTimer != null) window.clearInterval(this.compactAiradoroTimer);
          this.compactAiradoroTimer = null;
          return;
        }
        const rem = Airadoro.remaining() ?? 0;
        this.compactAiradoroLabel.textContent = AiradoroEngine.clock(rem);
      }, 1000);
    } else if (!tickCompactAiradoro && this.compactAiradoroTimer != null) {
      window.clearInterval(this.compactAiradoroTimer);
      this.compactAiradoroTimer = null;
    }

    // Compact agenda pending tasks indicator
    const todayPending = tasksForDay(loadAgendaTasks(), dayKey(new Date())).filter((t) => !t.completed);
    const pendingToday = todayPending.length;
    const showAgenda = State.mode === "compact" && pendingToday > 0;
    this.compactAgenda.style.opacity = showAgenda ? "1" : "0";
    this.compactAgenda.style.pointerEvents = showAgenda ? "auto" : "none";
    if (showAgenda) {
      const next = todayPending[0];
      const labelText = next?.title
        ? next.time
          ? `${next.time} · ${next.title}`
          : next.title
        : `${tl("Calendar")} (${pendingToday})`;
      this.compactAgendaLabel.textContent = labelText;
      if (pendingToday > 1) {
        this.compactAgendaCount.textContent = `+${pendingToday - 1}`;
        this.compactAgendaCount.style.display = "inline-flex";
      } else {
        this.compactAgendaCount.textContent = "";
        this.compactAgendaCount.style.display = "none";
      }
      this.compactAgenda.title = `${tl("Calendar")} (${pendingToday}): ${labelText}`;
    }

    // Compact live weather pill: hidden per user request
    this.compactWeather.style.opacity = "0";
    this.compactWeather.style.display = "none";
    this.compactWeather.style.pointerEvents = "none";
    this.compactWeather.classList.remove("rain-alert", "has-aqi-dot");

    this.syncCompactLyric();
    this.updateClock();
    this.applyCompactLayout();

    const nextSize = this.targetSize();
    if (
      Math.abs(nextSize.w - this.width.target) > 0.5 ||
      Math.abs(nextSize.h - this.height.target) > 0.5 ||
      Math.abs(nextSize.r - this.radius.target) > 0.5
    ) {
      this.animateGeometry(nextSize.w < this.width.target || nextSize.h < this.height.target);
    }

    syncMiniBotStates(State.tasks);
    this.engine.setState(State.effectiveState);
  }

  private syncCompactLyric() {
    const label = State.mode === "compact" ? this.currentCompactMusicLabel() : null;
    const on = Boolean(label);
    this.compactLyric.style.opacity = on ? "1" : "0";
    this.compactLyric.style.pointerEvents = on ? "auto" : "none";
    if (on && label && this.compactLyricText.textContent !== label) {
      this.compactLyricText.textContent = label;
    }

    const needTick =
      State.spotifyPlaying &&
      Boolean(SpotifyLyrics.current?.synced) &&
      (State.mode === "compact" ||
        (State.mode === "hidden" && closedIsland(State.settings.closedIsland) === "music"));

    if (needTick && this.compactLyricTimer == null) {
      this.compactLyricTimer = window.setInterval(() => {
        if (!State.spotifyPlaying || !SpotifyLyrics.current?.synced) {
          if (this.compactLyricTimer != null) window.clearInterval(this.compactLyricTimer);
          this.compactLyricTimer = null;
          this.syncCompactLyric();
          this.applyCompactLayout();
          this.updateClosed();
          return;
        }
        if (State.mode === "compact") {
          const prev = this.compactLyricText.textContent || "";
          const cur = this.currentCompactMusicLabel() || "";
          if (prev !== cur) {
            this.syncCompactLyric();
            this.applyCompactLayout();
            const sz = this.targetSize();
            if (Math.abs(sz.w - this.width.target) > 0.5) {
              this.animateGeometry(sz.w < this.width.target);
            }
          }
        } else if (State.mode === "hidden") {
          this.updateClosed();
        }
      }, 250);
    } else if (!needTick && this.compactLyricTimer != null) {
      window.clearInterval(this.compactLyricTimer);
      this.compactLyricTimer = null;
    }
  }

  /** The clock sits in the middle of the compact island, where the notch is on a Mac. */
  private updateClock() {
    this.updateClosed();
    const lyricShowing = State.mode === "compact" && Boolean(this.currentSyncedLyric());
    const on = State.mode === "compact" && State.settings.showClock && !lyricShowing;
    this.clockEl.style.opacity = on ? "1" : "0";
    if (!on) return;
    const now = new Date();
    const date = now.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
    const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const text = `${date}  ${time}`;
    if (this.clockEl.textContent !== text) this.clockEl.textContent = text;
  }

  /** Applies settings coming from Rust at boot. */
  applySettings() {
    this.islandEl.dataset.style = State.settings.islandStyle || "glass";
    this.islandEl.dataset.shape = State.settings.islandShape || "notch";
    const tintPct = Math.max(10, Math.min(100, Number(State.settings.glassTint ?? 50)));
    const tintAlpha = 0.45 + (tintPct / 100) * 0.5;
    this.islandEl.style.setProperty("--glass-tint", tintAlpha.toFixed(3));
    this.islandEl.style.setProperty("--glass-tint-bot", Math.min(0.98, tintAlpha + 0.04).toFixed(3));
    this.islandEl.dataset.bar = State.mode === "hidden" && this.isSlimShape ? "on" : "off";
    this.fsm.petitToHiddenDelay = this.isSlimShape ? 1.5 : 60;
    // The closed island may have changed: what it shows, or whether it shows.
    this.closedKey = "";
    this.updateClosed();
    this.applyGeometry();
    if (this.isSlimShape && State.mode === "compact" && !this.wasInIsland) {
      this.fsm.forceHidden();
    } else if (State.mode === "hidden") {
      this.animateGeometry(true);
      if (this.collapsed) this.sendCollapsedSize();
    }
    this.scheduleClosedLife();
    Sound.setEnabled(State.settings.soundEnabled);
    Sound.setVolume(State.settings.soundVolume);
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    this.fsm.openOnHover = State.settings.openOnHover;
    State.notify();
    // ponytail: one timer for the life of the window; a minute is the clock's finest tick.
    this.clockTimer ??= window.setInterval(() => {
      this.updateClock();
      if (State.mode === "expanded") {
        this.header.sync();
        if (State.view === "overview" || State.view === "empty") this.views.get(State.view)?.sync();
      }
      this.checkAgendaReminders();
    }, 10_000);
    this.checkAgendaReminders();
  }

  /** Surfaces a pop-up reminder card when a scheduled agenda task's time arrives. */
  private checkAgendaReminders() {
    if (
      State.paused ||
      State.pendingApproval != null ||
      State.view === "greeting" ||
      State.view === "uploading" ||
      State.view === "reminder"
    ) {
      return;
    }
    const tasks = loadAgendaTasks();
    const due = dueAgendaReminders(tasks, new Date());
    if (due.length === 0) return;
    const task = due[0];
    const slotKey = task.time ? `${task.date} ${task.time}` : `${task.date} snooze`;
    markReminderNotified(tasks, task.id, slotKey);
    State.activeReminder = { id: task.id, date: task.date, title: task.title, time: task.time };
    Sound.play("finish");
    this.engine.triggerEmote("surprised");
    this.alert("reminder");
  }

  /** Samples the loaded album cover into a 16x16 canvas and updates CSS gradient vars. */
  private applyMusicPalette() {
    const img = this.musicBackdropImg;
    if (!img.complete || img.naturalWidth === 0 || img.naturalHeight === 0) return;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 16;
      canvas.height = 16;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, 16, 16);
      const palette = extractArtworkPalette(ctx.getImageData(0, 0, 16, 16).data);
      if (!palette) {
        this.clearMusicPalette();
        return;
      }
      const [r1, g1, b1] = palette.primary;
      const [r2, g2, b2] = palette.secondary;
      this.islandEl.style.setProperty("--music-grad-1", `rgba(${r1}, ${g1}, ${b1}, 0.56)`);
      this.islandEl.style.setProperty("--music-grad-2", `rgba(${r2}, ${g2}, ${b2}, 0.42)`);
      this.islandEl.style.setProperty(
        "--music-ear",
        `rgba(${Math.round(r1 * 0.34 + 12)}, ${Math.round(g1 * 0.34 + 13)}, ${Math.round(b1 * 0.34 + 16)}, 0.96)`,
      );
    } catch {
      this.clearMusicPalette();
    }
  }

  private clearMusicPalette() {
    this.islandEl.style.removeProperty("--music-grad-1");
    this.islandEl.style.removeProperty("--music-grad-2");
    this.islandEl.style.removeProperty("--music-ear");
  }

  get panelSize() {
    return { w: PANEL_W, h: PANEL_H };
  }

  get chatHeight() {
    const base = chatPromptHeight(State.chatHistory.length);
    return State.chatOverlay !== "none" ? Math.max(base, CHAT_OVERLAY_H) : base;
  }
}
