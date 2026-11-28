// Island views — DOM ports of IslandViewContent.swift. Paddings, font sizes,
// colours and wording are copied from the Swift views so both platforms read
// identically.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { Ticker } from "./ticker";
import { State, type AgentTask } from "../core/state";
import { washRGBA, type BotEmoteName, type IslandViewName, type Wash } from "../core/layout";
import { loadAgendaTasks, pendingCountForDate } from "../core/agenda";
import { dayKey } from "../core/calendar";
import { buildPrompt } from "./chat";
import { buildChoose, buildUpload, buildUploading } from "./upload";
import { renderIntegrationCard, type IntegrationCardHooks } from "./integrations";
import { highlightRow, listRows, openRow } from "./github";
import { pillDefinition, sessionSubtitle } from "../core/pills";
import {
  PlanCard, buildPlanPill, claudePillVisible, closePlanCard, codexPillVisible, planCardOpen, refreshCodexPlanUsage,
} from "./usage";
import { buildDiffCard } from "./diff";
import { lastTextStep } from "../core/diff";
import { Bridge } from "../core/bridge";
import { buildRecap } from "./recap";
import { buildWardrobe } from "./wardrobe";
import { buildUpdate } from "./update";
import { buildWhatsNew } from "./whatsnew";
import { buildLaunch } from "./launch";
import { buildAgendaView, buildReminderView } from "./agenda";
import { buildCameraView } from "./camera";
import { buildClipboardView } from "./clipboard";
import { buildConvertView } from "./convert";
import { buildWeatherView } from "./weather";
import { buildSpotifyCard, buildMusicView, togglePlay } from "./spotify";
import { SPOTIFY_ID, Spotify, currentArtwork, spotifyPosition } from "../core/spotify";
import { SpotifyLyrics, activeLyricLine } from "../core/lyrics";
import { buildWhatsAppCard } from "./whatsapp";
import { WHATSAPP_ID } from "../core/whatsapp";
import { MAIL_ID, type MailCardData } from "../core/mail";
import { buildMailCard } from "./mail";
import { buildAiradoroView } from "./airadoro";
import { AIRADORO_ID, AiradoroEngine } from "../core/airadoro";
import { Airadoro } from "../island/airadoro";
import { Weather, formatTemp } from "../core/weather";
import type { Outfit, OutfitSelection } from "../mochi/wardrobe";
import { language, t, tl, type Msg } from "../i18n/i18n";
import type { ViewCommand } from "../island/shortcuts";

export interface ViewActions {
  setView(v: IslandViewName): void;
  /** "Cancel" on a dropped file: forgets it and goes back home. */
  cancelDrop(): void;
  collapse(): void;
  /** Folds a waiting card to the compact island without answering it. */
  foldApproval(): void;
  setFocus(id: string): void;
  openTerminal(): void;
  /** The ↗ button: opens whatever the focused pill points at. */
  openTarget(): void;
  openUrl(url: string): void;
  decide(d: "allow" | "deny"): void;
  /** Answers the question Claude Code asked: question text → chosen label. */
  answer(answers: Record<string, string | string[]>): void;
  /** Hands the pending request back to the terminal. */
  answerInTerminal(): void;
  toggleSound(): void;
  setVolume(v: number): void;
  setAutoClose(seconds: number): void;
  openSettingsWindow(page?: string): void;
  blip(): void;
  /** Wardrobe click: keeps the outfit ("auto" and "none" included). */
  chooseOutfit(selection: OutfitSelection): void;
  /** Wardrobe hover: shows an outfit on Mochi without keeping it; null ends it. */
  previewOutfit(outfit: Outfit | null): void;
  /** The island takes the keyboard (a text field in a card) or gives it back. */
  keyboard(on: boolean): void;
  /** Something is being typed in a card: the island stays open until it is sent or cleared. */
  holdOpen(on: boolean): void;
  /** A Claude Code session was started from the launch card: Mochi is pleased, the island folds. */
  launched(): void;
  /** Triggers a Mochi emote animation on the island. */
  emote?(name: BotEmoteName): void;
  /** Starts an Airadoro focus timer for the given agenda task. */
  focusTask?(title: string, taskId?: string): void;
  /** Opens the AI chat view with clipboard text attached as context. */
  sendToChat?(text: string): void;
  /** Opens a native file picker for local file conversion. */
  pickConvertFile?(): void;
}

export interface ViewHost {
  el: HTMLElement;
  sync(): void;
  /** Called when the view becomes active, for views with a text field. */
  focus?(): void;
  /** Called every frame while the view is on screen. True = needs another frame. */
  tick?(nowMs: number): boolean | void;
  /** Ctrl+O / Ctrl+E while the view is on screen (island/shortcuts.ts). */
  command?(command: ViewCommand): void;
}

// ── Shared pieces ─────────────────────────────────────────────────────────────

function card(wash: Wash, ...children: (Node | string)[]): HTMLElement {
  const el = h("div", { class: wash ? "card wash" : "card" }, ...children);
  if (wash) el.style.setProperty("--wash", washRGBA(wash));
  return el;
}

function btn(
  label: string | Msg,
  kind: "primary" | "secondary",
  onClick: () => void,
  kbd?: string,
): HTMLElement {
  return h(
    "button",
    { class: `btn ${kind}`, onclick: onClick },
    h("span", { text: label }),
    kbd ? h("span", { class: "kbd", text: kbd }) : null,
  );
}

/** AgentWho — coloured dot + task name + grey label. */
function agentWho(task: AgentTask | null, label: string): HTMLElement {
  const row = h("div", { class: "who-row" });
  if (task) {
    row.append(dot(task.color, 8), h("span", { class: "n", text: task.name }));
  }
  row.append(h("span", { text: label }));
  return row;
}

function stack(padLeft: number, padRight: number, ...children: Node[]): HTMLElement {
  const el = h("div", { class: "stack" }, ...children);
  el.style.padding = `4px ${padRight}px 4px ${padLeft}px`;
  return el;
}

// ── Header (Top Status Bar) + Bottom Dock ────────────────────────────────────

export interface ViewHeader extends ViewHost {
  dockEl: HTMLElement;
}

