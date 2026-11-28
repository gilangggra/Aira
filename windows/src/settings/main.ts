// The Coucou window (settings.html): Flow dictation, the Notetaker and, under
// Notch, every setting of the island — the place where anything that writes to
// disk is confirmed. The window's frame and the Flow pages live in ../hub; the
// island's settings are drawn here, one Notch page at a time.

import "./settings.css";
import { Bridge, onEvent, type HookPreview, type HookStatus, type ShortcutsReport, type SubscriptionStatus } from "../core/bridge";
import { CUSTOM_SERVER_KEY, providerDef, urlExposure } from "../core/providers";
import {
  ISLAND_SHORTCUTS, SHORTCUTS, SHORTCUT_TEXT, activeKeys, displayKeys, duplicates, effective,
  recordPress, type Binding,
} from "../core/shortcuts";
import { DEFAULT_MOCHI_TUNE, DEFAULT_SETTINGS, type MochiTune, type Settings } from "../core/state";
import { closedIsland } from "../core/closed";
import type { UpdateStatus } from "../core/update";
import { SOUND_NAMES } from "../core/sound";
import {
  PILL_CATEGORIES, availablePills, chooseMainPill, isComingSoon, mainPillChoices,
  sanitizeDeclared, toggleDeclared, type PillDefinition,
} from "../core/pills";
import { h, clear, svg } from "../views/dom";
import { ICONS } from "../views/icons";
import { buildMiniWeatherIcon } from "../views/weather-art";
import { startHub, type PageId } from "../hub/shell";
import { FLOW_PAGE_RENDERERS } from "../hub/pages";
import { claudeModelControl } from "./claude-models";
import { agentsSection } from "./agents";
import { phoneSection } from "./phone";
import { whatsappSection } from "./whatsapp";
import { converterSection } from "./converter";
import { WHATSAPP_ID } from "../core/whatsapp";
import {
  AIRADORO_STORAGE_REST, AIRADORO_STORAGE_WORK, DEFAULT_REST_MINUTES, DEFAULT_WORK_MINUTES,
  loadStoredMinutes, saveStoredMinutes,
} from "../core/airadoro";
import { updateRows, updatesListener } from "./updates";
import { colorDot } from "./colors";
import { renderDiff, statusDot } from "./parts";
import {
  LANGUAGES, N_, isRtl, onLanguageChange, resolveLanguage, setLanguage, systemLanguages, t, tn,
} from "../i18n/i18n";

/** Where secrets.rs keeps the keys on this OS. */
const KEY_STORE = navigator.userAgent.includes("Windows")
  ? "Windows Credential Manager"
  : "Secret Service (GNOME Keyring, KWallet)";

let settings: Settings = { ...DEFAULT_SETTINGS };
let version = "";

const windowRoot = document.getElementById("hub")!;
/** Where the Notch page being shown draws its sections. */
let root: HTMLElement = windowRoot;
let hub: { redraw(): void; current(): PageId } | null = null;

let saveTimer: number | null = null;

async function save() {
  if (saveTimer != null) {
    window.clearTimeout(saveTimer);
    saveTimer = null;
  }
  await Bridge.saveSettings(settings);
}

function saveDebounced(delayMs = 150) {
  if (saveTimer != null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    void Bridge.saveSettings(settings);
  }, delayMs);
}

/** A colour was picked for a pill's Mochi (see ./colors.ts): the island follows. */
function pickColor(next: Record<string, string>) {
  settings.pillColors = next;
  void save();
}

// ── Reusable bits ─────────────────────────────────────────────────────────────

function toggle(on: boolean, onChange: (v: boolean) => void): HTMLElement {
  const el = h("button", { class: on ? "switch on" : "switch", "aria-pressed": on });
  el.addEventListener("click", () => {
    const next = !el.classList.contains("on");
    el.classList.toggle("on", next);
    onChange(next);
  });
  return el;
}

/** Shows a switch made by toggle() as on or off, without calling its onChange. */
function setSwitch(el: HTMLElement, on: boolean) {
  el.classList.toggle("on", on);
  el.setAttribute("aria-pressed", String(on));
}

/** Runs `fn` while preserving the scroll position of `.hub-scroll` so DOM rebuilds don't jump the viewport. */
function preserveScroll(anchor: HTMLElement, fn: () => void) {
  const scroller = anchor.closest(".hub-scroll") as HTMLElement | null;
  const top = scroller ? scroller.scrollTop : 0;
  fn();
  if (scroller) scroller.scrollTop = top;
}

function segmentedControl<T extends string>(
  options: [T, string][],
  initial: T,
  onChange: (v: T) => void,
): { element: HTMLElement; setValue: (v: T) => void } {
  const el = h("div", { class: "hub-segmented" });
  const buttons = new Map<T, HTMLButtonElement>();
  for (const [id, text] of options) {
    const b = h("button", {
      type: "button",
      class: id === initial ? "on" : "",
      text,
      onclick: () => {
        for (const [otherId, otherBtn] of buttons) {
          otherBtn.classList.toggle("on", otherId === id);
        }
        onChange(id);
      },
    }) as HTMLButtonElement;
    buttons.set(id, b);
    el.append(b);
  }
  return {
    element: el,
    setValue: (v: T) => {
      for (const [id, b] of buttons) {
        b.classList.toggle("on", id === v);
      }
    },
  };
}

function secretField(input: HTMLInputElement): HTMLElement {
  const toggleBtn = h("button", {
    type: "button",
    class: "secret-toggle",
    title: "Toggle",
    onclick: () => {
      const isSecret = input.type === "password";
      input.type = isSecret ? "text" : "password";
      const path = toggleBtn.querySelector("path");
      if (path) {
        path.setAttribute(
          "d",
          isSecret
            ? "M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24M1 1l22 22"
            : "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
        );
      }
    },
  });
  const eyeSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  eyeSvg.setAttribute("viewBox", "0 0 24 24");
  eyeSvg.setAttribute("fill", "none");
  eyeSvg.setAttribute("stroke", "currentColor");
  eyeSvg.setAttribute("stroke-width", "2");
  eyeSvg.setAttribute("stroke-linecap", "round");
  eyeSvg.setAttribute("stroke-linejoin", "round");
  const eyePath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  eyePath.setAttribute("d", "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z");
  eyeSvg.append(eyePath);
  toggleBtn.append(eyeSvg);
  return h("div", { class: "secret-field" }, input, toggleBtn);
}

// ── Changes to Claude Code's settings.json ────────────────────────────────────

/** One kind of change to ~/.claude/settings.json, with the words that go with it. */
interface Change {
  preview: (install: boolean) => Promise<HookPreview | null>;
  apply: (install: boolean, fingerprint: string) => Promise<string | null>;
  installText: string;
  removeText: string;
  installButton: string;
  removeButton: string;
  /** The note once written; `backup` is "" when there was no file to back up. */
  done: (backup: string) => string;
}

const HOOKS_CHANGE: Change = {
  preview: Bridge.hooksPreview,
  apply: Bridge.hooksApply,
  get installText() { return t("This is exactly what will change in your settings.json. Your own hooks are left untouched."); },
  get removeText() { return t("This removes Aira's entries only. Your own hooks are left untouched."); },
  get installButton() { return t("Back up and write"); },
  get removeButton() { return t("Back up and remove"); },
  done: (backup) => backup
    ? t("Done. Previous settings saved as {backup}. Open a new Claude Code session to pick the hooks up.", { backup })
    : t("Done. Open a new Claude Code session to pick the hooks up."),
};

const STATUS_LINE_CHANGE: Change = {
  preview: Bridge.statusLinePreview,
  apply: Bridge.statusLineApply,
  get installText() { return t("This is exactly what will change: only the status line. If you already have one it keeps working, Aira's relay runs it for you."); },
  get removeText() { return t("This puts your previous status line back, or removes the entry if there was none."); },
  get installButton() { return t("Back up and write"); },
  get removeButton() { return t("Back up and remove"); },
  done: (backup) => backup
    ? t("Done. Previous settings saved as {backup}. The numbers appear after the next reply of a Claude Code session.", { backup })
    : t("Done. The numbers appear after the next reply of a Claude Code session."),
};

/**
 * Shows the diff of a change in `body` and writes it only after an explicit
 * click, and only if settings.json still matches the diff that was shown.
 * `back` redraws the section; `applied` runs a moment after a successful write.
 */
async function reviewChange(
  body: HTMLElement,
  change: Change,
  install: boolean,
  back: () => void,
  applied: () => void,
) {
  let preview;
  try {
    preview = await change.preview(install);
  } catch (err) {
    // An unreadable or invalid settings.json stops here rather than being
    // treated as empty and written over.
    clear(body);
    body.append(
      h("div", { class: "notice err", text: String(err).replace(/^Error:\s*/, "") }),
      h("div", { class: "row" }, h("button", { text: t("Back"), onclick: back })),
    );
    return;
  }
  if (!preview) return;
  clear(body);
  body.append(
    h("div", { class: "hint", text: install ? change.installText : change.removeText }),
    renderDiff(preview.diff),
    h("div", { class: "row" },
      h("span", {
        class: "path",
        text: preview.backup
          ? t("Backup → {path}", { path: preview.backup })
          : t("No settings.json yet — nothing to back up."),
      }),
    ),
  );
  const confirm = h("button", {
    class: install ? "primary" : "danger",
    text: install ? change.installButton : change.removeButton,
  });
  confirm.addEventListener("click", async () => {
    confirm.disabled = true;
    try {
      const backup = await change.apply(install, preview.fingerprint);
      clear(body);
      body.append(h("div", { class: "notice ok", text: change.done(backup ?? "") }));
      window.setTimeout(applied, 2600);
    } catch (err) {
      confirm.disabled = false;
      body.append(h("div", { class: "notice err", text: t("Could not write: {error}", { error: String(err) }) }));
    }
  });
  body.append(h("div", { class: "row" }, confirm, h("button", { text: t("Cancel"), onclick: back })));
}

// ── Claude Code section ───────────────────────────────────────────────────────

function claudeSection(status: HookStatus): HTMLElement {
  const body = h("div", { style: "display:flex;flex-direction:column;gap:12px" });
  const section = h(
    "section",
    {},
    h("h2", {}, statusDot(status.installed), h("span", { text: "Claude Code" })),
    body,
  );

  const redraw = () => {
    clear(body);
    draw();
  };
  const rebuild = async () => {
    const fresh = await Bridge.hooksStatus();
    if (fresh) Object.assign(status, fresh);
    redraw();
    const head = section.querySelector("h2")!;
    clear(head);
    head.append(statusDot(status.installed), h("span", { text: "Claude Code" }));
  };

  function draw() {
    body.append(
      h("div", {
        class: "hint",
        text: status.installed
          ? t("Aira is hooked into your Claude Code sessions. Tool calls, questions and permission requests show up in the island, and you can answer them there.")
          : t("Install the hooks to see your Claude Code sessions in the island and approve permissions without leaving what you are doing."),
      }),
      h("div", { class: "row" },
        h("label", { text: "settings.json" }),
        h("span", { class: "path", text: status.settingsPath }),
      ),
      h("div", { class: "row" },
        h("label", { text: t("Relay") }),
        h("span", { class: "path", text: status.hookPath }),
        statusDot(status.hookReady),
      ),
    );

    if (!status.hookReady) {
      body.append(h("div", {
        class: "notice warn",
        text: t("aira-hook.exe is not in place yet. Restart Aira; if it still fails, build it with `cargo build -p aira-hook`."),
      }));
    }
    if (status.relayError) {
      body.append(h("div", {
        class: "notice warn",
        text: t("The hook relay could not start ({error}). Hooks will not reach Aira.", { error: status.relayError }),
      }));
    }

    const actions = h("div", { class: "row" });
    const install = h("button", {
      class: "primary",
      text: status.installed ? t("Reinstall hooks…") : t("Install hooks…"),
      onclick: () => void reviewChange(body, HOOKS_CHANGE, true, redraw, () => void rebuild()),
    });
    // Writing hook commands that point at a relay which isn't there would give
    // every Claude Code session a broken hook and nothing to show for it.
    if (!status.hookReady) {
      install.disabled = true;
      install.title = t("The relay isn't installed yet.");
    }
    actions.append(install);
    if (status.installed) {
      actions.append(h("button", {
        class: "danger",
        text: t("Uninstall hooks…"),
        onclick: () => void reviewChange(body, HOOKS_CHANGE, false, redraw, () => void rebuild()),
      }));
    }
    body.append(actions);
  }

  draw();
  void onEvent<string | null>("pipe-error", (err) => {
    if (!section.isConnected) return;
    status.relayError = err ?? null;
    redraw();
  });
  return section;
}

