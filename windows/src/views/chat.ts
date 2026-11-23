// Chat view — DOM port of PromptView / ChatBubble / TypingDotsView /
// ModelPickerView from IslandViewContent.swift.
//
// Answers are rendered as Markdown (markdown.ts). A local model streams its
// answer: Rust sends `chat-delta` events with the text visible so far. The
// model name above the text field opens the picker: provider chips, then the
// models of the chosen provider, asked for only once it is picked.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { renderMarkdown } from "./markdown";
import { Bridge, onEvent, type ChatContext, type ModelInfo } from "../core/bridge";
import {
  activeModel, pickModel, providerDef, visibleProviders, withModel, type ProviderDef,
} from "../core/providers";
import { Sound } from "../core/sound";
import { chipLabel, loadSubscriptions, subscribedProviders, subscription } from "../core/subscriptions";
import { State, type ChatMessage } from "../core/state";
import { addAgendaTask, loadAgendaTasks, parseAgendaCommand } from "../core/agenda";
import type { ViewHost } from "./views";
import { N_, t, tl } from "../i18n/i18n";
import { HOST_OS } from "../core/pills";
import { MailChat, splitPlan } from "../core/mail";
import { mailPlanCard } from "./mailplan";
import {
  formatSessionTime,
  groupChatSessions,
  type ChatSession,
} from "../core/chat-sessions";

const STRINGS = {
  placeholderFirst: N_("Ask me anything…"),
  placeholderNext: N_("Continue…"),
  send: N_("Send"),
  switchModel: N_("Switch provider or model"),
  noModel: N_("Choose a model"),
  loading: N_("Loading models…"),
  noKey: N_("No API key — add it in Settings."),
  openSettings: N_("Open Settings"),
  history: N_("History"),
  newChat: N_("New Chat"),
  newShort: N_("New"),
  clearChat: N_("Delete current conversation"),
  clearAll: N_("Clear All"),
  conversations: N_("Conversations"),
  noHistory: N_("No previous conversations"),
  deleteConversation: N_("Delete conversation"),
  msgs: N_("msgs"),
  removeAttachment: N_("Remove attachment"),
};

let nextId = 1;

function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1, dot + 6).toUpperCase();
}

function bubble(message: ChatMessage): HTMLElement {
  if (message.role === "user") {
    const attachmentCard = message.attachment
      ? (() => {
          const ext = fileExtension(message.attachment.name);
          return h(
            "div",
            { class: "bubble-attachment", title: message.attachment.name },
            h("span", { class: "bubble-attachment-ico" }, svg(ICONS.doc, 13)),
            h("span", { class: "bubble-attachment-name", text: message.attachment.name }),
            ext ? h("span", { class: "bubble-attachment-ext", text: ext }) : null,
          );
        })()
      : null;
    return h(
      "div",
      { class: "chat-row user" },
      attachmentCard,
      h("div", { class: "bubble", text: message.content }),
    );
  }
  const reply = h("div", { class: "reply" });
  // A mail plan (```coucou-mail) is never shown as raw JSON: its card goes under the answer.
  const { prose, plan } = splitPlan(message.content);
  renderMarkdown(reply, prose);
  if (plan) reply.append(mailPlanCard(`chat-${message.id}-${message.content.length}`, "", message.content));
  return h("div", { class: "chat-row" }, reply);
}

function typingDots(): HTMLElement {
  return h(
    "div",
    { class: "chat-row" },
    h("div", { class: "typing" }, h("i"), h("i"), h("i")),
  );
}

/** The coloured chip showing what the question is about (a dropped file). */
function contextChip(label: string, onRemove?: () => void): HTMLElement {
  const dot = h("i", { class: "chip-dot" });
  const text = h("span", { class: "chip-label", text: label });
  const closeBtn = onRemove
    ? h(
        "button",
        {
          class: "chip-close",
          title: tl(STRINGS.removeAttachment),
          onclick: (e: Event) => {
            e.stopPropagation();
            onRemove();
          },
        },
        svg(ICONS.xmark, 7, { stroke: 2 }),
      )
    : null;
  const chip = h("div", { class: "chip" }, dot, text, closeBtn);
  requestAnimationFrame(() => chip.classList.add("settled"));
  return chip;
}