export function buildHeader(actions: ViewActions): ViewHeader {
  function go(v: IslandViewName) {
    actions.blip();
    if (v === "overview") {
      window.dispatchEvent(new CustomEvent("aira:dash-home"));
    }
    actions.setView(v);
  }

  // ── Top status strip (Left: date + temp, Center: Mochi eyes, Right: time + plan)
  const topDate = h("span", { class: "top-date" });
  const topTemp = h("span", { class: "top-temp" });
  const topLeftBtn = h(
    "button",
    {
      class: "top-meta-btn",
      title: tl("Weather"),
      onclick: () => {
        if (State.settings.compactWeather !== false) go("weather");
      },
    },
    topDate,
    topTemp,
  );
  const topCenterSpacer = h("div", { class: "top-mochi-slot" });
  const topClock = h("span", { class: "top-clock" });
  const topAgentDot = h("span", { class: "top-agent-dot" });

  // Plan usage pills (off by default): Claude first, as on the Mac.
  const claudePill = buildPlanPill(false);
  const codexPill = buildPlanPill(true);
  const planPills = h("div", { class: "plan-pills" }, claudePill.el, codexPill.el);
  let codexShown = false;

  const headerActions = h("div", { class: "header-actions" }, planPills, topAgentDot, topClock);
  const el = h("div", { id: "header" }, topLeftBtn, topCenterSpacer, headerActions);

  // ── Bottom frosted dock bar ─────────────────────────────────────────────────
  function dockTab(
    icon: string,
    label: Msg,
    onClick: () => void,
    extraClass = "",
  ): HTMLElement {
    return h(
      "button",
      {
        type: "button",
        class: extraClass ? `dock-tab ${extraClass}` : "dock-tab",
        title: label,
        onclick: onClick,
      },
      h("span", { class: "dock-ico" }, svg(icon, 15, { stroke: 1.8 })),
      h("span", { class: "dock-lbl", text: label }),
    );
  }

  const dockPlus = h(
    "button",
    {
      type: "button",
      class: "dock-icon-btn dock-plus",
      title: tl("Drop"),
      onclick: () => go("upload"),
    },
    svg(ICONS.plus, 14, { stroke: 2 }),
  );
  const dockChat = dockTab(ICONS.bubbleRound, tl("Ask"), () => go("prompt"));
  const dockHome = dockTab(ICONS.house, tl("Home"), () => go("overview"));
  const dockMusic = dockTab(ICONS.musicNote, tl("Music"), () => go("music"));
  const dockWeather = dockTab(ICONS.cloudSun, tl("Weather"), () => go("weather"));
  const dockLaunch = dockTab(ICONS.terminal, tl("Agents"), () => go("launch"));
  const dockClips = dockTab(ICONS.clipboard, tl("Clips"), () => go("clipboard"));
  const dockNotes = dockTab(ICONS.calendar, tl("Notes"), () => go("agenda"), "tab-agenda");
  dockNotes.append(h("i", { class: "tab-dot" }));
  const dockMail = dockTab(ICONS.envelope, tl("Mail"), () => go("mail"));
  const dockConvert = dockTab(ICONS.convert, tl("Convert"), () => go("convert"));
  const dockCamera = dockTab(ICONS.camera, tl("Camera"), () => go("camera"));

  const gearBtn = h(
    "button",
    {
      type: "button",
      class: "dock-icon-btn",
      title: tl("Settings"),
      onclick: () => {
        actions.blip();
        actions.openSettingsWindow();
      },
    },
    svg(ICONS.gearLine, 16, { stroke: 1.7 }),
  );
  const soundBtn = h(
    "button",
    { type: "button", class: "dock-icon-btn", title: tl("Mute"), onclick: () => actions.toggleSound() },
    svg(ICONS.speakerLine, 16, { stroke: 1.7 }),
  );
  const closeBtn = h(
    "button",
    { type: "button", class: "dock-icon-btn close", title: tl("Close"), onclick: () => actions.collapse() },
    svg(ICONS.xmark, 14),
  );

  const dockEl = h(
    "div",
    { id: "dock" },
    h("div", { class: "dock-tabs" }, dockPlus, dockHome, dockChat, dockMusic, dockWeather, dockLaunch, dockClips, dockNotes, dockMail, dockConvert, dockCamera),
    h("div", { class: "dock-actions" }, soundBtn, gearBtn, closeBtn),
  );

  return {
    el,
    dockEl,
    sync() {
      const v = State.view;
      dockEl.dataset.pageIcons = State.settings.pageIcons === false ? "off" : "on";
      const now = new Date();
      const dateStr = now.toLocaleDateString(language(), {
        weekday: "short",
        day: "2-digit",
        month: "short",
      }).toUpperCase();
      if (topDate.textContent !== dateStr) topDate.textContent = dateStr;

      const snap = Weather.snapshot;
      const weatherOn = State.settings.compactWeather !== false;
      const tempStr = weatherOn && snap ? formatTemp(snap.tempC, Weather.unit) : "";
      if (topTemp.textContent !== tempStr) topTemp.textContent = tempStr;
      topTemp.style.display = tempStr ? "" : "none";
      topLeftBtn.style.cursor = weatherOn ? "" : "default";

      const timeStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      if (topClock.textContent !== timeStr) topClock.textContent = timeStr;

      const workingAgent = State.tasks.find((t) => t.source === "agent" && t.state !== "idle");
      topAgentDot.style.display = workingAgent ? "" : "none";
      if (workingAgent) topAgentDot.style.background = workingAgent.color;

      const musicOn = State.settings.compactMusic !== false;
      const agendaOn = State.settings.compactAgenda !== false;
      const weatherDockOn = State.settings.compactWeather !== false;
      const uploadOn = State.settings.featureUpload !== false;
      const chatOn = State.settings.featureChat !== false;
      const agentsOn = State.settings.featureAgents !== false;
      const clipsOn = State.settings.featureClipboard !== false;
      const mailOn = State.settings.featureMail !== false;
      const convertOn = State.settings.featureConvert !== false;
      const cameraOn = State.settings.featureCamera !== false;
      dockPlus.style.display = uploadOn ? "" : "none";
      dockChat.style.display = chatOn ? "" : "none";
      dockMusic.style.display = musicOn ? "" : "none";
      dockWeather.style.display = weatherDockOn ? "" : "none";
      dockLaunch.style.display = agentsOn ? "" : "none";
      dockClips.style.display = clipsOn ? "" : "none";
      dockNotes.style.display = agendaOn ? "" : "none";
      dockMail.style.display = mailOn ? "" : "none";
      dockConvert.style.display = convertOn ? "" : "none";
      dockCamera.style.display = cameraOn ? "" : "none";

      dockPlus.classList.toggle("on", v === "upload");
      dockHome.classList.toggle("on", v === "overview" || v === "empty");
      dockChat.classList.toggle("on", v === "prompt");
      dockMusic.classList.toggle("on", v === "music");
      dockWeather.classList.toggle("on", v === "weather");
      dockLaunch.classList.toggle("on", v === "launch");
      dockClips.classList.toggle("on", v === "clipboard");
      dockNotes.classList.toggle("on", v === "agenda");
      dockMail.classList.toggle("on", v === "mail");
      dockConvert.classList.toggle("on", v === "convert");
      dockCamera.classList.toggle("on", v === "camera");

      const todayPending = agendaOn ? pendingCountForDate(loadAgendaTasks(), dayKey(now)) : 0;
      dockNotes.classList.toggle("has-pending", todayPending > 0);
      gearBtn.classList.toggle("on", v === "settings");
      clear(gearBtn);
      gearBtn.append(v === "settings" ? svg(ICONS.gearFill, 16) : svg(ICONS.gearLine, 16, { stroke: 1.7 }));
      clear(soundBtn);
      soundBtn.append(svg(State.settings.soundEnabled ? ICONS.speakerLine : ICONS.speakerSlashLine, 16, { stroke: 1.7 }));
      closeBtn.style.display = State.pendingApproval ? "none" : "";
      syncPlanPills();
      el.style.opacity = v === "confused" ? "0" : "1";
    },
  };

  function syncPlanPills() {
    const planEnabled = State.settings.compactPlan !== false;
    const claudeOn = planEnabled && claudePillVisible();
    const codexOn = planEnabled && codexPillVisible();
    claudePill.el.style.display = claudeOn ? "" : "none";
    codexPill.el.style.display = codexOn ? "" : "none";
    planPills.classList.toggle("on", claudeOn || codexOn);
    headerActions.classList.toggle("both-plans", claudeOn && codexOn);
    if (claudeOn) claudePill.sync();
    if (codexOn) codexPill.sync();
    const shown = codexOn && State.mode === "expanded";
    if (shown && !codexShown) refreshCodexPlanUsage();
    codexShown = shown;
  }
}