// ── Plan usage section ────────────────────────────────────────────────────────

/**
 * The 5-hour and weekly limits in the island's header. They come from Claude
 * Code's status line, so the relay has to be the status line first: turning the
 * switch on without it starts the install, and the switch only stays on once
 * that has been confirmed. A status line the user had keeps working.
 */
const PLAN_SETTINGS_TEXT = {
  get claude() { return t("Shows your Claude plan usage (5-hour and weekly limits) in the island's header. Aira adds a status line relay in ~/.claude/settings.json. If you already have a status line, it keeps working as before. Pro and Max plans only."); },
  get claudeCli() { return t("The numbers come from the Claude Code command-line tool. The Claude desktop app does not report them, so the gauge stays empty if you only use the desktop app."); },
  get showClaude() { return t("Show in notch"); },
  get showClaudeCompact() { return t("Show in compact island"); },
  get codex() { return t("Shows your Codex plan usage (weekly limit and free resets left) in the island's header. Aira asks the Codex CLI (codex app-server) when the pill shows; nothing is installed. Codex must be signed in with ChatGPT."); },
  get showCodex() { return t("Show Codex plan in the notch"); },
};

function planSection(status: HookStatus): HTMLElement {
  const body = h("div", { style: "display:flex;flex-direction:column;gap:12px" });
  const section = h("section", {}, h("h2", {}, h("span", { text: t("Plan usage") })), body);

  const redraw = () => {
    clear(body);
    draw();
  };
  const rebuild = async () => {
    const fresh = await Bridge.hooksStatus();
    if (fresh) Object.assign(status, fresh);
    settings.planRelayInstalled = status.planRelayInstalled;
    // Cancelled or failed: a switch that was waiting for the install falls back.
    if (!status.planRelayInstalled) {
      settings.showPlanInNotch = false;
      settings.showPlanInCompactIsland = false;
    }
    redraw();
  };

  function draw() {
    // The switch shows "on" while the install it asked for is being reviewed.
    const sw = toggle(settings.showPlanInNotch, (on) => {
      if (!on) {
        settings.showPlanInNotch = false;
        void save();
      } else if (status.planRelayInstalled) {
        settings.showPlanInNotch = true;
        void save();
      } else {
        // Turned on before the relay is in: install it first; it stays on once confirmed.
        void reviewChange(body, STATUS_LINE_CHANGE, true, () => void rebuild(), () => {
          settings.planRelayInstalled = true;
          settings.showPlanInNotch = true;
          void save().then(rebuild);
        });
      }
    });
    const swCompact = toggle(settings.showPlanInCompactIsland, (on) => {
      if (!on) {
        settings.showPlanInCompactIsland = false;
        void save();
      } else if (status.planRelayInstalled) {
        settings.showPlanInCompactIsland = true;
        void save();
      } else {
        void reviewChange(body, STATUS_LINE_CHANGE, true, () => void rebuild(), () => {
          settings.planRelayInstalled = true;
          settings.showPlanInCompactIsland = true;
          void save().then(rebuild);
        });
      }
    });
    body.append(
      h("div", {
        class: "hint",
        text: PLAN_SETTINGS_TEXT.claude,
      }),
      h("div", { class: "hint", text: PLAN_SETTINGS_TEXT.claudeCli }),
      h("div", { class: "row" }, h("label", { text: PLAN_SETTINGS_TEXT.showClaude }), sw),
      h("div", { class: "row" }, h("label", { text: PLAN_SETTINGS_TEXT.showClaudeCompact }), swCompact),
      h("div", { class: "row" },
        h("label", { text: t("Relay") }),
        statusDot(status.planRelayInstalled),
        h("span", { class: "hint", text: status.planRelayInstalled ? t("installed") : t("not installed") }),
        status.planRelayInstalled
          ? h("button", {
            class: "danger",
            text: t("Uninstall relay…"),
            onclick: () => void reviewChange(body, STATUS_LINE_CHANGE, false, redraw, () => void rebuild()),
          })
          : h("button", {
            class: "primary",
            text: t("Install relay…"),
            onclick: () => void reviewChange(body, STATUS_LINE_CHANGE, true, redraw, () => void rebuild()),
          }),
      ),
      // Codex: nothing to install, Coucou asks the Codex CLI when the pill shows.
      h("div", { class: "hint", text: PLAN_SETTINGS_TEXT.codex }),
      h("div", { class: "row" },
        h("label", { text: PLAN_SETTINGS_TEXT.showCodex }),
        toggle(settings.showCodexPlanInNotch, (on) => {
          settings.showCodexPlanInNotch = on;
          void save();
        }),
      ),
    );
  }

  draw();
  return section;
}

// ── Your AI subscriptions ─────────────────────────────────────────────────────

/** The plan people know, by provider. */
const SUBSCRIPTION_NAMES: Record<string, string> = {
  anthropic: "Claude", google: "Google Gemini", openai: "ChatGPT", cursor: "Cursor", copilot: "GitHub Copilot",
};

/**
 * One switch per provider (cli_relay.rs): on, the chat goes through its
 * official terminal tool, signed in with the user's own account; off, through
 * its API key. Says whether the tool is installed and how to sign in.
 */
function subscriptionsSection(): HTMLElement {
  const list = h("div", { class: "setting-list" });
  const draw = (rows: SubscriptionStatus[]) => {
    preserveScroll(list, () => {
      clear(list);
      for (const row of rows) {
        const p = providerDef(row.provider);
        const sw = toggle(row.on, (on) => {
          void Bridge.subscriptionSet(row.provider, on).then((next) => {
            if (next) draw(next);
          });
        });
        const info = h("div", { class: "setting-info" },
          h("div", { class: "setting-title" },
            h("i", { class: "dot", style: `background:${p.accent}` }),
            h("span", { text: SUBSCRIPTION_NAMES[row.provider] ?? p.name }),
          ),
        );
        if (row.installed) {
          info.append(
            h("div", { class: "setting-desc", style: "color:#22c55e", text: t("{tool} found ✓", { tool: row.tool }) }),
            h("div", {
              class: "setting-desc",
              text: t("Not signed in yet? Run this once in a terminal: {command}", { command: row.signIn }),
            }),
          );
        } else {
          info.append(h("div", { class: "setting-desc", text: t("{tool} not found.", { tool: row.tool }) }));
        }
        if (!row.subscriptionOnly && !row.on) {
          info.append(h("div", { class: "setting-desc", text: t("Off: the chat uses your API key below.") }));
        }
        const controls: HTMLElement[] = row.installed
          ? [sw]
          : [h("button", { text: t("Install it"), onclick: () => void Bridge.openUrl(row.installUrl) }), sw];
        list.append(h("div", { class: "setting-item" }, info, h("div", { class: "setting-control" }, ...controls)));
      }
    });
  };
  void Bridge.subscriptionStatus().then((rows) => draw(rows ?? []));
  return h(
    "section",
    {},
    h("h2", { text: t("Your AI subscriptions") }),
    h("div", {
      class: "hint",
      text: t("Chat on the plan you already pay for. Aira asks your AI's official terminal tool, signed in with your own account: it never sees your password or your key."),
    }),
    list,
  );
}

// ── Claude API section ────────────────────────────────────────────────────────

/** The state line under Claude: the key, else Claude Code (switched on above), else what is missing. */
function apiState(hasKey: boolean, relay: boolean): string {
  if (hasKey) return t("Key saved in the {store}.", { store: KEY_STORE });
  return relay
    ? t("No key: the chat can go through your Claude subscription above.")
    : t("No key yet — the chat needs one.");
}

function apiSection(hasKey: boolean, relay: boolean): HTMLElement {
  const dot = statusDot(hasKey || relay);
  const state = h("span", { class: "hint", text: apiState(hasKey, relay) });

  const field = h("input", {
    type: "password",
    placeholder: hasKey ? `••••••••••••  ${t("(stored)")}` : "sk-ant-...",
    style: "flex:1 1 auto;min-width:0",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;

  const saveBtn = h("button", { class: "primary", text: t("Save key") });
  const clearBtn = h("button", { class: "danger", text: t("Remove") });
  const feedback = h("div", {});

  async function refresh() {
    const present = (await Bridge.secretPresent("anthropic-api-key")) ?? false;
    const ready = (await Bridge.claudeReady()) ?? false;
    dot.style.background = ready ? "#22c55e" : "#f4505e";
    state.textContent = apiState(present, ready && !present);
    field.placeholder = present ? `••••••••••••  ${t("(stored)")}` : "sk-ant-...";
    clearBtn.style.display = present ? "" : "none";
    void model.reload(present);
  }

  saveBtn.addEventListener("click", async () => {
    const value = field.value.trim();
    if (!value) return;
    clear(feedback);
    try {
      await Bridge.secretSet("anthropic-api-key", value);
      field.value = "";
      feedback.append(h("div", { class: "notice ok", text: t("Saved. It never touches disk.") }));
      await refresh();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: t("Could not save: {error}", { error: String(err) }) }));
    }
  });

  clearBtn.addEventListener("click", async () => {
    clear(feedback);
    try {
      await Bridge.secretClear("anthropic-api-key");
      feedback.append(h("div", { class: "notice ok", text: t("Key removed.") }));
      await refresh();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: t("Could not remove: {error}", { error: String(err) }) }));
    }
  });

  const model = claudeModelControl(() => settings.model, async (value) => {
    await Bridge.saveSettings({ ...settings, model: value });
    settings.model = value;
  });
  void model.reload(hasKey);

  clearBtn.style.display = hasKey ? "" : "none";

  return h(
    "section",
    {},
    h("h2", {}, dot, h("span", { text: "Claude" })),
    state,
    h("div", { class: "row" }, h("label", { text: t("API key") }), secretField(field), saveBtn, clearBtn),
    model.element,
    feedback,
  );
}

// ── Active pills section ──────────────────────────────────────────────────────

/**
 * The tools you use (Mac 0.1.1–0.1.2): pick the main workspace tool, which is
 * always on and takes no slot, and declare the agents and chat providers you
 * want as pills. Services are declared in Integrations below, next to their keys.
 */
