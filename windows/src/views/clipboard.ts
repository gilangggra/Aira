// Clipboard History Manager view for the expanded island.
// Supports instant 1-click copy & collapse, live search, All/Pinned/Links filters,
// hex color swatches, privacy pause toggle, and 1-click send to Agenda or AI Chat.

import { addAgendaTask, loadAgendaTasks } from "../core/agenda";
import { dayKey } from "../core/calendar";
import {
  Clipboard,
  countClipboardLines,
  filterClipboardEntries,
  formatClipboardAge,
  isSensitiveClipboardText,
  maskSensitiveText,
  type ClipboardEntry,
  type ClipboardFilter,
} from "../core/clipboard";
import { State } from "../core/state";
import { t, tl } from "../i18n/i18n";
import { clear, h, svg } from "./dom";
import { ICONS } from "./icons";
import type { ViewActions, ViewHost } from "./views";

function makePinSvg(): SVGSVGElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("viewBox", "0 0 16 16");
  el.setAttribute("width", "11");
  el.setAttribute("height", "11");
  el.setAttribute("fill", "none");
  el.innerHTML = `<path d="M9.8 2.2 13.8 6.2l-1.4 1.4-1-.4-2.5 2.5.4 2.1-1.2 1.2-2.4-2.4L2.5 13.5l-.3-.3 2.9-3.2L2.7 7.6l1.2-1.2 2.1.4 2.5-2.5-.4-1 1.7-1.1Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>`;
  return el;
}