// ── Shared Home Dashboard (Hero Clock + 3 Frosted Cards) ─────────────────────

interface DashHost {
  el: HTMLElement;
  sync(tasks: readonly AgentTask[]): void;
}

function buildHomeDashboard(
  actions: ViewActions,
  openTaskDetail: (taskId: string) => void,
): DashHost {
  const clockEl = h("div", { class: "dash-clock" });
  const dateSubEl = h("div", { class: "dash-date-sub" });
  const agentsRow = h("div", { class: "dash-agents" });

  // Card 1: Jobs today (Tasks + Active Agents indicator)
  const jobsCount = h("div", { class: "dash-jobs-num", text: "0" });
  const jobsBadge = h("span", { class: "dash-jobs-badge" });
  const jobsCard = h(
    "button",
    {
      type: "button",
      class: "dash-card dash-jobs",
      onclick: () => {
        actions.blip();
        actions.setView("agenda");
      },
    },
    h("div", { class: "dash-jobs-top" }, jobsCount, jobsBadge),
    h("div", { class: "dash-card-sub", text: tl("Jobs today") }),
  );

  // Card 2: Media / Spotify
  const mediaArt = h("img", { class: "dash-media-art", alt: "" }) as HTMLImageElement;
  const mediaFallback = h("div", { class: "dash-media-art empty" }, svg(ICONS.musicNote, 15));
  const mediaTitle = h("div", { class: "dash-media-title" });
  const mediaSub = h("div", { class: "dash-media-sub" });
  const mediaPlayBtn = h(
    "button",
    {
      type: "button",
      class: "dash-round-btn media",
      onclick: (e: Event) => {
        e.stopPropagation();
        actions.blip();
        togglePlay();
      },
    },
    svg(ICONS.play, 12),
  );
  const mediaCard = h(
    "div",
    {
      class: "dash-card dash-media",
      onclick: () => {
        actions.blip();
        actions.setView("music");
      },
    },
    h("div", { class: "dash-media-left" }, mediaArt, mediaFallback, h("div", { class: "dash-media-meta" }, mediaTitle, mediaSub)),
    mediaPlayBtn,
  );

  // Card 3: Focus / Airadoro
  const focusClock = h("div", { class: "dash-focus-time", text: "25:00" });
  const focusSub = h("div", { class: "dash-focus-sub" });
  const focusPlayBtn = h(
    "button",
    {
      type: "button",
      class: "dash-round-btn focus",
      onclick: (e: Event) => {
        e.stopPropagation();
        actions.blip();
        const snap = Airadoro.snapshot;
        if (snap.phase === "idle") Airadoro.startForTask("");
        else if (snap.paused) Airadoro.resume();
        else Airadoro.pause();
      },
    },
    svg(ICONS.play, 12),
  );
  const focusCard = h(
    "div",
    {
      class: "dash-card dash-focus",
      onclick: () => {
        actions.blip();
        actions.setView("airadoro");
      },
    },
    h("div", { class: "dash-focus-meta" }, focusClock, focusSub),
    focusPlayBtn,
  );

  const cardsRow = h("div", { class: "dash-grid" }, jobsCard, mediaCard, focusCard);
  const el = h("div", { class: "dash-wrap" }, clockEl, dateSubEl, agentsRow, cardsRow);
  let lastAgentKey = "";

  return {
    el,
    sync(tasks: readonly AgentTask[]) {
      const now = new Date();
      const hh = String(now.getHours());
      const mm = String(now.getMinutes()).padStart(2, "0");
      const heroTime = `${hh}:${mm}`;
      if (clockEl.textContent !== heroTime) clockEl.textContent = heroTime;

      const pendingToday = pendingCountForDate(loadAgendaTasks(), dayKey(now));
      jobsCount.textContent = String(pendingToday);

      const runningAgents = tasks.filter((t) => !t.isIntegration && t.state !== "idle");
      jobsBadge.style.display = runningAgents.length > 0 ? "" : "none";
      if (runningAgents.length > 0) jobsBadge.textContent = `${runningAgents.length}`;

      const pillTasks = tasks
        .filter((t) => {
          if (t.id === SPOTIFY_ID || t.id === AIRADORO_ID) return false;
          const configured = State.integrations[t.id]?.configured;
          if (t.state === "idle" && t.pillBadge == null && configured === false) return false;
          return t.state !== "idle" || t.steps.length > 0 || t.pillBadge != null;
        })
        .sort((a, b) => Number(b.state !== "idle") - Number(a.state !== "idle"));
      const aKey = pillTasks.map((t) => `${t.id}:${t.state}:${t.color}:${t.pillBadge ?? ""}`).join("|");
      if (aKey !== lastAgentKey) {
        lastAgentKey = aKey;
        clear(agentsRow);
        for (const t of pillTasks) {
          const btnEl = h(
            "button",
            {
              type: "button",
              class: t.state !== "idle" ? "dash-agent-chip active" : "dash-agent-chip",
              onclick: () => {
                actions.blip();
                openTaskDetail(t.id);
              },
            },
            dot(t.color, 6),
            h("span", { text: t.name }),
          );
          agentsRow.append(btnEl);
        }
        agentsRow.style.display = pillTasks.length > 0 ? "" : "none";
      }

      // Sync Spotify card
      const sp = Spotify.state;
      const track = sp.track;
      const art = currentArtwork(sp);
      if (art) {
        mediaArt.src = art;
        mediaArt.style.display = "";
        mediaFallback.style.display = "none";
      } else {
        mediaArt.style.display = "none";
        mediaFallback.style.display = "";
      }
      mediaTitle.textContent = track?.title || t("No media");
      const liveLyric = track && sp.playing && SpotifyLyrics.current?.synced
        ? activeLyricLine(SpotifyLyrics.current, spotifyPosition(sp, Date.now()))
        : null;
      mediaSub.textContent = liveLyric ? `♪ ${liveLyric}` : (track?.artist || "Spotify");
      mediaSub.classList.toggle("is-lyric", !!liveLyric);
      clear(mediaPlayBtn);
      mediaPlayBtn.append(svg(sp.playing ? ICONS.pause : ICONS.play, 11));
      mediaPlayBtn.classList.toggle("playing", sp.playing);

      // Sync Airadoro Focus card
      const snap = Airadoro.snapshot;
      const rem = snap.phase === "idle" ? null : Airadoro.remaining();
      const focusTimeStr = rem != null ? AiradoroEngine.clock(rem) : "25:00";
      focusClock.textContent = focusTimeStr;
      const focusStateStr =
        snap.phase === "idle"
          ? `${t("Focus")}, ${t("Ready").toLowerCase()}`
          : snap.paused
            ? `${t("Focus")}, ${t("Pause").toLowerCase()}`
            : snap.phase === "rest"
              ? t("Pause")
              : t("Focus");
      focusSub.textContent = focusStateStr;
      clear(focusPlayBtn);
      const activeFocus = snap.phase !== "idle" && !snap.paused;
      focusPlayBtn.append(svg(activeFocus ? ICONS.pause : ICONS.play, 11));
      focusPlayBtn.classList.toggle("playing", activeFocus);

      const showJobs = State.settings.compactAgenda !== false;
      const showMedia = State.settings.compactMusic !== false;
      const showFocus = State.settings.compactAiradoro !== false;
      const hasCards = showJobs || showMedia || showFocus;
      const standby = !hasCards && pillTasks.length === 0;
      el.classList.toggle("is-standby", standby);
      if (standby) {
        const dateLabel = now.toLocaleDateString(language(), {
          weekday: "long",
          day: "numeric",
          month: "long",
        });
        if (dateSubEl.textContent !== dateLabel) dateSubEl.textContent = dateLabel;
      }
      jobsCard.style.display = showJobs ? "" : "none";
      mediaCard.style.display = showMedia ? "" : "none";
      focusCard.style.display = showFocus ? "" : "none";
      cardsRow.style.display = hasCards ? "" : "none";
    },
  };
}