function activePillsSection(connected: Record<string, boolean>): HTMLElement {
  const slots = h("div", { class: "hint" });
  const main = h("select", {}) as HTMLSelectElement;
  for (const def of mainPillChoices()) main.append(h("option", { value: def.id, text: def.name }));
  main.addEventListener("change", () => {
    const next = chooseMainPill(settings, main.value);
    if (!next) return;
    settings.mainPill = next.mainPill;
    settings.activeIntegrations = next.activeIntegrations;
    declaredChanged();
  });
  const groups = h("div", { style: "display:flex;flex-direction:column;gap:12px" });

  /** Why a pill would show nothing yet, as on the Mac's row. */
  function hint(def: PillDefinition): string | null {
    if (isComingSoon(def.id)) return t("Coming soon");
    if (def.connect.kind === "hooks" && !connected[def.id]) return t("Hooks not installed");
    if (def.connect.kind === "key" && !connected[def.id]) return t("Key not configured");
    if (def.connect.kind === "server" && !settings[def.connect.field]) return t("Not connected");
    return null;
  }

  function airadoroControls(): HTMLElement {
    const workM = loadStoredMinutes(AIRADORO_STORAGE_WORK, DEFAULT_WORK_MINUTES);
    const restM = loadStoredMinutes(AIRADORO_STORAGE_REST, DEFAULT_REST_MINUTES);

    const workInput = h("input", {
      type: "number",
      min: "1",
      max: "60",
      value: String(workM),
      style: "width:52px;text-align:center",
    }) as HTMLInputElement;

    const restInput = h("input", {
      type: "number",
      min: "1",
      max: "60",
      value: String(restM),
      style: "width:52px;text-align:center",
    }) as HTMLInputElement;

    workInput.addEventListener("change", () => {
      saveStoredMinutes(AIRADORO_STORAGE_WORK, parseInt(workInput.value, 10));
    });

    restInput.addEventListener("change", () => {
      saveStoredMinutes(AIRADORO_STORAGE_REST, parseInt(restInput.value, 10));
    });

    return h("div", { class: "row", style: "align-items:center;gap:8px;padding:4px 0 6px 20px" },
      h("label", { style: "min-width:auto;color:var(--dim-2);font-size:12px", text: t("Work") }),
      workInput,
      h("span", { style: "font-size:11px;color:var(--dim-2)", text: t("min") }),
      h("label", { style: "min-width:auto;margin-left:14px;color:var(--dim-2);font-size:12px", text: t("Rest") }),
      restInput,
      h("span", { style: "font-size:11px;color:var(--dim-2)", text: t("min") }),
    );
  }

  function row(def: PillDefinition): HTMLElement {
    const isMain = def.id === settings.mainPill;
    const on = settings.activeIntegrations.includes(def.id);
    const el = h("div", { class: "pill-row" },
      colorDot(def, "width:10px;height:10px", () => settings.pillColors, pickColor),
      h("span", { class: "name", text: def.name }),
    );
    if (isMain) {
      el.append(h("span", { class: "state", text: t("Main") }));
      return el;
    }
    const why = hint(def);
    el.append(h("span", { class: "state", text: why ?? "" }));
    const sw = h("button", { class: on ? "switch on" : "switch" }) as HTMLButtonElement;
    sw.addEventListener("click", () => {
      const next = toggleDeclared(settings, def.id);
      if (!next) return;
      settings.activeIntegrations = next;
      declaredChanged();
    });
    el.append(sw);
    if (def.id === "integration_airadoro") {
      return h("div", { style: "display:flex;flex-direction:column" }, el, airadoroControls());
    }
    return el;
  }

  function draw() {
    preserveScroll(groups, () => {
      const used = settings.activeIntegrations.length;
      slots.textContent = t("{count} active — the main tool stays active.", { count: used });
      slots.classList.remove("full");
      main.value = settings.mainPill;
      clear(groups);
      for (const cat of PILL_CATEGORIES) {
        const pills = availablePills().filter((p) => p.category === cat.id);
        if (pills.length === 0) continue;
        groups.append(h("div", { class: "pill-group" }, h("h3", { text: t(cat.title) }), ...pills.map(row)));
      }
    });
  }
  declaredViews.push(draw);
  draw();

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: t("Active pills") })),
    h("div", { class: "hint", text: t("Choose the tools you use. Aira only shows what you declare here.") }),
    slots,
    h("div", { class: "row" }, h("label", { text: t("Main tool") }), main),
    groups,
  );
}

// ── Chat providers section ────────────────────────────────────────────────────

const CHAT_STRINGS = {
  get providersTitle() { return t("Chat providers"); },
  get providersHint() { return t("Chat with Google AI, OpenAI or OpenRouter instead of Claude: add a key here, then click the model name above the chat box to switch provider and model. Keys stay in the system keychain. These providers get no web search and no tools: they can answer, never act on this computer."); },
  get stored() { return `••••••••  ${t("(stored)")}`; },
  get save() { return t("Save"); },
  get remove() { return t("Remove"); },
  get localTitle() { return t("Local models"); },
  get localHint() { return t("Chat with a model you run yourself: Ollama or LM Studio (leave the address empty for the usual one on this computer), or any server that speaks the OpenAI API, such as vLLM or llama.cpp. Once connected, pick it above the chat box."); },
  get connect() { return t("Connect"); },
  get connecting() { return t("Connecting…"); },
  get disconnect() { return t("Disconnect"); },
  get useInChat() { return t("Use in chat"); },
  get inUse() { return t("In use"); },
  get keyOptional() { return t("API key (optional)"); },
  get localOnly() { return t("Nothing leaves your PC: the server runs on this computer."); },
  get remote() { return t("This address is another machine: what you ask is sent to it."); },
  get remoteHttp() { return t("This address is another machine, over plain http: what you ask travels unencrypted."); },
  get keyOverHttp() { return t("Warning: the key would be sent unencrypted (http://) to another machine. Use https://, or a server on this computer."); },
  get invalid() { return t("Not a valid http:// or https:// address."); },
  noModels: (name: string) => t("No models yet. Download one in {name} first.", { name }),
  models: (n: number) => tn("{count} model", "{count} models", n),
};

interface CloudDef {
  id: "google" | "openai" | "openrouter";
  name: string;
  placeholder: string;
  where: string;
}

const CLOUD: CloudDef[] = [
  { id: "google", name: "Google AI", placeholder: "AIza…", where: "aistudio.google.com" },
  { id: "openai", name: "OpenAI", placeholder: "sk-…", where: "platform.openai.com" },
  { id: "openrouter", name: "OpenRouter", placeholder: "sk-or-…", where: "openrouter.ai/keys" },
];

function chatProvidersSection(
  present: Record<string, boolean>,
  keyChanged: (key: string, on: boolean) => void,
): HTMLElement {
  const list = h("div", { class: "setting-list" });
  for (const def of CLOUD) {
    const p = providerDef(def.id);
    const key = p.key!;
    const input = h("input", {
      type: "password",
      placeholder: present[key] ? CHAT_STRINGS.stored : def.placeholder,
      autocomplete: "off",
      spellcheck: "false",
      style: "flex:1 1 auto;min-width:0",
    }) as HTMLInputElement;
    const dotEl = statusDot(present[key] ?? false);
    const saveBtn = h("button", { text: CHAT_STRINGS.save });
    const removeBtn = h("button", { class: "danger", text: CHAT_STRINGS.remove });
    const refresh = () => {
      input.placeholder = present[key] ? CHAT_STRINGS.stored : def.placeholder;
      dotEl.style.background = present[key] ? "#22c55e" : "#f4505e";
      removeBtn.style.display = present[key] ? "" : "none";
    };
    saveBtn.addEventListener("click", async () => {
      const value = input.value.trim();
      if (!value) return;
      try {
        await Bridge.secretSet(key, value);
        present[key] = true;
        input.value = "";
        keyChanged(key, true);
      } catch {
        dotEl.style.background = "#f5a524";
        return;
      }
      refresh();
    });
    removeBtn.addEventListener("click", async () => {
      try {
        await Bridge.secretClear(key);
        present[key] = false;
        keyChanged(key, false);
      } catch {
        dotEl.style.background = "#f5a524";
        return;
      }
      refresh();
    });
    refresh();
    list.append(
      h("div", { class: "setting-item" },
        h("div", { class: "setting-info" },
          h("div", { class: "setting-title" },
            h("i", { class: "dot", style: `background:${p.accent}` }),
            h("span", { text: def.name }),
          ),
          h("div", { class: "setting-desc", text: t("Key from {site}", { site: def.where }) }),
        ),
        h("div", { class: "setting-control wide" }, input, saveBtn, removeBtn, dotEl),
      ),
    );
  }
  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: CHAT_STRINGS.providersTitle })),
    h("div", { class: "hint", text: CHAT_STRINGS.providersHint }),
    list,
  );
}

// ── Local models section ──────────────────────────────────────────────────────

type LocalId = "ollama" | "lmstudio" | "custom";

/** Redraws the local models section after a change made elsewhere (the island). */
let localRedraw: (() => void) | null = null;

const LOCAL: Record<LocalId, { name: string; usual: string }> = {
  ollama: { name: "Ollama", usual: "http://127.0.0.1:11434" },
  lmstudio: { name: "LM Studio", usual: "http://127.0.0.1:1234" },
  // No usual address: any server that speaks the OpenAI API.
  custom: { name: N_("OpenAI-compatible"), usual: "" },
};

/** What an address means for the user's data, as a hint line. */
function exposureNotice(url: string, withKey: boolean): HTMLElement | null {
  switch (urlExposure(url)) {
    case "local":
      return h("div", { class: "hint", text: CHAT_STRINGS.localOnly });
    case "remote":
      return h("div", { class: "hint", text: CHAT_STRINGS.remote });
    case "remote-http":
      return withKey
        ? h("div", { class: "notice warn", text: CHAT_STRINGS.keyOverHttp })
        : h("div", { class: "hint", text: CHAT_STRINGS.remoteHttp });
    case "invalid":
      return url.trim() ? h("div", { class: "notice err", text: CHAT_STRINGS.invalid }) : null;
  }
}