function saveSettings() {
  void Bridge.saveSettings(State.settings);
}

// ── Model picker ──────────────────────────────────────────────────────────────

interface Picker {
  el: HTMLElement;
  open(): void;
  close(): void;
  readonly isOpen: boolean;
}

/** Provider chips, then the chosen provider's models — ModelPickerView. */
function buildPicker(onChange: () => void): Picker {
  const chips = h("div", { class: "picker-chips" });
  const list = h("div", { class: "picker-list" });
  const el = h("div", { class: "picker" }, chips, h("div", { class: "picker-rule" }), list);

  /** Models already asked for, by provider; a model server is asked again each time. */
  const cache = new Map<string, ModelInfo[]>();
  let isOpen = false;
  let request = 0;

  function drawChips() {
    clear(chips);
    for (const p of visibleProviders(State.settings, subscribedProviders())) {
      const on = p.id === State.settings.chatProvider;
      const chip = h(
        "button",
        { class: on ? "picker-chip on" : "picker-chip", style: `--accent:${p.accent}` },
        h("i", { class: "picker-dot" }),
        h("span", { text: t(p.name) }),
      );
      chip.addEventListener("click", () => {
        if (p.id === State.settings.chatProvider) return;
        State.settings = { ...State.settings, chatProvider: p.id };
        saveSettings();
        Sound.play("pop");
        drawChips();
        void loadModels();
        onChange();
      });
      chips.append(chip);
    }
  }

  function status(text: string, withSettings = false) {
    clear(list);
    const line = h("div", { class: "picker-status", text });
    if (withSettings) {
      line.append(
        h("button", {
          class: "picker-link",
          text: tl(STRINGS.openSettings),
          onclick: () => void Bridge.openSettingsWindow(),
        }),
      );
    }
    list.append(line);
  }

  function drawModels(p: ProviderDef, models: ModelInfo[]) {
    clear(list);
    // Through a subscription, a tool other than Claude Code uses its own model ("").
    const ownModel = subscription(p.id)?.on && p.id !== "anthropic";
    const current = ownModel ? "" : activeModel(State.settings);
    for (const m of models) {
      const on = m.id === current;
      const row = h(
        "button",
        { class: on ? "picker-model on" : "picker-model", style: `--accent:${p.accent}`, title: m.id },
        h("span", { class: "picker-model-name", text: m.label }),
        on ? svg(ICONS.check, 11, { stroke: 2.2 }) : null,
      );
      row.addEventListener("click", () => {
        if (!m.id) return close();
        State.settings = withModel(State.settings, p.id, m.id);
        saveSettings();
        Sound.play("blip");
        close();
      });
      list.append(row);
    }
    list.querySelector(".picker-model.on")?.scrollIntoView({ block: "nearest" });
  }

  async function loadModels() {
    const p = providerDef(State.settings.chatProvider);
    const ticket = ++request;
    const subscribed = subscription(p.id)?.on ?? false;
    const cacheKey = `${p.id}:${subscribed}`;
    const cached = p.urlField ? undefined : cache.get(cacheKey);
    if (cached) {
      drawModels(p, cached);
      return;
    }
    // Nothing is asked of a provider that has no key yet (its subscription needs none).
    if (!subscribed && p.key && !(await Bridge.keyReady(p.key))) {
      if (ticket === request) status(t(STRINGS.noKey), true);
      return;
    }
    if (ticket !== request) return;
    status(t(STRINGS.loading));
    try {
      const models = await Bridge.chatModels(p.id);
      if (ticket !== request) return;
      if (!p.urlField) cache.set(cacheKey, models);
      const keep = subscribed && p.id !== "anthropic" ? null : pickModel(p, models.map((m) => m.id), activeModel(State.settings));
      if (keep && keep !== activeModel(State.settings)) {
        State.settings = withModel(State.settings, p.id, keep);
        saveSettings();
        onChange();
      }
      drawModels(p, models);
    } catch (err) {
      if (ticket === request) status(String(err).replace(/^Error:\s*/, ""), Boolean(p.key));
    }
  }

  function open() {
    isOpen = true;
    el.classList.add("on");
    drawChips();
    onChange();
    // Which subscriptions are on may have changed in Settings: ask, then list.
    void loadSubscriptions().then(() => {
      if (!isOpen) return;
      drawChips();
      onChange();
      void loadModels();
    });
  }

  function close() {
    isOpen = false;
    request++;
    el.classList.remove("on");
    onChange();
  }

  return {
    el,
    open,
    close,
    get isOpen() {
      return isOpen;
    },
  };
}