function dashNeedsTick(): boolean {
  return (
    (Airadoro.snapshot.phase !== "idle" && !Airadoro.snapshot.paused) ||
    (Spotify.state.playing && Spotify.state.track != null)
  );
}

function createDashTicker(dash: DashHost): (run: boolean) => void {
  let timer: number | null = null;
  const syncTimer = (run: boolean) => {
    if (!run) {
      if (timer != null) window.clearInterval(timer);
      timer = null;
      return;
    }
    if (timer != null) return;
    timer = window.setInterval(() => {
      if (State.mode === "expanded" && (State.view === "overview" || State.view === "empty") && dashNeedsTick()) {
        dash.sync(State.tasks);
      } else {
        syncTimer(false);
      }
    }, 500);
  };
  return syncTimer;
}

// ── Overview ──────────────────────────────────────────────────────────────────

function buildOverview(actions: ViewActions): ViewHost {
  /** The diff open in the left card (a FileDiff id), as activeDiffId on macOS. */
  let activeDiffId: number | null = null;
  const closeDiff = () => {
    if (activeDiffId == null) return;
    activeDiffId = null;
    State.notify();
  };
  const ticker = new Ticker((diffId) => {
    actions.blip();
    activeDiffId = diffId;
    State.notify();
  });
  const who = h("div", { class: "who" });
  const tickerBody = h("div", { class: "card-body" }, who, ticker.el);
  const leftBody = h("div", { class: "left-body" });
  const jump = h(
    "button",
    { class: "icon-btn jump", title: tl("Open"), onclick: () => actions.openTarget() },
    svg(ICONS.arrowUpRight, 12),
  );
  const backDashBtn = h(
    "button",
    {
      type: "button",
      class: "dash-back-pill",
      onclick: () => {
        actions.blip();
        overviewScreen = "dash";
        closeDiff();
        closePlanCard();
        State.notify();
      },
    },
    svg(ICONS.chevronLeft, 10, { stroke: 2 }),
    h("span", { text: tl("Home") }),
  );
  const left = card(null, leftBody, jump, backDashBtn);
  const dash = buildHomeDashboard(actions, (taskId) => {
    overviewScreen = "detail";
    actions.setFocus(taskId);
  });
  // Opened from a plan pill in the header: stands in for the left card.
  const plan = new PlanCard();
  let planTimer: number | null = null;
  const syncFocusDashTimer = createDashTicker(dash);
  // Spotify's card is kept and updated in place: the progress bar
  // runs on, and a slider being dragged must not be rebuilt under the pointer.
  const spotifyCard = buildSpotifyCard();
  // WhatsApp's card too: its reply field keeps the draft and the keyboard while messages arrive.
  // Mail's card too (classic Outlook): the search field keeps its text and the keyboard.
  const mailCard = buildMailCard({ keyboard: (on) => actions.keyboard(on) });
  const whatsappCard = buildWhatsAppCard({
    openSettings: () => actions.openSettingsWindow(),
    keyboard: (on) => actions.keyboard(on),
    holdOpen: (on) => actions.holdOpen(on),
  });

  const detailRow = h("div", { class: "overview-detail" }, h("div", { class: "left" }, left));
  const el = h("div", { class: "view overview is-dash" }, dash.el, detailRow);

  let detailOpen = false;
  let overviewScreen: "dash" | "detail" = "dash";
  let initialized = false;
  let lastFocus: string | null = null;
  let mode: "ticker" | "card" | "plan" | "diff" | "spotify" | "whatsapp" | "mail" | "airadoro" | null = null;
  let cardKey = "";
  /** The list row highlighted at the last sync, to scroll only when it moves. */
  let shownSelection: number | null = null;

  window.addEventListener("aira:dash-home", () => {
    overviewScreen = "dash";
    closeDiff();
    closePlanCard();
    if (State.view === "overview") State.notify();
  });

  // Leaving the overview or folding the island closes the diff, as on macOS.
  State.subscribe(() => {
    if (activeDiffId != null && (State.view !== "overview" || State.mode !== "expanded")) {
      activeDiffId = null;
    }
  });
  // Escape steps back out of the diff before it closes the island.
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || activeDiffId == null || State.view !== "overview") return;
      e.stopImmediatePropagation();
      closeDiff();
    },
    true,
  );

  const hooks: IntegrationCardHooks = {
    get detailOpen() {
      return detailOpen;
    },
    openDetail() {
      detailOpen = true;
      cardKey = "";
      State.notify();
    },
    closeDetail() {
      detailOpen = false;
      cardKey = "";
      State.notify();
    },
    openSettings: () => actions.openSettingsWindow(),
  };

  /** The countdowns move every 30 s while a card is open, and only then. */
  function syncPlanTimer(open: boolean) {
    const stop = () => {
      if (planTimer != null) window.clearInterval(planTimer);
      planTimer = null;
    };
    if (!open) return stop();
    if (planTimer != null) return;
    planTimer = window.setInterval(() => {
      if (planCardOpen() && State.mode === "expanded") State.notify();
      else stop();
    }, 30_000);
  }

  return {
    el,
    tick(nowMs: number) {
      if (overviewScreen !== "detail" || mode !== "ticker") return false;
      ticker.tick(nowMs);
      return ticker.animating;
    },
    command(command) {
      if (command === "openSelection") {
        // Ctrl+O: what a click on the highlighted row does.
        if (mode !== "card" || State.cardSelection == null) return;
        openRow(listRows(leftBody)[State.cardSelection]);
        return;
      }
      // Ctrl+E (⌘E, islandToggleDiff): closes the diff that is open, else
      // opens the focused pill's latest edit.
      if (activeDiffId != null) {
        closeDiff();
        return;
      }
      const task = State.focusTask;
      const diffs = task ? State.sessionDiffs.get(task.id) : undefined;
      const last = diffs?.[diffs.length - 1];
      if (last?.id == null) return;
      overviewScreen = "detail";
      activeDiffId = last.id;
      State.notify();
    },
    sync() {
      const task = State.focusTask;
      if (!initialized) {
        initialized = true;
        lastFocus = task?.id ?? null;
      } else if (task?.id !== lastFocus) {
        lastFocus = task?.id ?? null;
        detailOpen = false;
        activeDiffId = null;
        cardKey = "";
        mode = null;
        if (task) overviewScreen = "detail";
      }

      const planOpen = planCardOpen();
      if (mode === "plan" && !planOpen) {
        mode = null;
        cardKey = "";
      }
      syncPlanTimer(planOpen);

      // A diff that has since been dropped (cap, expiry, session end) just closes.
      const diff = task && activeDiffId != null ? State.findDiff(task.id, activeDiffId) : null;
      if (!diff) activeDiffId = null;

      if (planOpen || diff != null) overviewScreen = "detail";

      const isDash = overviewScreen === "dash";
      el.classList.toggle("is-dash", isDash);
      el.classList.toggle("is-detail", !isDash);
      syncFocusDashTimer(isDash && State.mode === "expanded" && dashNeedsTick());

      if (isDash) {
        dash.sync(State.tasks);
        return;
      }

      // A workspace or agent pill with a live session keeps the ticker; every
      // other pill shows its own card, exactly like IntegrationCardView.
      const sessionActive = task != null && hasSessionTicker(task);

      if (planOpen) {
        if (mode !== "plan") {
          clear(leftBody);
          leftBody.append(plan.el);
          mode = "plan";
        }
        plan.sync();
      } else if (task && diff) {
        const key = `diff~${task.id}~${diff.id}`;
        if (key !== cardKey) {
          cardKey = key;
          mode = "diff";
          clear(leftBody);
          leftBody.append(buildDiffCard(diff, {
            dismiss: () => {
              actions.blip();
              closeDiff();
            },
            open: (path) => void Bridge.openFileInVSCode(path),
          }));
        }
      } else if (task && sessionActive) {
        if (mode !== "ticker") {
          clear(leftBody);
          leftBody.append(tickerBody);
          mode = "ticker";
          cardKey = "";
        }
        clear(who);
        // The agent's name is already the pill's: the label says what kind of
        // pill it is, as on the Mac (PillDefinition.sessionSubtitle).
        who.append(
          dot(task.color, 7),
          h("span", { class: "name", text: task.name }),
          h("span", { class: "tool", text: t(sessionSubtitle(task.id)) }),
        );
        if (task.steps.length > 1) {
          who.append(h("span", {
            class: "count",
            text: `${Math.min(task.stepIndex + 1, task.steps.length)}/${task.steps.length}`,
          }));
        }
        ticker.sync(task);
      } else if (task && task.id === SPOTIFY_ID) {
        // Its own card for every state: playing, idle, not installed.
        if (mode !== "spotify") {
          clear(leftBody);
          leftBody.append(spotifyCard.el);
          mode = "spotify";
          cardKey = "";
        }
        spotifyCard.sync();
      } else if (task && task.id === MAIL_ID) {
        if (mode !== "mail") {
          clear(leftBody);
          leftBody.append(mailCard.el);
          mode = "mail";
          cardKey = "";
        }
        mailCard.sync();
      } else if (task && task.id === WHATSAPP_ID) {
        // Its own card in every state: not linked, no message, conversations, one open.
        if (mode !== "whatsapp") {
          clear(leftBody);
          leftBody.append(whatsappCard.el);
          mode = "whatsapp";
          cardKey = "";
        }
        whatsappCard.sync();
      } else if (task && task.id === AIRADORO_ID) {
        overviewScreen = "dash";
        actions.setView("airadoro");
        return;
      } else if (task) {
        const info = State.integrations[task.id];
        const key = [
          language(), task.id, task.color, detailOpen, task.state, task.steps.join("|"),
          info?.loaded, info?.error, info?.configured,
          JSON.stringify(info?.data ?? {}),
        ].join("~");
        if (key !== cardKey) {
          cardKey = key;
          mode = "card";
          clear(leftBody);
          leftBody.append(renderIntegrationCard(task, hooks));
        }
      }

      jump.style.display = detailOpen || mode === "plan" || mode === "diff" || mode === "airadoro" ? "none" : "";

      // Ctrl+↓ Ctrl+↑ walk the open GitHub list (cardItemCount / cardSelection).
      const rows = mode === "card" ? listRows(leftBody) : [];
      State.cardItemCount = rows.length;
      if (State.cardSelection != null && State.cardSelection >= rows.length) State.cardSelection = null;
      highlightRow(rows, State.cardSelection, State.cardSelection !== shownSelection);
      shownSelection = State.cardSelection;
    },
  };
}