function localSection(customKey: boolean): HTMLElement {
  const body = h("div", { class: "setting-list" });
  const section = h(
    "section",
    {},
    h("h2", {}, h("span", { text: CHAT_STRINGS.localTitle })),
    h("div", { class: "hint", text: CHAT_STRINGS.localHint }),
    body,
  );
  const redraw = () => {
    clear(body);
    for (const id of Object.keys(LOCAL) as LocalId[]) body.append(serverBlock(id));
  };

  function serverBlock(id: LocalId): HTMLElement {
    const def = LOCAL[id];
    const p = providerDef(id);
    const field = p.urlField!;
    const connected = settings[field] !== "";
    const status = h("div", {});
    const exposure = h("div", {});
    const label = h("label", {},
      h("i", { class: "dot", style: `background:${p.accent};margin-right:8px` }),
      h("span", { text: t(def.name) }),
    );
    const block = h("div", { class: "setting-block" });

    if (connected) {
      const inUse = settings.chatProvider === id;
      const use = h("button", { class: inUse ? "" : "primary", text: inUse ? CHAT_STRINGS.inUse : CHAT_STRINGS.useInChat });
      use.disabled = inUse;
      use.addEventListener("click", () => {
        settings.chatProvider = id;
        void save().then(redraw);
      });
      const disconnect = h("button", { class: "danger", text: CHAT_STRINGS.disconnect });
      disconnect.addEventListener("click", async () => {
        settings[field] = "";
        if (settings.chatProvider === id) settings.chatProvider = "anthropic";
        if (id === "custom") {
          await Bridge.secretClear(CUSTOM_SERVER_KEY).catch(() => { });
          customKey = false;
        }
        await save();
        redraw();
      });
      block.append(
        h("div", { class: "row" }, label, h("span", { class: "path", text: settings[field] }), statusDot(true), use, disconnect),
        status,
      );
      exposure.append(exposureNotice(settings[field], id === "custom" && customKey) ?? "");
      block.append(exposure);
      return block;
    }

    const input = h("input", {
      type: "text",
      placeholder: def.usual || "https://llm.example.com",
      style: "flex:1 1 auto;min-width:0",
      spellcheck: "false",
      autocomplete: "off",
    }) as HTMLInputElement;
    // A custom server may want a key; it goes to the keychain, never to settings.json.
    const key = h("input", {
      type: "password",
      placeholder: customKey ? CHAT_STRINGS.stored : CHAT_STRINGS.keyOptional,
      style: "flex:1 1 auto;min-width:0",
      autocomplete: "off",
      spellcheck: "false",
    }) as HTMLInputElement;
    const connect = h("button", { class: "primary", text: CHAT_STRINGS.connect });

    const showExposure = () => {
      clear(exposure);
      const withKey = id === "custom" && (customKey || key.value.trim() !== "");
      const notice = exposureNotice(input.value || def.usual, withKey);
      if (notice) exposure.append(notice);
    };
    input.addEventListener("input", showExposure);
    key.addEventListener("input", showExposure);

    connect.addEventListener("click", async () => {
      connect.disabled = true;
      clear(status);
      status.append(h("div", { class: "hint", text: CHAT_STRINGS.connecting }));
      try {
        if (id === "custom" && key.value.trim()) {
          // Stored with this address: the key is only ever sent there.
          await Bridge.localSetKey(input.value || def.usual, key.value.trim());
          key.value = "";
          customKey = true;
        }
        const server = await Bridge.localConnect(id, input.value);
        if (!server.models.length) {
          clear(status);
          status.append(h("div", { class: "notice err", text: CHAT_STRINGS.noModels(t(def.name)) }));
        } else {
          settings[field] = server.url;
          if (!server.models.includes(settings.chatModels[id] ?? "")) {
            settings.chatModels = { ...settings.chatModels, [id]: server.models[0] };
          }
          await save();
          redraw();
          return;
        }
      } catch (err) {
        clear(status);
        status.append(h("div", { class: "notice err", text: String(err).replace(/^Error:\s*/, "") }));
      }
      connect.disabled = false;
    });

    block.append(h("div", { class: "row" }, label, input, connect));
    if (id === "custom") block.append(h("div", { class: "row" }, h("label", { text: "" }), key));
    block.append(status, exposure);
    showExposure();
    return block;
  }

  redraw();
  localRedraw = redraw;
  return section;
}

// ── Integrations section ──────────────────────────────────────────────────────

interface IntegrationDef {
  id: string;
  name: string;
  color: string;
  /** Credential Manager keys, in the order they are shown. */
  fields: { key: string; label: string; placeholder: string; secret: boolean }[];
  /** What the key needs, shown under its field. */
  hint?: string;
}

const INTEGRATIONS: IntegrationDef[] = [
  {
    id: "integration_stripe", name: "Stripe", color: "#0570DE",
    fields: [{ key: "stripe-api-key", label: N_("Secret key"), placeholder: "sk_live_…", secret: true }]
  },
  {
    id: "integration_github", name: "GitHub", color: "#F4505E",
    fields: [{ key: "github-token", label: N_("Token"), placeholder: "ghp_…", secret: true }],
    hint: N_("Classic token with the repo scope, or fine-grained with read access to Pull requests, Commit statuses and Actions.")
  },
  {
    id: "integration_gitlab", name: "GitLab", color: "#FC6D26",
    fields: [
      { key: "gitlab-url", label: N_("Instance URL"), placeholder: "https://gitlab.com", secret: false },
      { key: "gitlab-token", label: N_("Token"), placeholder: "glpat-…", secret: true },
    ],
    hint: N_("Personal access token with read_api and read_user scopes.")
  },
  {
    id: "integration_gitea", name: "Gitea", color: "#609926",
    fields: [
      { key: "gitea-url", label: N_("Instance URL"), placeholder: "https://gitea.example.com", secret: false },
      { key: "gitea-token", label: N_("Token"), placeholder: "…", secret: true },
    ]
  },
  {
    id: "integration_vercel", name: "Vercel", color: "#7C5CFF",
    fields: [{ key: "vercel-token", label: N_("Token"), placeholder: "…", secret: true }]
  },
  {
    id: "integration_n8n", name: "n8n", color: "#F29B38",
    fields: [
      { key: "n8n-url", label: N_("Instance URL"), placeholder: "https://n8n.example.com", secret: false },
      { key: "n8n-api-key", label: N_("API key"), placeholder: "…", secret: true },
    ]
  },
  {
    id: "integration_resend", name: "Resend", color: "#22C55E",
    fields: [{ key: "resend-api-key", label: N_("API key"), placeholder: "re_…", secret: true }]
  },
  {
    id: "integration_notion", name: "Notion", color: "#8C8C8C",
    fields: [{ key: "notion-api-key", label: N_("Integration token"), placeholder: "ntn_…", secret: true }]
  },
  {
    id: "integration_calcom", name: "Cal.com", color: "#C9956A",
    fields: [{ key: "calcom-api-key", label: N_("API key"), placeholder: "cal_…", secret: true }]
  },
  // Nothing to enter: Spotify is read from the OS (src-tauri/src/spotify.rs).
  { id: "integration_spotify", name: "Spotify", color: "#1DB954", fields: [] },
];

/** Everything that shows the declared pills, redrawn when any of them changes. */
const declaredViews: (() => void)[] = [];

function declaredChanged() {
  for (const redraw of declaredViews) redraw();
  void save();
}

function integrationsSection(present: Record<string, boolean>): HTMLElement {
  const note = h("div", { class: "hint" });
  const list = h("div", { style: "display:flex;flex-direction:column;gap:14px" });

  function updateNote() {
    const used = settings.activeIntegrations.length;
    note.textContent = t("{count} active. Keys are stored in the {store}, never on disk.", { count: used, store: KEY_STORE });
  }
  declaredViews.push(updateNote);

  const offered = new Set(availablePills().map((p) => p.id));
  for (const def of INTEGRATIONS.filter((d) => offered.has(d.id))) {
    const active = settings.activeIntegrations.includes(def.id);
    const sw = h("button", { class: active ? "switch on" : "switch" });
    sw.addEventListener("click", () => {
      const on = settings.activeIntegrations.includes(def.id);
      if (on) {
        settings.activeIntegrations = settings.activeIntegrations.filter((x) => x !== def.id);
      } else {
        settings.activeIntegrations = [...settings.activeIntegrations, def.id];
      }
      sw.classList.toggle("on", !on);
      declaredChanged();
    });

    const rows = h("div", { style: "display:flex;flex-direction:column;gap:6px;flex:1 1 auto;min-width:0" });
    for (const field of def.fields) {
      const input = h("input", {
        type: field.secret ? "password" : "text",
        placeholder: present[field.key] ? CHAT_STRINGS.stored : field.placeholder,
        autocomplete: "off",
        spellcheck: "false",
        style: "flex:1 1 auto;min-width:0",
      }) as HTMLInputElement;
      const saveBtn = h("button", { text: t("Save") });
      const dotEl = statusDot(present[field.key] ?? false);
      saveBtn.addEventListener("click", async () => {
        const value = input.value.trim();
        try {
          await Bridge.secretSet(field.key, value);
          present[field.key] = value.length > 0;
          input.value = "";
          input.placeholder = value ? CHAT_STRINGS.stored : field.placeholder;
          dotEl.style.background = value ? "#22c55e" : "#f4505e";
        } catch {
          dotEl.style.background = "#f5a524";
        }
      });
      rows.append(
        h("div", { class: "row" },
          h("label", { style: "min-width:104px", text: t(field.label) }),
          field.secret ? secretField(input) : input, saveBtn, dotEl,
        ),
      );
    }

    if (def.hint) rows.append(h("div", { class: "hint", text: t(def.hint) }));
    if (def.id === "integration_spotify") {
      // As on the Mac's row: said only when there is no Spotify to launch.
      const hint = h("div", { class: "hint", style: "padding-top:5px" });
      rows.append(hint);
      void Bridge.spotifyInstalled().then((ok) => {
        hint.textContent = ok === false ? t("Not installed") : "";
      });
    }

    list.append(
      h("div", { style: "display:flex;gap:12px;align-items:flex-start" },
        h("div", { style: "display:flex;align-items:center;gap:8px;min-width:132px;padding-top:4px" },
          sw,
          colorDot(def, "", () => settings.pillColors, pickColor),
          h("span", { style: "font-size:12.5px", text: def.name }),
        ),
        rows,
      ),
    );
  }

  updateNote();
  return h("section", {}, h("h2", {}, h("span", { text: t("Integrations") })), note, list);
}

/** WhatsApp (experimental), under the other integrations: its pill is turned on from its own switch. */
function whatsappSections(): HTMLElement[] {
  if (!availablePills().some((p) => p.id === WHATSAPP_ID)) return [];
  return [whatsappSection({
    toggle,
    pillActive: () => settings.activeIntegrations.includes(WHATSAPP_ID),
    setPill: (on) => {
      const has = settings.activeIntegrations.includes(WHATSAPP_ID);
      if (on && !has) {
        settings.activeIntegrations = [...settings.activeIntegrations, WHATSAPP_ID];
      } else if (!on && has) {
        settings.activeIntegrations = settings.activeIntegrations.filter((x) => x !== WHATSAPP_ID);
      } else {
        return;
      }
      declaredChanged();
    },
  })];
}

// ── General section ───────────────────────────────────────────────────────────

/**
 * Puts the General fields back in line with the settings after a change made
 * elsewhere (the island's own settings change sound, volume and auto-close).
 */
let generalSync: (() => void) | null = null;

function settingItem(title: string, desc: string | null, ...controls: HTMLElement[]): HTMLElement {
  const info = h("div", { class: "setting-info" }, h("div", { class: "setting-title", text: title }));
  if (desc) info.append(h("div", { class: "setting-desc", text: desc }));
  return h("div", { class: "setting-item" }, info, h("div", { class: "setting-control" }, ...controls));
}