// ── History panel ─────────────────────────────────────────────────────────────

interface HistoryPanel {
  el: HTMLElement;
  open(): void;
  close(): void;
  render(): void;
  readonly isOpen: boolean;
}

function buildHistoryPanel(
  onSelect: (id: string) => void,
  onDelete: (id: string) => void,
  onClearAll: () => void,
  onToggle: () => void,
): HistoryPanel {
  const clearAllBtn = h("button", {
    class: "chat-history-clear",
    text: t(STRINGS.clearAll),
    onclick: () => onClearAll(),
  });
  const closeBtn = h(
    "button",
    {
      class: "chat-history-close",
      title: tl("Close"),
      onclick: () => close(),
    },
    svg(ICONS.xmark, 10),
  );
  const header = h(
    "div",
    { class: "chat-history-header" },
    h("span", { class: "chat-history-heading", text: t(STRINGS.conversations) }),
    h("div", { class: "chat-history-actions" }, clearAllBtn, closeBtn),
  );
  const list = h("div", { class: "chat-history-list" });
  const el = h("div", { class: "chat-history-panel" }, header, list);

  let isOpen = false;

  function renderItem(s: ChatSession): HTMLElement {
    const active = s.id === State.activeChatSessionId;
    const delBtn = h(
      "button",
      {
        class: "chat-history-del",
        title: tl(STRINGS.deleteConversation),
        onclick: (e: Event) => {
          e.stopPropagation();
          onDelete(s.id);
        },
      },
      svg(ICONS.trash, 11, { stroke: 1.8 }),
    );
    const meta = `${s.messages.length} ${t(STRINGS.msgs)} · ${formatSessionTime(s.updatedAt)}`;
    return h(
      "div",
      {
        class: active ? "chat-history-item active" : "chat-history-item",
        role: "button",
        tabindex: "0",
        onclick: () => onSelect(s.id),
      },
      h("i", { class: "chat-history-dot" }),
      h(
        "div",
        { class: "chat-history-text" },
        h("div", { class: "chat-history-title", text: s.title }),
        h("div", { class: "chat-history-meta", text: meta }),
      ),
      delBtn,
    );
  }

  function render() {
    clear(list);
    const sessions = State.chatSessions;
    clearAllBtn.style.display = sessions.length > 0 ? "" : "none";
    if (sessions.length === 0) {
      list.append(
        h(
          "div",
          { class: "chat-history-empty" },
          svg(ICONS.bubbleRound, 18),
          h("span", { text: t(STRINGS.noHistory) }),
        ),
      );
      return;
    }
    for (const group of groupChatSessions(sessions)) {
      list.append(h("div", { class: "chat-history-group", text: t(group.key) }));
      for (const item of group.items) list.append(renderItem(item));
    }
  }

  function open() {
    isOpen = true;
    el.classList.add("on");
    render();
    onToggle();
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    el.classList.remove("on");
    onToggle();
  }

  return {
    el,
    open,
    close,
    render,
    get isOpen() {
      return isOpen;
    },
  };
}

// ── View ──────────────────────────────────────────────────────────────────────