/**
 * IntegrationCardView.agentSessionActive: a workspace tool or an agent — or
 * any other tagged agent — with something going on.
 */
export function hasSessionTicker(task: AgentTask): boolean {
  // A pill made for an agent's session (Gemini CLI, Codex… not declared) only
  // exists while that session does: it keeps the ticker from the first event.
  if (task.source === "agent" && !task.isIntegration) return true;
  const category = pillDefinition(task.id)?.category;
  const isSession = category === "workspace" || category === "agent" ||
    (category == null && task.id.startsWith("agent_"));
  return isSession && (task.state !== "idle" || task.steps.length > 0);
}

// ── Empty ─────────────────────────────────────────────────────────────────────

function buildEmpty(actions: ViewActions): ViewHost {
  const dash = buildHomeDashboard(actions, (taskId) => {
    actions.setFocus(taskId);
    actions.setView("overview");
  });
  const syncDashTimer = createDashTicker(dash);
  const el = h("div", { class: "view overview is-dash empty-dash" }, dash.el);
  return {
    el,
    sync() {
      syncDashTimer(State.mode === "expanded" && dashNeedsTick());
      dash.sync(State.tasks);
    },
  };
}

// ── Mail Dashboard (3-card inbox overview) ───────────────────────────────────

function buildMailView(actions: ViewActions): ViewHost {
  const openFullMail = () => {
    actions.blip();
    actions.setFocus(MAIL_ID);
    actions.setView("overview");
  };

  function makeMailCard(label: Msg, accent: string): { cardEl: HTMLElement; numEl: HTMLElement; subEl: HTMLElement } {
    const numEl = h("div", { class: "mail-dash-num", text: "0" });
    const subEl = h("div", { class: "mail-dash-sub", text: label });
    const cardEl = h(
      "button",
      {
        type: "button",
        class: `mail-dash-card ${accent}`,
        onclick: openFullMail,
      },
      h("div", { class: "mail-dash-top" }, h("span", { class: "mail-dash-title", text: label }), h("span", { class: "mail-dash-arrow" }, svg(ICONS.arrowUpRight, 11))),
      h("div", { class: "mail-dash-metrics" }, numEl, subEl),
    );
    return { cardEl, numEl, subEl };
  }

  const cUnread = makeMailCard(tl("Unread"), "unread");
  const cImportant = makeMailCard(tl("Important"), "important");
  const cInbox = makeMailCard(tl("Inbox"), "inbox");
  const previewEl = h("div", { class: "mail-dash-preview" });
  const cards = h("div", { class: "mail-dash-grid" }, cUnread.cardEl, cImportant.cardEl, cInbox.cardEl);
  const el = h("div", { class: "view mail-dash-view" }, h("div", { class: "mail-dash-shell" }, cards, previewEl));

  return {
    el,
    sync() {
      const info = State.integrations[MAIL_ID];
      const data = info?.data as unknown as MailCardData | undefined;
      const msgs = data?.messages ?? [];
      const unreadCount = data?.unread ?? 0;
      const importantCount = msgs.filter((m) => m.flagged).length;
      const totalCount = msgs.length;

      cUnread.numEl.textContent = String(unreadCount);
      cImportant.numEl.textContent = String(importantCount);
      cInbox.numEl.textContent = String(totalCount);

      const latest = msgs.find((m) => m.unread) ?? msgs[0];
      clear(previewEl);
      if (latest) {
        previewEl.append(
          dot("#2F8CFF", 6),
          h("span", { class: "mail-dash-sender", text: latest.senderName || latest.address }),
          h("span", { class: "mail-dash-subj", text: latest.subject }),
        );
      } else {
        previewEl.append(
          dot(data?.running ? "#22C55E" : "#64748B", 6),
          h("span", { class: "mail-dash-subj", text: data?.running ? t("Inbox") : "Outlook" }),
        );
      }
    },
  };
}