function generalSections(): HTMLElement[] {
  const volumePercent = h("span", {
    style: "font-size:11.5px;color:var(--dim);min-width:38px;text-align:right",
    text: `${Math.round((settings.soundVolume / 0.2) * 100)}%`,
  });
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    value: String(settings.soundVolume),
  }) as HTMLInputElement;
  volume.addEventListener("input", () => {
    settings.soundVolume = Number(volume.value);
    volumePercent.textContent = `${Math.round((settings.soundVolume / 0.2) * 100)}%`;
    saveDebounced();
  });
  volume.addEventListener("change", () => {
    settings.soundVolume = Number(volume.value);
    void save();
  });

  // Your own sounds: the folder, a reload, and how many are replaced.
  const customCount = h("span", { class: "hint" });
  const countCustom = () =>
    void Bridge.customSounds(SOUND_NAMES).then((own) => {
      const n = own?.length ?? 0;
      customCount.textContent = n > 0 ? t("{0} custom", { 0: n }) : "";
    });
  countCustom();
  const soundsFolder = h("button", { text: t("Open sounds folder"), onclick: () => void Bridge.revealSoundsFolder() });
  const reloadSounds = h("button", {
    text: t("Reload sounds"),
    onclick: () => void Bridge.reloadSounds().then(() => window.setTimeout(countCustom, 300)),
  });

  const autoClose = h("input", {
    type: "number", min: "5", max: "120", step: "1",
    value: String(Math.round(settings.autoCloseInterval)),
    style: "width:64px;text-align:center",
  }) as HTMLInputElement;
  autoClose.addEventListener("change", () => {
    settings.autoCloseInterval = Math.max(5, Math.min(120, Number(autoClose.value) || 15));
    autoClose.value = String(settings.autoCloseInterval);
    void save();
    updateAutoCloseChips();
  });

  const autoCloseChips = h("div", { class: "preset-chips" });
  const chipButtons: { sec: number; el: HTMLElement }[] = [];
  function updateAutoCloseChips() {
    const cur = settings.autoCloseInterval;
    for (const { sec, el } of chipButtons) {
      el.classList.toggle("on", sec === cur);
    }
  }

  for (const sec of [5, 15, 30, 60]) {
    const chip = h("button", {
      type: "button",
      class: "preset-chip",
      text: `${sec}s`,
      onclick: () => {
        settings.autoCloseInterval = sec;
        autoClose.value = String(sec);
        void save();
        updateAutoCloseChips();
      },
    });
    chipButtons.push({ sec, el: chip });
    autoCloseChips.append(chip);
  }
  updateAutoCloseChips();

  // The closed island (core/closed.ts): what stays at the top of the screen.
  const closed = h("select", {}) as HTMLSelectElement;
  closed.append(
    h("option", { value: "mochi", text: t("Mochi, as on a Mac without a notch") }),
    h("option", { value: "time", text: t("The time") }),
    h("option", { value: "datetime", text: t("The date and the time") }),
    h("option", { value: "claude", text: t("Claude usage") }),
    h("option", { value: "music", text: t("What's playing") }),
    h("option", { value: "empty", text: t("Nothing, just the island") }),
    h("option", { value: "hidden", text: t("Hide the island") }),
  );
  closed.value = closedIsland(settings.closedIsland);
  closed.addEventListener("change", () => {
    settings.closedIsland = closed.value;
    void save();
  });

  const screen = h("select", {}) as HTMLSelectElement;
  screen.append(
    h("option", { value: "primary", text: t("Main display") }),
    h("option", { value: "cursor", text: t("Display under the cursor") }),
  );
  screen.value = settings.screen;
  void Bridge.listMonitors().then((list) => {
    for (const m of list ?? []) screen.append(h("option", { value: m.key, text: m.label }));
    // Set again now the option exists. A display saved under an older key (moved,
    // resized, or saved before names were kept) is shown by its place or its
    // name; one that is gone shows as the main one.
    const saved = settings.screen;
    const [place, name] = saved.split("|");
    const keys = (list ?? []).map((m) => m.key);
    screen.value =
      keys.find((k) => k === saved) ??
      (saved.startsWith("at:") ? keys.find((k) => k.split("|")[0] === place) : undefined) ??
      (name ? keys.find((k) => k.split("|")[1] === name) : undefined) ??
      saved;
    if (!screen.value) screen.value = "primary";
  });
  screen.addEventListener("change", () => {
    settings.screen = screen.value;
    void save();
  });

  const positionCtrl = segmentedControl(
    [
      ["top", t("Top center")],
      ["topLeft", t("Top left")],
      ["topRight", t("Top right")],
    ],
    settings.islandPosition || "top",
    (val) => {
      settings.islandPosition = val;
      void save();
    },
  );

  const scaleCtrl = segmentedControl(
    [
      ["compact", t("Compact (90%)")],
      ["normal", t("Standard (100%)")],
      ["large", t("Large (110%)")],
    ],
    settings.islandScale || "normal",
    (val) => {
      settings.islandScale = val;
      void save();
    },
  );

  const isGlass = () => (settings.islandStyle || "glass") !== "solid";
  const glassToggle = toggle(isGlass(), (v) => {
    settings.islandStyle = v ? "glass" : "solid";
    syncGlassTintState();
    void save();
  });

  const clampTint = (n: number) => Math.max(10, Math.min(100, Math.round(n / 10) * 10));
  const tintValueEl = h("span", { class: "tint-stepper-val", text: `${clampTint(settings.glassTint ?? 50)}%` });
  const tintMinus = h("button", {
    type: "button",
    class: "tint-stepper-btn",
    text: "−",
    onclick: () => {
      const next = clampTint((settings.glassTint ?? 50) - 10);
      settings.glassTint = next;
      tintValueEl.textContent = `${next}%`;
      void save();
    },
  }) as HTMLButtonElement;
  const tintPlus = h("button", {
    type: "button",
    class: "tint-stepper-btn",
    text: "+",
    onclick: () => {
      const next = clampTint((settings.glassTint ?? 50) + 10);
      settings.glassTint = next;
      tintValueEl.textContent = `${next}%`;
      void save();
    },
  }) as HTMLButtonElement;
  const tintStepper = h("div", { class: "tint-stepper" }, tintMinus, tintValueEl, tintPlus);

  const makeStylePreviewCard = (
    kind: "notch" | "slim" | "island",
    titleText: string,
    descText: string,
  ) => {
    const eyes = h(
      "span",
      { class: "notch-preview-eyes" },
      h("span", { class: "notch-preview-eye" }),
      h("span", { class: "notch-preview-eye" }),
    );
    const pill =
      kind === "slim"
        ? h("div", { class: "notch-preview-pill slim" })
        : h("div", { class: `notch-preview-pill ${kind}` }, eyes);
    const screen = h("div", { class: "notch-preview-screen" }, pill);
    const check = h("span", { class: "notch-style-check", text: "✓" });
    const meta = h(
      "div",
      { class: "notch-style-meta" },
      h("div", { class: "notch-style-title-row" }, h("span", { class: "notch-style-title", text: titleText }), check),
      h("div", { class: "notch-style-desc", text: descText }),
    );
    const btn = h(
      "button",
      {
        type: "button",
        class: "notch-style-card",
        onclick: () => {
          settings.islandShape = kind;
          syncStyleCards();
          void save();
        },
      },
      screen,
      meta,
    ) as HTMLButtonElement;
    return btn;
  };
  const classicCard = makeStylePreviewCard("notch", t("Classic"), t("Joined to the top edge"));
  const slimCard = makeStylePreviewCard("slim", t("Slim"), t("Thin bar at the top edge"));
  const floatingCard = makeStylePreviewCard("island", t("Floating"), t("Floats just below the top edge"));
  const syncStyleCards = () => {
    const shape = settings.islandShape || "notch";
    classicCard.classList.toggle("on", shape !== "slim" && shape !== "island");
    slimCard.classList.toggle("on", shape === "slim");
    floatingCard.classList.toggle("on", shape === "island");
  };
  syncStyleCards();
  const styleCardsGrid = h("div", { class: "notch-style-grid" }, classicCard, slimCard, floatingCard);

  const openNotchCtrl = segmentedControl(
    [
      ["hover", t("Hover")],
      ["click", t("Click")],
    ],
    settings.openOnHover ? "hover" : "click",
    (val) => {
      settings.openOnHover = val === "hover";
      void save();
    },
  );
  const pageIconsToggle = toggle(settings.pageIcons !== false, (v) => {
    settings.pageIcons = v;
    void save();
  });
  const animSpeedCtrl = segmentedControl(
    [
      ["normal", t("Normal")],
      ["fast", t("Fast")],
    ],
    settings.animationSpeed === "fast" ? "fast" : "normal",
    (val) => {
      settings.animationSpeed = val;
      void save();
    },
  );

  const sound = toggle(settings.soundEnabled, (v) => { settings.soundEnabled = v; void save(); });
  const autostart = toggle(settings.autostart, (v) => { settings.autostart = v; void save(); });

  const ensureTune = (): MochiTune => {
    if (!settings.mochiTune) settings.mochiTune = { ...DEFAULT_MOCHI_TUNE };
    return settings.mochiTune;
  };
  const robotSound = toggle(ensureTune().robotSound, (v) => {
    ensureTune().robotSound = v;
    void save();
  });

  const EYE_COLORS: { val: string; bg: string; label: string }[] = [
    { val: "", bg: "#EEF2F6", label: t("Auto") },
    { val: "#7DD3FC", bg: "#7DD3FC", label: t("Cyan") },
    { val: "#6EE7B7", bg: "#6EE7B7", label: t("Mint") },
    { val: "#FDE68A", bg: "#FDE68A", label: t("Amber") },
    { val: "#FDA4AF", bg: "#FDA4AF", label: t("Rose") },
  ];
  const colorWrap = h("div", { class: "segmented", style: "gap:6px; padding:4px 6px;" });
  const colorBtns: { val: string; el: HTMLButtonElement }[] = [];
  const syncColorBtns = () => {
    const cur = ensureTune().eyeColor || "";
    for (const b of colorBtns) {
      b.el.style.outline = cur === b.val ? "2px solid var(--fg, #fff)" : "none";
      b.el.style.outlineOffset = "2px";
    }
  };
  for (const c of EYE_COLORS) {
    const btn = h("button", {
      type: "button",
      title: c.label,
      style: `width:18px;height:18px;border-radius:999px;border:1px solid rgba(255,255,255,0.25);background:${c.bg};cursor:pointer;padding:0;`,
      onclick: () => {
        ensureTune().eyeColor = c.val;
        syncColorBtns();
        void save();
      },
    }) as HTMLButtonElement;
    colorBtns.push({ val: c.val, el: btn });
    colorWrap.append(btn);
  }
  syncColorBtns();

  type NumTuneKey = "eyeScale" | "blinkRate" | "drift" | "overshoot" | "sacThresh" | "antic";
  const tuneSliders: { key: NumTuneKey; input: HTMLInputElement; label: HTMLElement; fmt: (v: number) => string }[] = [];
  const makeTuneSlider = (
    key: NumTuneKey,
    min: number, max: number, step: number,
    fmt: (v: number) => string = (v) => v.toFixed(step < 1 ? 1 : 0),
  ) => {
    const val = ensureTune()[key];
    const lbl = h("span", { class: "hint", text: fmt(val), style: "min-width:38px;text-align:right;" });
    const input = h("input", { type: "range", min: String(min), max: String(max), step: String(step) }) as HTMLInputElement;
    input.value = String(val);
    input.addEventListener("input", () => {
      const n = Number(input.value);
      ensureTune()[key] = n;
      lbl.textContent = fmt(n);
    });
    input.addEventListener("change", () => { void save(); });
    tuneSliders.push({ key, input, label: lbl, fmt });
    return [input, lbl] as const;
  };

  const [eyeScaleIn, eyeScaleLbl] = makeTuneSlider("eyeScale", 0.8, 1.3, 0.05, (v) => `${Math.round(v * 100)}%`);
  const [blinkRateIn, blinkRateLbl] = makeTuneSlider("blinkRate", 0.4, 2.5, 0.1, (v) => `${v.toFixed(1)}x`);
  const [driftIn, driftLbl] = makeTuneSlider("drift", 0, 2.5, 0.1);
  const [overshootIn, overshootLbl] = makeTuneSlider("overshoot", 0, 3.0, 0.1);
  const [sacThreshIn, sacThreshLbl] = makeTuneSlider("sacThresh", 6, 30, 1);
  const [anticIn, anticLbl] = makeTuneSlider("antic", 0, 16, 1);

  const resetTune = h("button", {
    type: "button",
    text: t("Reset to defaults"),
    onclick: () => {
      settings.mochiTune = { ...DEFAULT_MOCHI_TUNE };
      generalSync?.();
      void save();
    },
  });

  let glassTintRow!: HTMLElement;
  const syncGlassTintState = () => {
    const on = isGlass();
    if (glassTintRow) {
      glassTintRow.style.opacity = on ? "1" : "0.45";
      glassTintRow.style.pointerEvents = on ? "auto" : "none";
    }
    tintMinus.disabled = !on;
    tintPlus.disabled = !on;
  };

  generalSync = () => {
    setSwitch(sound, settings.soundEnabled);
    setSwitch(autostart, settings.autostart);
    positionCtrl.setValue(settings.islandPosition || "top");
    scaleCtrl.setValue(settings.islandScale || "normal");
    syncStyleCards();
    syncInfoCards();
    setSwitch(glassToggle, isGlass());
    tintValueEl.textContent = `${clampTint(settings.glassTint ?? 50)}%`;
    syncGlassTintState();
    openNotchCtrl.setValue(settings.openOnHover ? "hover" : "click");
    setSwitch(pageIconsToggle, settings.pageIcons !== false);
    animSpeedCtrl.setValue(settings.animationSpeed === "fast" ? "fast" : "normal");
    setSwitch(robotSound, ensureTune().robotSound);
    syncColorBtns();
    for (const sl of tuneSliders) {
      if (document.activeElement !== sl.input) {
        const v = ensureTune()[sl.key];
        sl.input.value = String(v);
        sl.label.textContent = sl.fmt(v);
      }
    }
    // A field being edited keeps what is in it; it catches up when it is left.
    if (document.activeElement !== volume) {
      volume.value = String(settings.soundVolume);
      volumePercent.textContent = `${Math.round((settings.soundVolume / 0.2) * 100)}%`;
    }
    if (document.activeElement !== autoClose) {
      autoClose.value = String(Math.round(settings.autoCloseInterval));
      updateAutoCloseChips();
    }
  };
  volume.addEventListener("blur", () => generalSync?.());
  autoClose.addEventListener("blur", () => generalSync?.());

  const card = (heading: string, ...items: HTMLElement[]) =>
    h("section", {}, h("h2", {}, h("span", { text: heading })), h("div", { class: "setting-list" }, ...items));

  glassTintRow = settingItem(t("Glass tint"), null, tintStepper);
  syncGlassTintState();

  const resetNotchBtn = h("button", {
    type: "button",
    class: "section-reset-btn",
    text: t("Reset to defaults"),
    onclick: () => {
      settings.islandShape = "notch";
      settings.islandStyle = "glass";
      settings.glassTint = 50;
      settings.openOnHover = false;
      settings.pageIcons = true;
      settings.alertsFromAllPills = false;
      settings.autoCloseInterval = 15;
      settings.animationSpeed = "normal";
      settings.islandPosition = "top";
      settings.islandScale = "normal";
      settings.showClock = false;
      settings.closedIsland = "mochi";
      settings.compactMusic = true;
      settings.compactAgenda = true;
      settings.compactAiradoro = true;
      settings.compactPlan = true;
      settings.compactWeather = true;
      generalSync?.();
      void save();
    },
  });

  const notchStyleCard = h(
    "section",
    {},
    h("h2", {}, h("span", { text: t("Notch style") }), h("span", { class: "spacer" }), resetNotchBtn),
    h(
      "div",
      { class: "setting-list" },
      styleCardsGrid,
      settingItem(t("Glass"), t("Frosted glass behind the open notch"), glassToggle),
      glassTintRow,
    ),
  );

  type CompactInfoKey =
    | "compactMusic"
    | "compactAgenda"
    | "compactAiradoro"
    | "compactPlan"
    | "compactWeather"
    | "featureUpload"
    | "featureChat"
    | "featureAgents"
    | "featureClipboard"
    | "featureMail"
    | "featureConvert"
    | "featureCamera";
  const makeInfoPreviewCard = (
    key: CompactInfoKey,
    titleText: string,
    previewEl: HTMLElement,
  ) => {
    const badge = h("span", { class: "notch-info-check", text: "✓" });
    const screen = h("div", { class: "notch-info-screen" }, previewEl, badge);
    const labelEl = h("div", { class: "notch-info-title", text: titleText });
    const btn = h(
      "button",
      {
        type: "button",
        class: "notch-info-card",
        onclick: () => {
          settings[key] = settings[key] === false;
          syncInfoCards();
          void save();
        },
      },
      screen,
      labelEl,
    ) as HTMLButtonElement;
    return { key, btn };
  };

  function miniPin(): SVGSVGElement {
    const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    el.setAttribute("viewBox", "0 0 16 16");
    el.setAttribute("width", "9");
    el.setAttribute("height", "9");
    el.setAttribute("fill", "none");
    el.setAttribute("aria-hidden", "true");
    el.innerHTML =
      '<path d="M8 1.5a4.25 4.25 0 0 0-4.25 4.25c0 3.05 4.25 8.75 4.25 8.75s4.25-5.7 4.25-8.75A4.25 4.25 0 0 0 8 1.5Z" stroke="currentColor" stroke-width="1.5"/>' +
      '<circle cx="8" cy="5.75" r="1.4" fill="currentColor"/>';
    return el;
  }

  const infoCards = [
    makeInfoPreviewCard(
      "compactWeather",
      t("Weather"),
      h(
        "div",
        { class: "ni-card-body ni-weather" },
        h(
          "div",
          { class: "ni-head" },
          miniPin(),
          h("span", { class: "ni-head-title", text: "Bojongsoang" }),
          h("span", { class: "ni-pill sky", text: t("Drizzle") }),
        ),
        h(
          "div",
          { class: "ni-w-row" },
          h(
            "div",
            { class: "ni-w-main" },
            h("span", { class: "ni-big-num", text: "28°" }),
            buildMiniWeatherIcon("rain", true, 16),
          ),
          h(
            "div",
            { class: "ni-w-hours" },
            h(
              "div",
              { class: "ni-w-hr on" },
              h("span", { class: "ni-hr-lbl", text: t("Now") }),
              h("span", { class: "ni-hr-t", text: "29°" }),
            ),
            h(
              "div",
              { class: "ni-w-hr" },
              h("span", { class: "ni-hr-lbl", text: "14" }),
              h("span", { class: "ni-hr-t", text: "27°" }),
            ),
            h(
              "div",
              { class: "ni-w-hr" },
              h("span", { class: "ni-hr-lbl", text: "15" }),
              h("span", { class: "ni-hr-t", text: "26°" }),
            ),
          ),
        ),
      ),
    ),
    makeInfoPreviewCard(
      "compactMusic",
      t("Music & Lyrics"),
      h(
        "div",
        { class: "ni-card-body ni-music" },
        h(
          "div",
          { class: "ni-head" },
          h("span", { class: "ni-dot green" }),
          h("span", { class: "ni-head-title", text: "Dancing in the dark" }),
          h("span", { class: "ni-pill green", text: t("Lyrics") }),
        ),
        h(
          "div",
          { class: "ni-m-mid" },
          h("div", { class: "ni-m-art" }, svg(ICONS.musicNote, 12)),
          h(
            "div",
            { class: "ni-m-meta" },
            h("div", { class: "ni-m-artist", text: "Bruce Springsteen" }),
            h("div", { class: "ni-m-lyric", text: "♪ Can't start a fire…" }),
          ),
        ),
        h(
          "div",
          { class: "ni-prog-bar" },
          h("div", { class: "ni-prog-fill green", style: "width: 52%" }),
        ),
      ),
    ),
    makeInfoPreviewCard(
      "compactAgenda",
      t("Agenda"),
      h(
        "div",
        { class: "ni-card-body ni-agenda" },
        h(
          "div",
          { class: "ni-head" },
          h("span", { class: "ni-dot amber" }),
          h("span", { class: "ni-head-title", text: t("Today") }),
          h("span", { class: "ni-pill amber", text: "2" }),
        ),
        h(
          "div",
          { class: "ni-ag-list" },
          h(
            "div",
            { class: "ni-ag-item" },
            h("span", { class: "ni-ag-chk amber" }),
            h("span", { class: "ni-ag-time", text: "09:00" }),
            h("span", { class: "ni-ag-txt", text: "Sprint Standup" }),
          ),
          h(
            "div",
            { class: "ni-ag-item done" },
            h("span", { class: "ni-ag-chk green-check", text: "✓" }),
            h("span", { class: "ni-ag-time", text: "14:00" }),
            h("span", { class: "ni-ag-txt dim", text: "Design Review" }),
          ),
        ),
      ),
    ),
    makeInfoPreviewCard(
      "compactAiradoro",
      t("Airadoro"),
      h(
        "div",
        { class: "ni-card-body ni-airadoro" },
        h(
          "div",
          { class: "ni-head" },
          h("span", { class: "ni-dot sky" }),
          h("span", { class: "ni-head-title", text: "Airadoro" }),
          h("span", { class: "ni-pill sky", text: t("Focus") }),
        ),
        h(
          "div",
          { class: "ni-aira-mid" },
          h("span", { class: "ni-big-num", text: "25:00" }),
          h("span", { class: "ni-aira-play" }, svg(ICONS.play, 9)),
        ),
        h(
          "div",
          { class: "ni-prog-bar" },
          h("div", { class: "ni-prog-fill sky", style: "width: 45%" }),
        ),
      ),
    ),
    makeInfoPreviewCard(
      "compactPlan",
      t("Plan usage"),
      h(
        "div",
        { class: "ni-card-body ni-plan" },
        h(
          "div",
          { class: "ni-head" },
          h("span", { class: "ni-dot emerald" }),
          h("span", { class: "ni-head-title", text: t("Claude plan") }),
        ),
        h(
          "div",
          { class: "ni-p-rows" },
          h(
            "div",
            { class: "ni-p-row" },
            h("span", { class: "ni-p-label", text: t("5 hours") }),
            h("div", { class: "ni-prog-bar" }, h("div", { class: "ni-prog-fill emerald", style: "width: 28%" })),
            h("span", { class: "ni-p-pct emerald", text: "28%" }),
          ),
          h(
            "div",
            { class: "ni-p-row" },
            h("span", { class: "ni-p-label", text: t("Week") }),
            h("div", { class: "ni-prog-bar" }, h("div", { class: "ni-prog-fill emerald-dim", style: "width: 45%" })),
            h("span", { class: "ni-p-pct emerald-dim", text: "45%" }),
          ),
        ),
      ),
    ),
    makeInfoPreviewCard(
      "featureUpload",
      t("Drop"),
      h(
        "div",
        { class: "ni-card-body ni-dock-feat" },
        h(
          "div",
          { class: "ni-head" },
          svg(ICONS.plus, 10, { stroke: 2 }),
          h("span", { class: "ni-head-title", text: t("Drop") }),
        ),
        h(
          "div",
          { class: "ni-drop-zone" },
          svg(ICONS.plus, 11, { stroke: 2 }),
          h("span", { text: "report.pdf" }),
        ),
      ),
    ),
    makeInfoPreviewCard(
      "featureChat",
      t("Chat"),
      h(
        "div",
        { class: "ni-card-body ni-dock-feat" },
        h(
          "div",
          { class: "ni-head" },
          svg(ICONS.bubbleRound, 10),
          h("span", { class: "ni-head-title", text: t("Chat") }),
        ),
        h(
          "div",
          { class: "ni-chat-stack" },
          h("div", { class: "ni-chat-bubble user", text: "Summarize notes" }),
          h("div", { class: "ni-chat-bubble bot", text: "Here are 3 key points…" }),
        ),
      ),
    ),
    makeInfoPreviewCard(
      "featureAgents",
      t("Agents"),
      h(
        "div",
        { class: "ni-card-body ni-dock-feat" },
        h(
          "div",
          { class: "ni-head" },
          svg(ICONS.terminal, 10),
          h("span", { class: "ni-head-title", text: t("Agents") }),
        ),
        h(
          "div",
          { class: "ni-rows" },
          h("div", { class: "ni-mini-row" }, h("span", { class: "ni-dot sky" }), h("span", { class: "ni-mini-txt", text: "Claude Code" })),
          h("div", { class: "ni-mini-row" }, h("span", { class: "ni-dot emerald" }), h("span", { class: "ni-mini-txt", text: "Codex" })),
        ),
      ),
    ),
    makeInfoPreviewCard(
      "featureClipboard",
      t("Clips"),
      h(
        "div",
        { class: "ni-card-body ni-dock-feat" },
        h(
          "div",
          { class: "ni-head" },
          svg(ICONS.clipboard, 10),
          h("span", { class: "ni-head-title", text: t("Clips") }),
        ),
        h(
          "div",
          { class: "ni-rows" },
          h("div", { class: "ni-mini-row" }, h("span", { class: "ni-mini-chip", text: "TXT" }), h("span", { class: "ni-mini-txt", text: "npm run build" })),
          h("div", { class: "ni-mini-row" }, h("span", { class: "ni-mini-chip", text: "URL" }), h("span", { class: "ni-mini-txt", text: "aira.app/docs" })),
        ),
      ),
    ),
    makeInfoPreviewCard(
      "featureMail",
      t("Mail"),
      h(
        "div",
        { class: "ni-card-body ni-dock-feat" },
        h(
          "div",
          { class: "ni-head" },
          svg(ICONS.envelope, 10),
          h("span", { class: "ni-head-title", text: t("Mail") }),
          h("span", { class: "ni-pill sky", text: "3" }),
        ),
        h(
          "div",
          { class: "ni-rows" },
          h("div", { class: "ni-mini-row" }, h("span", { class: "ni-dot sky" }), h("span", { class: "ni-mini-txt", text: "Design review" })),
          h("div", { class: "ni-mini-row" }, h("span", { class: "ni-mini-txt dim", text: "Weekly digest" })),
        ),
      ),
    ),
    makeInfoPreviewCard(
      "featureConvert",
      t("Convert"),
      h(
        "div",
        { class: "ni-card-body ni-dock-feat" },
        h(
          "div",
          { class: "ni-head" },
          svg(ICONS.convert, 10),
          h("span", { class: "ni-head-title", text: t("Convert") }),
        ),
        h(
          "div",
          { class: "ni-conv-row" },
          h("span", { class: "ni-conv-tag", text: "PNG" }),
          h("span", { class: "ni-conv-arrow", text: "→" }),
          h("span", { class: "ni-conv-tag on", text: "WEBP" }),
        ),
      ),
    ),
    makeInfoPreviewCard(
      "featureCamera",
      t("Camera"),
      h(
        "div",
        { class: "ni-card-body ni-dock-feat" },
        h(
          "div",
          { class: "ni-head" },
          svg(ICONS.camera, 10),
          h("span", { class: "ni-head-title", text: t("Camera") }),
        ),
        h(
          "div",
          { class: "ni-conv-row" },
          h("span", { class: "ni-conv-tag", text: "PNG" }),
          h("span", { class: "ni-conv-tag on", text: "REC" }),
        ),
      ),
    ),
  ];

  const syncInfoCards = () => {
    for (const c of infoCards) {
      c.btn.classList.toggle("on", settings[c.key] !== false);
    }
  };
  syncInfoCards();
  const infoCardsGrid = h("div", { class: "notch-info-grid" }, ...infoCards.map((c) => c.btn));
  const notchInfoCard = card(
    t("Notch info"),
    h("div", { class: "hint", text: t("Choose which features and live information are enabled on the notch.") }),
    infoCardsGrid,
  );

  const notchCard = card(
    t("Notch"),
    settingItem(t("Open the notch"), null, openNotchCtrl.element),
    settingItem(
      t("Page icons"),
      t("Show page icons when you hover the page dots"),
      pageIconsToggle,
    ),
    settingItem(
      t("Open for every pill’s alerts"),
      t("When a pill other than the one shown finishes or hits an error, the notch shows it for a moment, then the pill you had comes back."),
      toggle(settings.alertsFromAllPills, (v) => { settings.alertsFromAllPills = v; void save(); }),
    ),
    settingItem(
      t("Auto-close"),
      t("seconds after you leave the island"),
      autoCloseChips,
      autoClose,
    ),
  );

  const motionCard = card(
    t("Motion"),
    settingItem(t("Animation speed"), null, animSpeedCtrl.element),
  );

  const generalCard = card(
    t("General"),
    languageRow(),
    settingItem(t("Launch at startup"), null, autostart),
  );

  const displayCard = card(
    t("Display"),
    settingItem(t("Island lives on"), null, screen),
    settingItem(
      t("Island position"),
      t("Where the island sits at the top of the screen."),
      positionCtrl.element,
    ),
    settingItem(
      t("Island scale"),
      t("The size of the island."),
      scaleCtrl.element,
    ),
    settingItem(
      t("Closed island shows"),
      t("A PC has no notch: once closed, a small island stays at the top of the screen. Hover it to bring Aira back. Hidden, move the pointer to the very top of the screen."),
      closed,
    ),
    settingItem(
      t("Show clock in the island"),
      t("The date and the time in the middle of the island when it is compact."),
      toggle(settings.showClock, (v) => { settings.showClock = v; void save(); }),
    ),
  );

  const mascotCard = card(
    t("Mascot tuner"),
    settingItem(t("Eye glow color"), t("Custom color for the eyes in the island."), colorWrap),
    settingItem(t("Robot sound accents"), t("Subtle servo and chirp accents when the eyes react."), robotSound),
    settingItem(t("Eye size"), null, eyeScaleIn, eyeScaleLbl),
    settingItem(t("Blink frequency"), null, blinkRateIn, blinkRateLbl),
    settingItem(t("Idle drift"), null, driftIn, driftLbl),
    settingItem(t("Gaze overshoot"), null, overshootIn, overshootLbl),
    settingItem(t("Saccade threshold"), null, sacThreshIn, sacThreshLbl),
    settingItem(t("Expression anticipation"), null, anticIn, anticLbl),
    settingItem(t("Mascot defaults"), null, resetTune),
  );

  const soundCard = card(
    t("Sound"),
    settingItem(t("Sound"), null, sound, volume, volumePercent),
    settingItem(
      t("Open sounds folder"),
      t("Drop a file named like one of Mochi's sounds (finish.wav, approval.mp3, greet.m4a…) in the sounds folder to replace it, then Reload."),
      customCount, soundsFolder, reloadSounds,
    ),
  );

  const recapCard = card(t("Weekly recap"), ...recapRows());
  const updatesCard = card(t("Updates"), ...updateRows(toggle, version));

  return [notchStyleCard, notchInfoCard, notchCard, motionCard, generalCard, displayCard, mascotCard, soundCard, recapCard, updatesCard];
}