export function buildPrompt(onHeightChange: () => void): ViewHost {
  // Keep nextId above any restored session message IDs to avoid duplicate keys.
  for (const m of State.chatHistory) {
    if (m.id >= nextId) nextId = m.id + 1;
  }
  if (State.chatHistory.length > 0) {
    void Bridge.chatRestore(State.chatHistory.map((m) => [m.role, m.content]));
  }

  const historyBadge = h("span", { class: "chat-tool-badge" });
  const historyBtn = h(
    "button",
    { class: "chat-tool-btn", title: tl(STRINGS.history) },
    svg(ICONS.history, 12, { stroke: 1.8 }),
    h("span", { text: t(STRINGS.history) }),
    historyBadge,
  ) as HTMLButtonElement;
  const sessionTitleEl = h("span", { class: "chat-session-title" });
  const newChatBtn = h(
    "button",
    { class: "chat-tool-btn", title: tl(STRINGS.newChat) },
    svg(ICONS.newChat, 12, { stroke: 1.8 }),
    h("span", { text: t(STRINGS.newShort) }),
  ) as HTMLButtonElement;
  const deleteChatBtn = h(
    "button",
    { class: "chat-tool-btn danger", title: tl(STRINGS.clearChat) },
    svg(ICONS.trash, 12, { stroke: 1.8 }),
  ) as HTMLButtonElement;
  const toolbar = h(
    "div",
    { class: "chat-toolbar" },
    h("div", { class: "chat-toolbar-left" }, historyBtn, sessionTitleEl),
    h("div", { class: "chat-toolbar-right" }, newChatBtn, deleteChatBtn),
  );

  const chipRow = h("div", { class: "chip-row" });
  const log = h("div", { class: "chat-log" });
  const input = h("input", {
    type: "text",
    class: "chat-input",
    placeholder: t(STRINGS.placeholderFirst),
    spellcheck: "false",
  }) as HTMLInputElement;
  const send = h("button", { class: "send-btn", title: tl(STRINGS.send) }, svg(ICONS.arrowUp, 11));
  const bar = h("div", { class: "chat-bar" }, input, send);

  const modelDot = h("i", { class: "model-dot" });
  const modelName = h("span", { class: "model-name" });
  const modelBtn = h(
    "button",
    { class: "model-btn", title: tl(STRINGS.switchModel) },
    modelDot,
    modelName,
    svg(ICONS.chevronUpDown, 9, { stroke: 2 }),
  );
  // The Mail switch (classic Outlook, Windows): on, the AI sees the latest messages and may
  // prepare actions on them, which run only after a click on the plan's card.
  const mailBtn = h("button", { class: "mail-toggle", title: tl("Lets the AI see your latest messages and prepare actions on them. Nothing happens until you click Run.") },
    svg(ICONS.envelope, 12, { stroke: 1.8 }), h("span", { text: tl("Mail") }));
  mailBtn.addEventListener("click", () => {
    MailChat.on = !MailChat.on;
    mailBtn.classList.toggle("on", MailChat.on);
  });
  const modelRow = h("div", { class: "model-row" }, modelBtn);
  if (HOST_OS === "windows") modelRow.prepend(mailBtn);

  const body = h("div", { class: "chat-body" });
  function syncOverlayHeight() {
    const nextOverlay = picker.isOpen ? "picker" : historyPanel.isOpen ? "history" : "none";
    if (State.chatOverlay !== nextOverlay) {
      State.chatOverlay = nextOverlay;
      onHeightChange();
    }
  }
  const picker = buildPicker(() => {
    body.classList.toggle("picking", picker.isOpen);
    if (picker.isOpen && historyPanel.isOpen) historyPanel.close();
    drawModelButton();
    syncOverlayHeight();
  });
  const historyPanel = buildHistoryPanel(
    (id) => {
      if (sending) return;
      const msgs = State.selectChatSession(id);
      if (msgs) {
        for (const m of msgs) {
          if (m.id >= nextId) nextId = m.id + 1;
        }
        void Bridge.chatRestore(msgs.map((m) => [m.role, m.content]));
      }
      historyPanel.close();
      renderedCount = -1;
      Sound.play("blip");
      State.notify();
      onHeightChange();
      input.focus();
    },
    (id) => {
      const wasActive = State.activeChatSessionId === id;
      State.deleteChatSessionById(id);
      if (wasActive) {
        void Bridge.chatReset();
        renderedCount = -1;
      }
      Sound.play("pop");
      historyPanel.render();
      drawToolbar();
      State.notify();
      onHeightChange();
    },
    () => {
      State.clearAllChatSessions();
      void Bridge.chatReset();
      renderedCount = -1;
      Sound.play("pop");
      historyPanel.render();
      drawToolbar();
      State.notify();
      onHeightChange();
    },
    () => {
      body.classList.toggle("history-open", historyPanel.isOpen);
      if (historyPanel.isOpen && picker.isOpen) picker.close();
      drawToolbar();
      syncOverlayHeight();
    },
  );

  body.append(toolbar, chipRow, log, picker.el, historyPanel.el, modelRow, bar);
  void loadSubscriptions().then(() => drawModelButton());

  const el = h("div", { class: "view" }, h("div", { class: "card wash chat-card" }, body));
  (el.querySelector(".card") as HTMLElement).style.setProperty("--wash", "rgba(99,102,241,0.5)");

  let sending = false;
  let renderedCount = -1;
  // A local model answers token by token: where its text so far is shown.
  let live: HTMLElement | null = null;

  function drawToolbar() {
    const count = State.chatSessions.length;
    historyBadge.textContent = count > 0 ? String(count) : "";
    historyBadge.style.display = count > 0 ? "" : "none";
    historyBtn.classList.toggle("on", historyPanel.isOpen);
    historyBtn.disabled = sending;

    const active = State.activeChatSessionId
      ? State.chatSessions.find((s) => s.id === State.activeChatSessionId)
      : undefined;
    sessionTitleEl.textContent = active ? active.title : "";
    sessionTitleEl.style.display = active && !historyPanel.isOpen ? "" : "none";

    const hasMsgs = State.chatHistory.length > 0;
    newChatBtn.disabled = sending || (!hasMsgs && !State.activeChatSessionId);
    deleteChatBtn.disabled = sending || !hasMsgs;
    deleteChatBtn.style.display = hasMsgs ? "" : "none";
  }

  function startNewChat() {
    if (sending) return;
    State.startNewChatSession();
    void Bridge.chatReset();
    if (historyPanel.isOpen) historyPanel.close();
    renderedCount = -1;
    Sound.play("blip");
    drawToolbar();
    State.notify();
    onHeightChange();
    input.focus();
  }

  function deleteCurrentChat() {
    if (sending || State.chatHistory.length === 0) return;
    if (State.activeChatSessionId) State.deleteChatSessionById(State.activeChatSessionId);
    else State.startNewChatSession();
    void Bridge.chatReset();
    renderedCount = -1;
    Sound.play("pop");
    drawToolbar();
    if (historyPanel.isOpen) historyPanel.render();
    State.notify();
    onHeightChange();
    input.focus();
  }

  historyBtn.addEventListener("click", () => {
    if (sending) return;
    if (historyPanel.isOpen) historyPanel.close();
    else historyPanel.open();
  });
  newChatBtn.addEventListener("click", () => startNewChat());
  deleteChatBtn.addEventListener("click", () => deleteCurrentChat());

  function drawModelButton() {
    const p = providerDef(State.settings.chatProvider);
    modelDot.style.background = p.accent;
    modelName.textContent = chipLabel(State.settings, activeModel(State.settings)) || t(STRINGS.noModel);
    modelBtn.classList.toggle("open", picker.isOpen);
    modelBtn.disabled = sending;
  }

  modelBtn.addEventListener("click", () => {
    if (sending) return;
    if (picker.isOpen) picker.close();
    else picker.open();
  });

  void onEvent<string>("chat-delta", (text) => {
    if (!sending || !text) return; // nothing visible yet: the dots stay
    if (!live) {
      live = h("div", { class: "reply" });
      log.querySelector(".typing")?.parentElement?.remove();
      log.append(h("div", { class: "chat-row" }, live));
    }
    renderMarkdown(live, splitPlan(text).prose);
    log.scrollTop = log.scrollHeight;
  });

  async function submit() {
    const query = input.value.trim();
    if (!query || sending) return;
    if (picker.isOpen) picker.close();
    if (historyPanel.isOpen) historyPanel.close();
    input.value = "";
    sending = true;
    drawModelButton();
    drawToolbar();
    Sound.play("send");

    const agendaCmd = parseAgendaCommand(query, new Date());
    if (agendaCmd) {
      State.chatHistory.push({ id: nextId++, role: "user", content: query });
      addAgendaTask(loadAgendaTasks(), agendaCmd.date, agendaCmd.title, agendaCmd.time);
      const when = agendaCmd.time ? `${agendaCmd.date} · ${agendaCmd.time}` : agendaCmd.date;
      State.chatHistory.push({
        id: nextId++,
        role: "assistant",
        content: `${t("Added")}: **${agendaCmd.title}** (${when})`,
      });
      State.saveCurrentChatSession();
      Sound.play("finish");
      sending = false;
      drawModelButton();
      drawToolbar();
      State.notify();
      onHeightChange();
      input.disabled = false;
      input.focus();
      return;
    }

    const file = State.droppedFile;
    const attachToTurn = State.chatHistory.length === 0 && Boolean(file);
    State.chatHistory.push({
      id: nextId++,
      role: "user",
      content: query,
      ...(attachToTurn && file ? { attachment: { name: file.name, path: file.path } } : {}),
    });
    State.saveCurrentChatSession();

    const context: ChatContext | null =
      attachToTurn && file ? { kind: "file", name: file.name, path: file.path } : null;

    if (file) {
      State.clearDroppedFile();
      chipRow.dataset.label = "";
      clear(chipRow);
    }

    State.stateOverride = "thinking";
    State.notify();
    onHeightChange();

    try {
      const reply = await Bridge.chatSend(query, context, MailChat.on && HOST_OS === "windows");
      State.chatHistory.push({ id: nextId++, role: "assistant", content: reply.text });
      State.saveCurrentChatSession();
      State.stateOverride = null;
      Sound.play("finish");
    } catch (err) {
      State.stateOverride = null;
      State.noteMessage = String(err).replace(/^Error:\s*/, "");
      State.view = "note";
      Sound.play("error");
    } finally {
      sending = false;
      live = null;
      renderedCount = -1; // the finished answer replaces the streamed one
      drawModelButton();
      drawToolbar();
      State.notify();
      onHeightChange();
      // Back to typing without a click. The field was disabled while the
      // answer came, which took the focus away, and the sync that enables it
      // again is a frame away: a disabled field can't take the focus.
      if (State.view === "prompt") {
        input.disabled = false;
        input.focus();
      }
    }
  }

  send.addEventListener("click", () => void submit());
  input.addEventListener("keydown", (e) => {
    const key = (e as KeyboardEvent).key;
    if (key === "Enter") {
      e.preventDefault();
      void submit();
    } else if (key === "Escape" && picker.isOpen) {
      e.preventDefault();
      picker.close();
    } else if (key === "Escape" && historyPanel.isOpen) {
      e.preventDefault();
      historyPanel.close();
    }
    e.stopPropagation(); // Escape closes the island, not the chat
  });

  return {
    el,
    sync() {
      const file = State.droppedFile;
      const wantChip = file?.name ?? "";
      if (chipRow.dataset.label !== wantChip) {
        chipRow.dataset.label = wantChip;
        clear(chipRow);
        if (wantChip) {
          chipRow.append(
            contextChip(wantChip, () => {
              State.clearDroppedFile();
              chipRow.dataset.label = "";
              clear(chipRow);
              Sound.play("pop");
              State.notify();
              onHeightChange();
            }),
          );
        }
      }

      const thinking = State.stateOverride === "thinking";
      const count = State.chatHistory.length + (thinking ? 0.5 : 0);
      if (count !== renderedCount && !live) {
        renderedCount = count;
        clear(log);
        for (const m of State.chatHistory) log.append(bubble(m));
        if (thinking) log.append(typingDots());
        log.scrollTop = log.scrollHeight;
      }

      // Leaving the chat folds the picker and history drawer away.
      if (State.view !== "prompt") {
        if (picker.isOpen) picker.close();
        if (historyPanel.isOpen) historyPanel.close();
      }
      drawModelButton();
      drawToolbar();

      input.placeholder = t(State.chatHistory.length === 0 ? STRINGS.placeholderFirst : STRINGS.placeholderNext);
      input.disabled = sending;
    },
    focus() {
      input.focus();
      input.select();
    },
  };
}