// ── Approval ──────────────────────────────────────────────────────────────────

/** How long a fresh permission card ignores clicks on its buttons. */
const CLICK_GUARD_MS = 600;

/**
 * The ⌃ in the corner of a waiting card: folds the island to its compact size
 * and leaves the request waiting — nothing is answered (Mac #290). Opening the
 * island again brings the card back.
 */
function foldButton(actions: ViewActions): HTMLElement {
  return h(
    "button",
    { class: "icon-btn fold", title: tl("Later — keep it waiting"), onclick: () => actions.foldApproval() },
    svg(ICONS.chevronUp, 8, { stroke: 2.4 }),
  );
}

function buildApproval(actions: ViewActions): ViewHost {
  const who = h("div");
  const code = h("div", { class: "code" });
  const row = h("div", { class: "actions" });
  const el = h("div", { class: "view" },
    card("amber", stack(116, 16, who, code, row), foldButton(actions)));
  let rowKey = "";
  // The card pops up under a cursor that was busy with something else: a click
  // meant for the window underneath must not land on Allow. Clicks in the first
  // moments after a new request appears are ignored.
  let shownFor: string | null = null;
  let shownAt = 0;
  const guarded = (d: "allow" | "deny") => () => {
    if (performance.now() - shownAt < CLICK_GUARD_MS) return;
    actions.decide(d);
  };
  const inTerminal = () => {
    if (performance.now() - shownAt < CLICK_GUARD_MS) return;
    actions.answerInTerminal();
  };
  return {
    el,
    sync() {
      const req = State.pendingApproval?.requestId ?? null;
      if (req !== shownFor) {
        shownFor = req;
        shownAt = performance.now();
      }
      clear(who);
      who.append(agentWho(State.focusTask, t("needs permission")));
      // The whole point of approving here rather than in the terminal: this line
      // is the command, the file path or the URL being authorised, not just the
      // name of the tool asking.
      code.textContent = State.pendingApproval?.command || State.pendingApproval?.tool || "…";
      // Two buttons, built once per kind of card. Rebuilding them between a
      // mouse-down and a mouse-up would swallow the click. "Always" is gone until
      // the remembered-rules list exists to back it. Antigravity waits on the card:
      // a third button hands the command back to its own prompt in the terminal,
      // where its "Always allow" lives (as on the Mac).
      const agy = State.pendingApproval?.pillId === "agent_antigravity";
      const key = agy ? "agy" : "built";
      if (rowKey === key) return;
      rowKey = key;
      clear(row);
      row.append(
        btn(tl("Deny"), "secondary", guarded("deny"), "N"),
        btn(tl("Allow"), "primary", guarded("allow"), "Y"),
      );
      if (agy) row.append(btn(tl("Reply in terminal"), "secondary", inTerminal));
    },
  };
}