/**
 * Settings → General → Language, as on the Mac: "System" follows the
 * system's language when Coucou has it (else English), or one of the ten.
 * Both windows and the tray switch in place, without a restart.
 */
function languageRow(): HTMLElement {
  const select = h("select", {}) as HTMLSelectElement;
  select.append(h("option", { value: "", text: t("System") }));
  for (const { code, name } of LANGUAGES) select.append(h("option", { value: code, text: name, lang: code }));
  select.value = LANGUAGES.some((l) => l.code === settings.language) ? settings.language : "";
  select.addEventListener("change", () => {
    settings.language = select.value;
    void save();
    applyLanguage();
  });
  return settingItem(t("Language"), null, select);
}

// ── Shortcuts section ─────────────────────────────────────────────────────────

const SHORTCUTS_UI = {
  get title() { return t("Shortcuts"); },
  get hint() { return t("Work from any app. Click a shortcut to change it, then press the new keys — Esc cancels, Backspace removes it."); },
  get global() { return t("From anywhere"); },
  get island() { return t("In the open island"); },
  get recording() { return t("Press keys…"); },
  get none() { return t("None"); },
  get reset() { return t("Reset to defaults"); },
  get inUse() { return t("In use by another app"); },
  get duplicate() { return t("Used twice"); },
  get invalid() { return t("Not a valid shortcut"); },
  get unavailable() { return t("Not available"); },
  types: (ch: string) => t("Types “{char}”", { char: ch }),
  typesNote: (keys: string, ch: string) =>
    t("{keys} types “{char}” on your keyboard, so it can't be a shortcut. Pick another key.", { keys, char: ch }),
  get needsModifier() { return t("Hold Ctrl, Alt or the Windows key with it."); },
  get unsupportedKey() { return t("That key can't be used in a shortcut."); },
  get wayland() {
    return t("Your Wayland desktop doesn't let apps listen for keys outside their own windows. Add the shortcuts in your system's keyboard settings instead, with these commands:");
  },
  get noDisplay() { return t("No display server was found, so global shortcuts are off."); },
  get portalPending() {
    return t("Asking your desktop to register the shortcuts. It may show its own window to confirm them.");
  },
  get portalActive() {
    return t("These shortcuts are registered with your desktop. It may ask you to confirm them or to pick other keys; when it says which keys it uses, they show next to each shortcut.");
  },
  get portalFallback() {
    return t("If one doesn't work, you can also add it in your system's keyboard settings with these commands:");
  },
  desktopKeys: (keys: string) => t("Desktop: {keys}", { keys }),
  get refused() { return t("Not set by your desktop"); },
};