export function buildClipboardView(actions: ViewActions): ViewHost {
  let query = "";
  let filter: ClipboardFilter = "all";
  let copiedId: string | null = null;
  let copiedTimer: number | null = null;
  let selectedIdx = 0;
  let visibleItems: ClipboardEntry[] = [];
  const revealedIds = new Set<string>();

  const searchInput = h("input", {
    type: "text",
    class: "clip-search",
    placeholder: tl("Search clipboard…"),
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;

  searchInput.addEventListener("input", () => {
    query = searchInput.value;
    selectedIdx = 0;
    actions.holdOpen(query.trim().length > 0);
    renderList();
  });
  searchInput.addEventListener("focus", () => actions.keyboard(true));
  searchInput.addEventListener("blur", () => {
    actions.holdOpen(false);
    actions.keyboard(false);
  });

  async function copyAndCollapse(entry: ClipboardEntry) {
    actions.blip();
    const ok = await Clipboard.copyToSystem(entry.text);
    if (!ok) return;
    copiedId = entry.id;
    revealedIds.clear();
    if (copiedTimer != null) window.clearTimeout(copiedTimer);
    renderList();
    copiedTimer = window.setTimeout(() => {
      copiedId = null;
      actions.collapse();
    }, 260);
  }

  function moveSelection(delta: number) {
    if (visibleItems.length === 0) return;
    selectedIdx = (selectedIdx + delta + visibleItems.length) % visibleItems.length;
    const rows = listEl.querySelectorAll<HTMLElement>(".clip-item");
    rows.forEach((row, idx) => {
      const on = idx === selectedIdx;
      row.classList.toggle("selected", on);
      if (on) row.scrollIntoView({ block: "nearest" });
    });
  }

  const filterDefs: Array<{ id: ClipboardFilter; label: ReturnType<typeof tl> }> = [
    { id: "all", label: tl("All") },
    { id: "pinned", label: tl("Pinned") },
    { id: "links", label: tl("Links") },
  ];
  const filterBtns = filterDefs.map((f) => {
    const btn = h("button", {
      type: "button",
      class: f.id === filter ? "clip-ftab on" : "clip-ftab",
      text: f.label,
      onclick: () => {
        actions.blip();
        filter = f.id;
        selectedIdx = 0;
        for (const b of filterBtns) b.classList.toggle("on", b.dataset.filter === filter);
        renderList();
      },
    });
    btn.dataset.filter = f.id;
    return btn;
  });
  const filtersEl = h("div", { class: "clip-filters" }, ...filterBtns);

  const pauseBtn = h("button", {
    type: "button",
    class: "clip-pause-btn",
    onclick: () => {
      actions.blip();
      Clipboard.setPaused(!Clipboard.paused);
      renderToolbar();
      renderList();
    },
  });

  const clearBtn = h(
    "button",
    {
      type: "button",
      class: "clip-clear-btn",
      title: tl("Clear"),
      text: tl("Clear"),
      onclick: () => {
        actions.blip();
        Clipboard.clearUnpinned();
      },
    },
  ) as HTMLButtonElement;

  const toolbar = h(
    "div",
    { class: "clip-toolbar" },
    searchInput,
    filtersEl,
    pauseBtn,
    clearBtn,
  );

  const listEl = h("div", { class: "clip-list" });
  const shell = h("div", { class: "clip-shell" }, toolbar, listEl);
  const el = h("div", { class: "view clip-view" }, shell);

  el.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveSelection(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveSelection(-1);
    } else if (e.key === "Enter") {
      const target = e.target as HTMLElement | null;
      if (target && target.tagName === "BUTTON") return;
      const item = visibleItems[selectedIdx];
      if (!item) return;
      e.preventDefault();
      void copyAndCollapse(item);
    } else if (e.key === "Escape") {
      e.stopPropagation();
      if (searchInput.value) {
        searchInput.value = "";
        query = "";
        selectedIdx = 0;
        actions.holdOpen(false);
        renderList();
      } else {
        actions.collapse();
      }
    }
  });

  function renderToolbar() {
    const paused = Clipboard.paused;
    pauseBtn.classList.toggle("paused", paused);
    pauseBtn.textContent = paused ? t("Resume") : t("Pause");
    const hasUnpinned = Clipboard.entries.some((e) => !e.pinned);
    clearBtn.disabled = !hasUnpinned;
  }

  function previewText(raw: string): string {
    return raw.trim().replace(/\s+/g, " ");
  }

  function renderEntry(entry: ClipboardEntry, index: number): HTMLElement {
    const isCopied = copiedId === entry.id;
    const isSelected = index === selectedIdx;
    const sensitive = entry.sensitive ?? isSensitiveClipboardText(entry.text);
    const isMasked = sensitive && !revealedIds.has(entry.id);
    const lines = entry.kind === "code" ? countClipboardLines(entry.text) : 1;

    const badge = isMasked
      ? h("span", { class: "clip-kind-badge secret", title: tl("Sensitive"), text: "🔒" })
      : entry.kind === "color"
        ? h("span", { class: "clip-swatch", style: `background:${entry.text.trim()}` })
        : entry.kind === "link"
          ? h("span", { class: "clip-kind-badge link", text: "🔗" })
          : entry.kind === "code"
            ? h("span", { class: "clip-kind-badge code", text: "</>" })
            : entry.pinned
              ? h("span", { class: "clip-kind-badge pin", text: "📌" })
              : null;

    const sizeMeta = entry.kind === "code" && lines > 1
      ? `${lines}L · ${entry.text.length}c`
      : `${entry.text.length}c`;

    const meta = isCopied
      ? h("span", { class: "clip-copied-tag", text: `✓ ${t("Copied")}` })
      : h("span", {
          class: "clip-meta",
          text: `${formatClipboardAge(entry.copiedAt)} · ${sizeMeta}`,
        });

    const previewCls = isMasked
      ? "clip-preview masked"
      : entry.kind === "code"
        ? "clip-preview code"
        : "clip-preview";

    const main = h(
      "div",
      { class: "clip-main" },
      h("div", { class: previewCls, text: isMasked ? maskSensitiveText(entry.text) : previewText(entry.text) }),
      meta,
    );

    const revealBtn = sensitive
      ? h(
          "button",
          {
            type: "button",
            class: isMasked ? "clip-act" : "clip-act on",
            title: isMasked ? tl("Show") : tl("Hide"),
            onclick: (e: Event) => {
              e.stopPropagation();
              actions.blip();
              if (revealedIds.has(entry.id)) revealedIds.delete(entry.id);
              else revealedIds.add(entry.id);
              renderList();
            },
          },
          svg(ICONS.eye, 11, { stroke: 1.8 }),
        )
      : null;

    const pinBtn = h(
      "button",
      {
        type: "button",
        class: entry.pinned ? "clip-act pin on" : "clip-act pin",
        title: tl("Pin"),
        onclick: (e: Event) => {
          e.stopPropagation();
          actions.blip();
          Clipboard.togglePin(entry.id);
        },
      },
      makePinSvg(),
    );

    const openBtn =
      entry.kind === "link" && !isMasked
        ? h(
            "button",
            {
              type: "button",
              class: "clip-act",
              title: tl("Open"),
              onclick: (e: Event) => {
                e.stopPropagation();
                actions.blip();
                actions.openUrl(entry.text.trim());
              },
            },
            svg(ICONS.arrowUpRight, 11, { stroke: 1.9 }),
          )
        : null;

    const agendaBtn = !isMasked
      ? h(
          "button",
          {
            type: "button",
            class: "clip-act",
            title: tl("Add to Agenda"),
            onclick: (e: Event) => {
              e.stopPropagation();
              actions.blip();
              const today = dayKey(new Date());
              const updated = addAgendaTask(loadAgendaTasks(), today, previewText(entry.text));
              if (updated) {
                actions.emote?.("happy");
                State.notify();
              }
            },
          },
          svg(ICONS.calendar, 10, { stroke: 1.9 }),
        )
      : null;

    const chatBtn = !isMasked
      ? h(
          "button",
          {
            type: "button",
            class: "clip-act",
            title: tl("Ask AI"),
            onclick: (e: Event) => {
              e.stopPropagation();
              actions.blip();
              actions.sendToChat?.(entry.text);
            },
          },
          svg(ICONS.bubble, 10, { stroke: 1.9 }),
        )
      : null;

    const delBtn = h(
      "button",
      {
        type: "button",
        class: "clip-act del",
        title: tl("Delete"),
        onclick: (e: Event) => {
          e.stopPropagation();
          actions.blip();
          Clipboard.remove(entry.id);
        },
      },
      svg(ICONS.xmark, 10),
    );

    const rowCls = [
      "clip-item",
      isCopied ? "copied" : "",
      entry.pinned ? "pinned" : "",
      isSelected ? "selected" : "",
    ]
      .filter(Boolean)
      .join(" ");

    const row = h(
      "div",
      {
        class: rowCls,
        onmouseenter: () => {
          if (selectedIdx !== index) {
            selectedIdx = index;
            listEl.querySelectorAll<HTMLElement>(".clip-item").forEach((r, i) => {
              r.classList.toggle("selected", i === selectedIdx);
            });
          }
        },
        onclick: () => void copyAndCollapse(entry),
      },
      badge,
      main,
      h("div", { class: "clip-actions" }, revealBtn, pinBtn, openBtn, agendaBtn, chatBtn, delBtn),
    );
    return row;
  }

  function renderList() {
    clear(listEl);
    const items = filterClipboardEntries(Clipboard.entries, query, filter);
    visibleItems = items;
    if (items.length === 0) {
      selectedIdx = 0;
      const msg = Clipboard.paused
        ? t("Recording paused")
        : t("Clipboard is empty");
      listEl.append(
        h(
          "div",
          { class: "clip-empty" },
          svg(ICONS.clipboard, 20, { stroke: 1.5 }),
          h("span", { text: msg }),
        ),
      );
      return;
    }
    if (selectedIdx >= items.length) selectedIdx = items.length - 1;
    if (selectedIdx < 0) selectedIdx = 0;
    for (let i = 0; i < items.length; i++) {
      listEl.append(renderEntry(items[i], i));
    }
  }

  Clipboard.subscribe(() => {
    if (el.isConnected && State.view === "clipboard") {
      renderToolbar();
      renderList();
    }
  });

  return {
    el,
    sync() {
      void Clipboard.refreshFromSystem();
      renderToolbar();
      renderList();
    },
    focus() {
      revealedIds.clear();
      selectedIdx = 0;
      searchInput.focus();
      renderList();
    },
  };
}