// ── Question ──────────────────────────────────────────────────────────────────

function buildQuestion(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title question-text" });
  const row = h("div", { class: "actions options" });
  const fold = foldButton(actions);
  const el = h("div", { class: "view" }, card("cyan", stack(116, 16, who, title, row), fold));

  // Where we are in the request on screen: which question, what is answered so
  // far, and what is ticked in a pick-several question.
  let requestId = "";
  let index = 0;
  let answers: Record<string, string | string[]> = {};
  let picked = new Set<string>();
  // The buttons are only rebuilt when what they show changes: rebuilding them
  // between a mouse-down and a mouse-up would swallow the click.
  let rowKey = "";

  const next = (question: string, answer: string | string[], total: number) => {
    answers[question] = answer;
    picked = new Set();
    index += 1;
    if (index >= total) actions.answer(answers);
    else State.notify();
  };

  return {
    el,
    sync() {
      const questions = State.pendingApproval?.questions;
      clear(who);
      // Only a request that is waiting can be folded away and come back.
      fold.style.display = State.pendingApproval ? "" : "none";

      // A question that arrived as a notification has nothing to pick from.
      if (!questions) {
        who.append(agentWho(State.focusTask, t("is asking a question")));
        const task = State.focusTask;
        title.textContent = (task && lastTextStep(task.steps)) ?? t("Claude needs an answer.");
        if (rowKey !== "terminal") {
          rowKey = "terminal";
          clear(row);
          row.append(h("div", { class: "sub", text: tl("Answer it in your terminal.") }));
        }
        return;
      }

      if (State.pendingApproval!.requestId !== requestId) {
        requestId = State.pendingApproval!.requestId;
        index = 0;
        answers = {};
        picked = new Set();
      }
      const q = questions[Math.min(index, questions.length - 1)];
      const asking = questions.length > 1
        ? t("is asking ({index} of {total})", { index: index + 1, total: questions.length })
        : t("is asking");
      who.append(agentWho(State.focusTask, asking));
      title.textContent = q.question;
      title.title = q.question;

      const key = `${requestId}:${index}:${[...picked].join("|")}`;
      if (rowKey === key) return;
      rowKey = key;
      clear(row);
      for (const option of q.options) {
        const on = picked.has(option.label);
        const button = btn(option.label, on ? "primary" : "secondary", () => {
          if (!q.multiSelect) {
            next(q.question, option.label, questions.length);
            return;
          }
          if (on) picked.delete(option.label);
          else picked.add(option.label);
          State.notify();
        });
        if (option.description) button.title = option.description;
        row.append(button);
      }
      if (q.multiSelect) {
        const done = btn(tl("Done"), "primary", () => {
          if (picked.size > 0) next(q.question, [...picked], questions.length);
        });
        if (picked.size === 0) done.classList.add("off");
        row.append(done);
      }
      row.append(
        h("button", {
          class: "link-btn",
          style: "color:#8e939c",
          text: tl("Answer in terminal"),
          onclick: () => actions.answerInTerminal(),
        }),
      );
    },
  };
}

// ── Error ─────────────────────────────────────────────────────────────────────