function shortcutsSection(initial: ShortcutsReport | null): HTMLElement {
  let report = initial;
  const list = h("div", { class: "shortcut-list" });
  const feedback = h("div", {});
  const blockedNote = h("div", {});

  let stopRecording: (() => void) | null = null;

  function store(id: string, binding: Binding) {
    settings.shortcuts = { ...settings.shortcuts, [id]: binding };
    void save();
  }

  function tagFor(id: string, dups: Set<string>): HTMLElement | null {
    if (dups.has(id)) return h("span", { class: "tag err", text: SHORTCUTS_UI.duplicate });
    const st = report?.actions.find((a) => a.id === id);
    switch (st?.status) {
      case "inUse": return h("span", { class: "tag warn", text: SHORTCUTS_UI.inUse });
      case "duplicate": return h("span", { class: "tag err", text: SHORTCUTS_UI.duplicate });
      case "invalid": return h("span", { class: "tag err", text: SHORTCUTS_UI.invalid });
      case "typesCharacter": return h("span", { class: "tag warn", text: SHORTCUTS_UI.types(st.typed ?? "?") });
      case "unsupported": return h("span", { class: "tag", text: SHORTCUTS_UI.unavailable });
      case "refused": return h("span", { class: "tag warn", text: SHORTCUTS_UI.refused });
      // Wayland: the desktop may run it on other keys than the ones asked for.
      case "active": return st.trigger ? h("span", { class: "tag", text: SHORTCUTS_UI.desktopKeys(st.trigger) }) : null;
      default: return null;
    }
  }

  function record(id: string, binding: Binding, button: HTMLButtonElement) {
    stopRecording?.();
    clear(feedback);
    button.classList.add("recording");
    button.textContent = SHORTCUTS_UI.recording;
    void Bridge.shortcutsSuspend(true);

    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const result = recordPress(e);
      switch (result.kind) {
        case "pending":
          return;
        case "keys":
          finish();
          store(id, { keys: result.keys, enabled: true });
          return;
        case "clear":
          finish();
          store(id, { keys: "", enabled: binding.enabled });
          return;
        case "typesCharacter":
          finish();
          feedback.append(h("div", {
            class: "notice warn",
            text: SHORTCUTS_UI.typesNote(displayKeys(result.keys), result.typed),
          }));
          return;
        case "needsModifier":
          feedback.replaceChildren(h("div", { class: "notice warn", text: SHORTCUTS_UI.needsModifier }));
          return;
        case "unsupported":
          feedback.replaceChildren(h("div", { class: "notice warn", text: SHORTCUTS_UI.unsupportedKey }));
          return;
        case "cancel":
          finish();
          return;
      }
    };
    const onBlur = () => finish();

    function finish() {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
      stopRecording = null;
      // Takes the global shortcuts back, from what is saved by now.
      void Bridge.shortcutsSuspend(false);
      draw();
    }
    stopRecording = finish;
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
  }

  function draw() {
    clear(list);
    const dups = duplicates(activeKeys(settings.shortcuts));
    for (const d of SHORTCUTS) {
      if (!d.ported) continue;
      const binding = effective(d, settings.shortcuts);
      const keycap = h("button", {
        class: "keycap",
        text: binding.keys ? displayKeys(binding.keys) : SHORTCUTS_UI.none,
      }) as HTMLButtonElement;
      keycap.disabled = !binding.enabled;
      keycap.addEventListener("click", () => record(d.id, binding, keycap));
      const sw = toggle(binding.enabled, (on) => store(d.id, { keys: binding.keys, enabled: on }));
      const tag = binding.enabled ? tagFor(d.id, dups) : null;
      list.append(h("div", { class: binding.enabled ? "row shortcut" : "row shortcut off" },
        sw,
        h("span", { class: "shortcut-name", text: t(SHORTCUT_TEXT[d.id]) }),
        ...(tag ? [tag] : []),
        keycap,
      ));
    }

    clear(blockedNote);
    const commands = (command: string) => {
      const list = h("div", { class: "diff" });
      for (const d of SHORTCUTS) {
        if (d.ported) list.append(h("div", { class: "ctx", text: `${command} ${d.id}` }));
      }
      return list;
    };
    if (report?.portal) {
      // Wayland, through the desktop's GlobalShortcuts portal; the commands
      // stay as a way around a shortcut the desktop didn't take.
      const active = report.portal === "active";
      blockedNote.append(
        h("div", {
          class: active ? "notice ok" : "notice",
          text: active ? SHORTCUTS_UI.portalActive : SHORTCUTS_UI.portalPending,
        }),
        h("div", { class: "hint", text: SHORTCUTS_UI.portalFallback }),
        commands(report.command),
      );
    } else if (report?.blocked === "wayland") {
      blockedNote.append(h("div", { class: "notice warn", text: SHORTCUTS_UI.wayland }), commands(report.command));
    } else if (report?.blocked) {
      blockedNote.append(h("div", { class: "notice warn", text: SHORTCUTS_UI.noDisplay }));
    }
  }

  const islandList = h("div", { class: "shortcut-list" });
  for (const row of ISLAND_SHORTCUTS) {
    islandList.append(h("div", { class: "row shortcut" },
      h("span", { class: "shortcut-name", text: t(row.description) }),
      h("span", { class: "keycap static", text: row.keys }),
    ));
  }

  const reset = h("button", {
    text: SHORTCUTS_UI.reset,
    onclick: () => {
      stopRecording?.();
      settings.shortcuts = {};
      clear(feedback);
      void save();
      draw();
    },
  });

  // The events are listened to once (see main); only the section on screen redraws.
  shortcutsListener = {
    report(fresh) {
      report = fresh;
      if (!stopRecording) draw();
    },
    settingsChanged() {
      if (!stopRecording) draw();
    },
  };

  draw();
  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: SHORTCUTS_UI.title })),
    h("div", { class: "hint", text: SHORTCUTS_UI.hint }),
    h("div", { class: "subhead", text: SHORTCUTS_UI.global }),
    list,
    blockedNote,
    feedback,
    h("div", { class: "row" }, reset),
    h("div", { class: "subhead", text: SHORTCUTS_UI.island }),
    islandList,
  );
}