function buildError(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title" });
  const detail = h("div", { class: "detail" });
  const row = h("div", { class: "actions" },
    btn(tl("Retry"), "primary", () => actions.setView(State.defaultView())),
    btn(tl("Open in n8n"), "secondary", () => actions.openUrl("")),
  );
  const el = h("div", { class: "view" }, card("red", stack(116, 16, who, title, detail, row)));
  return {
    el,
    sync() {
      const task = State.focusTask;
      clear(who);
      // agentWho already shows an agent's name: its label is just the kind.
      const whoLabel = task?.source === "n8n" ? "n8n" : task?.source === "agent" ? t("Agent") : "Claude Code";
      who.append(agentWho(task, whoLabel));
      title.textContent = task?.source === "n8n" ? t("Workflow stopped.") : t("Session stopped on an error.");
      detail.textContent = (task && lastTextStep(task.steps)) ?? t("No detail available.");
    },
  };
}

// ── Finished ──────────────────────────────────────────────────────────────────

function buildFinished(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title one-line" });
  const open = btn(tl("Open terminal"), "primary", () => actions.openTerminal());
  const row = h("div", { class: "actions" },
    open,
    btn(tl("OK"), "secondary", () => actions.collapse()),
  );
  const el = h("div", { class: "view" }, card("green", stack(116, 16, who, title, row)));
  return {
    el,
    sync() {
      clear(who);
      const agent = State.focusTask?.source === "agent";
      who.append(agentWho(State.focusTask, agent ? t("finished") : t("Claude Code finished")));
      // The final message, else the last step that is not a diff (FinishedView).
      const task = State.focusTask;
      title.textContent = task?.finalLine || (task && lastTextStep(task.steps)) || t("Session finished");
      // Sessions from the Claude desktop app live there, not in a terminal.
      const label = task?.id === "agent_claude-desktop" ? t("Open Claude") : t("Open terminal");
      const span = open.firstElementChild as HTMLElement;
      if (span.textContent !== label) span.textContent = label;
    },
  };
}

// ── Confused ──────────────────────────────────────────────────────────────────

function buildConfused(): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 128px" },
    h("div", { class: "title", text: tl("Too many hits at once.") }),
    h("div", { class: "sub", text: tl("Give me a sec — back to work in three seconds.") }),
  );
  return { el: h("div", { class: "view" }, card("pink", body)), sync() { } };
}

// ── Note ──────────────────────────────────────────────────────────────────────

function buildNote(): ViewHost {
  const title = h("div", { class: "title" });
  const el = h("div", { class: "view" }, card(null, h("div", { class: "stack", style: "padding:0 18px 0 98px" }, title)));
  return {
    el,
    sync() {
      title.textContent = State.noteMessage ?? "";
    },
  };
}

// ── In-island settings ────────────────────────────────────────────────────────

function buildSettings(actions: ViewActions): ViewHost {
  const soundSwitch = h("button", { class: "switch", onclick: () => actions.toggleSound() });
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    oninput: (e: Event) => actions.setVolume(Number((e.target as HTMLInputElement).value)),
  }) as HTMLInputElement;
  const autoLabel = h("span", {});
  const segButtons = [10, 15, 30].map((s) =>
    h("button", { onclick: () => actions.setAutoClose(s) }, `${s}s`),
  );
  const claudeBadge = h("span", { class: "status-badge" });
  const apiBadge = h("span", { class: "status-badge" });

  const rows = h(
    "div",
    { class: "settings-rows" },
    h("div", { class: "settings-row" }, soundSwitch, h("span", { text: tl("Sound") }), volume),
    h(
      "div",
      { class: "settings-row" },
      svg(ICONS.timer, 12),
      autoLabel,
      h("div", { class: "seg" }, ...segButtons),
    ),
    h(
      "div",
      { class: "settings-row", style: "gap:14px" },
      claudeBadge,
      apiBadge,
      h("div", { class: "grow" }),
      h("button", {
        class: "link-btn",
        style: "color:#8e939c;font-size:11.5px",
        text: tl("Settings…"),
        onclick: () => actions.openSettingsWindow(),
      }),
    ),
  );

  const el = h("div", { class: "view" },
    card(null, h("div", { class: "stack", style: "padding:14px 16px" }, rows)));

  return {
    el,
    sync() {
      const s = State.settings;
      soundSwitch.classList.toggle("on", s.soundEnabled);
      volume.value = String(s.soundVolume);
      volume.style.opacity = s.soundEnabled ? "1" : "0.4";
      autoLabel.textContent = t("Auto-close · {seconds}s", { seconds: Math.round(s.autoCloseInterval) });
      segButtons.forEach((b, i) => b.classList.toggle("on", s.autoCloseInterval === [10, 15, 30][i]));
      clear(claudeBadge);
      claudeBadge.append(
        dot(s.hooksInstalled ? "#22C55E" : "#F4505E", 6),
        h("span", { text: "Claude Code" }),
      );
      clear(apiBadge);
      apiBadge.append(dot("#F4505E", 6), h("span", { text: "API" }));
    },
  };
}

// ── Registry ──────────────────────────────────────────────────────────────────

export function buildViews(
  actions: ViewActions,
  onChatHeightChange: () => void,
): Map<IslandViewName, ViewHost> {
  const map = new Map<IslandViewName, ViewHost>();
  map.set("overview", buildOverview(actions));
  map.set("empty", buildEmpty(actions));
  map.set("approval", buildApproval(actions));
  map.set("question", buildQuestion(actions));
  map.set("error", buildError(actions));
  map.set("finished", buildFinished(actions));
  map.set("confused", buildConfused());
  map.set("note", buildNote());
  map.set("settings", buildSettings(actions));
  map.set("prompt", buildPrompt(onChatHeightChange));
  map.set("upload", buildUpload(actions));
  map.set("uploading", buildUploading());
  map.set("choose", buildChoose(actions));
  map.set("convert", buildConvertView(actions));
  map.set("camera", buildCameraView(actions));
  map.set("recap", buildRecap(actions));
  map.set("wardrobe", buildWardrobe(actions));
  map.set("update", buildUpdate());
  map.set("whatsNew", buildWhatsNew());
  map.set("launch", buildLaunch(actions));
  map.set("agenda", buildAgendaView(actions));
  map.set("reminder", buildReminderView(actions));
  map.set("weather", buildWeatherView(actions));
  map.set("clipboard", buildClipboardView(actions));
  map.set("mail", buildMailView(actions));
  map.set("music", buildMusicView());
  map.set("airadoro", buildAiradoroView(actions));
  return map;
}