/** Settings → General → Weekly recap. The prefs live with the history in Rust. */
function recapRows(): HTMLElement[] {
  const T = {
    label: t("Weekly recap"),
    keep: t("Keep a history of my coding sessions"),
    clear: t("Clear history"),
    cleared: t("History cleared."),
    about: t("Counts and project names only — never commands, files or prompts. Kept on this computer for 12 weeks."),
  };
  const feedback = h("span", { class: "hint" });
  const sw = toggle(true, (v) => { void Bridge.recapSetEnabled(v); });
  void Bridge.recapPrefs().then((prefs) => {
    if (prefs) sw.classList.toggle("on", prefs.enabled);
  });
  const clearBtn = h("button", {
    class: "danger",
    text: T.clear,
    onclick: async () => {
      clearBtn.disabled = true;
      await Bridge.recapClear();
      feedback.textContent = T.cleared;
      window.setTimeout(() => {
        clearBtn.disabled = false;
        feedback.textContent = "";
      }, 2400);
    },
  }) as HTMLButtonElement;
  return [
    settingItem(T.keep, T.about, sw),
    settingItem(T.clear, null, feedback, clearBtn),
  ];
}

// ── Language ──────────────────────────────────────────────────────────────────

/** The shortcuts section on screen, told about the events listened to once in main. */
let shortcutsListener: { report(fresh: ShortcutsReport): void; settingsChanged(): void } | null = null;

/**
 * Shows the language Settings asks for. A change redraws the window in place,
 * where it was scrolled to: nothing reloads, nothing is written.
 */
function applyLanguage() {
  setLanguage(resolveLanguage(settings.language, systemLanguages()));
}

function applyDirection() {
  document.documentElement.dir = isRtl() ? "rtl" : "ltr";
  document.title = "Aira";
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function main() {
  const boot = await Bridge.boot();
  if (boot) {
    settings = { ...settings, ...boot.settings };
    version = boot.version;
  }
  setLanguage(resolveLanguage(settings.language, systemLanguages()));
  applyDirection();
  hub = await startHub(windowRoot, {
    version,
    flowPages: FLOW_PAGE_RENDERERS,
    renderNotch: async (page, container) => {
      notchPage = page;
      root = container;
      await render();
    },
  });
  onLanguageChange(() => {
    applyDirection();
    hub?.redraw();
  });

  void onEvent<ShortcutsReport>("shortcuts-status", (fresh) => shortcutsListener?.report(fresh));
  void onEvent<UpdateStatus>("update-status", (fresh) => updatesListener?.(fresh));
  void onEvent<Settings>("settings-changed", (s) => {
    const before = `${settings.chatProvider}|${settings.ollamaUrl}|${settings.lmstudioUrl}|${settings.customUrl}`;
    const langBefore = settings.language;
    settings = { ...settings, ...s };
    shortcutsListener?.settingsChanged();
    generalSync?.();
    for (const redraw of declaredViews) redraw();
    const after = `${settings.chatProvider}|${settings.ollamaUrl}|${settings.lmstudioUrl}|${settings.customUrl}`;
    if (before !== after) localRedraw?.();
    if (langBefore !== settings.language) applyLanguage();
  });
}

/** The Notch page being shown. */
let notchPage: PageId = "general";
let renderSeq = 0;

const INTEGRATION_KEYS = [
  "stripe-api-key", "github-token", "gitlab-url", "gitlab-token", "gitea-url", "gitea-token", "vercel-token",
  "n8n-url", "n8n-api-key", "resend-api-key", "notion-api-key", "calcom-api-key",
];

/** Reads only the data needed by the active Notch page and draws its sections. */
async function render() {
  const seq = ++renderSeq;
  const page = notchPage;

  // A main pill this build can run, and no pill declared twice.
  settings = { ...settings, ...sanitizeDeclared(settings) };

  const resetPageListeners = () => {
    declaredViews.length = 0;
    localRedraw = null;
    shortcutsListener = null;
    generalSync = null;
  };

  let pageNodes: HTMLElement[] = [];

  if (page === "general") {
    resetPageListeners();
    pageNodes = [
      ...generalSections(),
      h("div", {
        class: "hint",
        text: t("No telemetry. Network requests only go to the services you configure yourself."),
      }),
    ];
  } else if (page === "phone") {
    resetPageListeners();
    pageNodes = [phoneSection(settings.phoneLink ?? false, toggle, settings)];
  } else if (page === "shortcuts") {
    const shortcutReport = await Bridge.shortcutsStatus();
    if (seq !== renderSeq) return;
    resetPageListeners();
    pageNodes = [shortcutsSection(shortcutReport)];
  } else if (page === "agents") {
    const [rawStatus, agents] = await Promise.all([
      Bridge.hooksStatus(),
      Bridge.agentHooksList(),
    ]);
    if (seq !== renderSeq) return;
    resetPageListeners();
    const status = rawStatus ?? {
      installed: false, planRelayInstalled: false, settingsPath: "", hookPath: "", hookReady: false,
    };
    pageNodes = [claudeSection(status), agentsSection(agents), planSection(status)];
  } else if (page === "pills") {
    const keyPills = availablePills().filter((def) => def.connect.kind === "key");
    const [agentStatus, ...keyStates] = await Promise.all([
      Bridge.agentHooksStatus(),
      ...keyPills.map((def) =>
        def.connect.kind === "key"
          ? Bridge.keyReady(def.connect.key).then((ok) => [def.id, Boolean(ok)] as const)
          : Promise.resolve([def.id, false] as const),
      ),
    ]);
    if (seq !== renderSeq) return;
    resetPageListeners();
    const connected: Record<string, boolean> = { ...(agentStatus ?? {}) };
    for (const [id, ok] of keyStates) connected[id] = ok;
    pageNodes = [activePillsSection(connected)];
  } else if (page === "chat") {
    const cloudDefs = CLOUD.map((def) => providerDef(def.id).key!);
    const [hasKeyRaw, customKeyRaw, ...cloudStates] = await Promise.all([
      Bridge.secretPresent("anthropic-api-key"),
      Bridge.secretPresent(CUSTOM_SERVER_KEY),
      ...cloudDefs.map((key) => Bridge.secretPresent(key).then((ok) => [key, Boolean(ok)] as const)),
    ]);
    const hasKey = hasKeyRaw ?? false;
    const claudeRelay = !hasKey && ((await Bridge.claudeReady()) ?? false);
    if (seq !== renderSeq) return;
    resetPageListeners();
    const chatKeys: Record<string, boolean> = {};
    for (const [key, ok] of cloudStates) chatKeys[key] = ok;
    const customKey = customKeyRaw ?? false;
    const keyChanged = () => { };
    pageNodes = [
      subscriptionsSection(),
      apiSection(hasKey, claudeRelay),
      chatProvidersSection(chatKeys, keyChanged),
      localSection(customKey),
    ];
  } else if (page === "integrations") {
    const states = await Promise.all(
      INTEGRATION_KEYS.map((k) => Bridge.secretPresent(k).then((ok) => [k, Boolean(ok)] as const)),
    );
    if (seq !== renderSeq) return;
    resetPageListeners();
    const present: Record<string, boolean> = {};
    for (const [k, ok] of states) present[k] = ok;
    pageNodes = [integrationsSection(present), converterSection(), ...whatsappSections()];
  } else {
    resetPageListeners();
  }

  clear(root);
  root.append(...pageNodes);
}

void main();
