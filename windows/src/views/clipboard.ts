// Clipboard History Manager view for the expanded island.
// Supports instant 1-click copy & collapse, live search, All/Pinned/Links filters,
// hex color swatches, privacy pause toggle, and 1-click send to Agenda or AI Chat.

import { addAgendaTask, loadAgendaTasks } from "../core/agenda";
import { Bridge, IS_TAURI } from "../core/bridge";
import { dayKey } from "../core/calendar";
import {
  Clipboard,
  filterClipboardEntries,
  formatClipboardAge,
  getSmartClipboardActions,
  isSensitiveClipboardText,
  maskSensitiveText,
  type ClipboardEntry,
  type ClipboardFilter,
  type SmartClipboardAction,
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

function makeLockSvg(): SVGSVGElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("viewBox", "0 0 16 16");
  el.setAttribute("width", "11");
  el.setAttribute("height", "11");
  el.setAttribute("fill", "none");
  el.innerHTML =
    `<rect x="3.5" y="7" width="9" height="6.5" rx="1.6" stroke="currentColor" stroke-width="1.35"/>` +
    `<path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/>`;
  return el;
}

function makeLinkSvg(): SVGSVGElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("viewBox", "0 0 16 16");
  el.setAttribute("width", "11");
  el.setAttribute("height", "11");
  el.setAttribute("fill", "none");
  el.innerHTML =
    `<path d="M6.5 9.5 9.5 6.5M5.2 7.2 4 8.4a2.4 2.4 0 0 0 3.4 3.4l1.2-1.2M10.8 8.8 12 7.6A2.4 2.4 0 0 0 8.6 4.2L7.4 5.4" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/>`;
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
    const ok =
      entry.kind === "image"
        ? await Clipboard.copyImageToSystem(entry)
        : await Clipboard.copyToSystem(entry.text);
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
    const rows = listEl.querySelectorAll<HTMLElement>(".clip-item, .clip-img-tile");
    rows.forEach((row, idx) => {
      const on = idx === selectedIdx;
      row.classList.toggle("selected", on);
      if (on) row.scrollIntoView({ block: "nearest" });
    });
    renderSmartBar();
  }

  const filterDefs: Array<{ id: ClipboardFilter; label: ReturnType<typeof tl> }> = [
    { id: "all", label: tl("All") },
    { id: "pinned", label: tl("Pinned") },
    { id: "links", label: tl("Links") },
    { id: "images", label: tl("Images") },
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
      class: "clip-clear-btn clip-clear-danger",
      title: tl("Clear history"),
      text: tl("Clear history"),
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
  );

  const listEl = h("div", { class: "clip-list" });
  const smartBarEl = h("div", { class: "clip-smart-bar" });
  const qrOverlayEl = h("div", { class: "clip-qr-overlay", hidden: "true" });
  const footerEl = h("div", { class: "clip-footer" }, smartBarEl, clearBtn);
  const shell = h("div", { class: "clip-shell" }, toolbar, listEl, footerEl, qrOverlayEl);
  const el = h("div", { class: "view clip-view" }, shell);

  let smartFeedback: string | null = null;
  let smartFeedbackTimer: number | null = null;

  function closeQrOverlay() {
    qrOverlayEl.hidden = true;
    clear(qrOverlayEl);
  }

  async function openQrOverlay(text: string) {
    clear(qrOverlayEl);
    qrOverlayEl.hidden = false;
    const closeBtn = h(
      "button",
      {
        type: "button",
        class: "clip-qr-close",
        title: tl("Close"),
        onclick: (e: Event) => {
          e.stopPropagation();
          actions.blip();
          closeQrOverlay();
        },
      },
      svg(ICONS.xmark, 11),
    );
    const header = h(
      "div",
      { class: "clip-qr-head" },
      h("span", { class: "clip-qr-title", text: t("Scan QR Code") }),
      closeBtn,
    );
    const qrBox = h("div", { class: "clip-qr-box" }, h("span", { class: "clip-qr-loading", text: t("Generating…") }));
    const caption = h("div", { class: "clip-qr-caption", text: previewText(text) });
    const info = h("div", { class: "clip-qr-info" }, header, caption);
    const card = h("div", { class: "clip-qr-card" }, qrBox, info);
    qrOverlayEl.append(card);

    if (!IS_TAURI) {
      clear(qrBox);
      qrBox.append(h("span", { class: "clip-qr-loading", text: t("QR preview available in app") }));
      return;
    }
    try {
      const svgMarkup = await Bridge.clipboardQrSvg(text.trim());
      if (qrOverlayEl.hidden) return;
      clear(qrBox);
      qrBox.innerHTML = svgMarkup;
    } catch {
      if (qrOverlayEl.hidden) return;
      clear(qrBox);
      qrBox.append(h("span", { class: "clip-qr-loading", text: t("Unable to generate QR") }));
    }
  }

  async function openImagePreviewOverlay(entry: ClipboardEntry) {
    clear(qrOverlayEl);
    qrOverlayEl.hidden = false;
    const closeBtn = h(
      "button",
      {
        type: "button",
        class: "clip-qr-close",
        title: tl("Close"),
        onclick: (e: Event) => {
          e.stopPropagation();
          actions.blip();
          closeQrOverlay();
        },
      },
      svg(ICONS.xmark, 11),
    );
    const saveAction =
      IS_TAURI && entry.imagePath
        ? h(
            "button",
            {
              type: "button",
              class: "clip-smart-chip",
              text: t("Save PNG"),
              onclick: (e: Event) => {
                e.stopPropagation();
                actions.blip();
                if (entry.imagePath) void Bridge.clipboardSaveImage(entry.imagePath);
              },
            },
          )
        : null;
    const aiAction = entry.imagePath
      ? h(
          "button",
          {
            type: "button",
            class: "clip-smart-chip ai",
            text: t("Ask AI"),
            onclick: (e: Event) => {
              e.stopPropagation();
              actions.blip();
              if (entry.imagePath) actions.sendFileToChat?.(`${entry.id}.png`, entry.imagePath);
            },
          },
        )
      : null;
    const header = h(
      "div",
      { class: "clip-qr-head" },
      h("span", { class: "clip-qr-title", text: `${t("Image")} · ${entry.imageWidth ?? "?"}×${entry.imageHeight ?? "?"}` }),
      h("div", { class: "clip-img-head-acts" }, saveAction, aiAction, closeBtn),
    );
    const imgEl = entry.imageThumb
      ? (h("img", {
          class: "clip-img-preview",
          src: entry.imageThumb,
          alt: entry.text,
          onclick: (e: Event) => {
            e.stopPropagation();
            void copyAndCollapse(entry);
          },
        }) as HTMLImageElement)
      : null;
    qrOverlayEl.append(
      h(
        "div",
        { class: "clip-img-card" },
        header,
        imgEl ?? h("span", { class: "clip-qr-loading", text: t("Preview unavailable") }),
      ),
    );
    if (IS_TAURI && entry.imagePath && imgEl) {
      try {
        const fullDataUrl = await Bridge.clipboardReadImageDataUrl(entry.imagePath);
        if (!qrOverlayEl.hidden && imgEl.isConnected) {
          imgEl.src = fullDataUrl;
        }
      } catch {
        // Keep thumbnail fallback
      }
    }
  }

  async function runSmartAction(entry: ClipboardEntry, act: SmartClipboardAction) {
    actions.blip();
    if (act.id === "qr-code") {
      await openQrOverlay(entry.text);
      return;
    }
    if (act.id === "preview-image") {
      await openImagePreviewOverlay(entry);
      return;
    }
    if (act.id === "save-image" && entry.imagePath) {
      if (!IS_TAURI) return;
      try {
        await Bridge.clipboardSaveImage(entry.imagePath);
        smartFeedback = `✓ ${t("Saved")}`;
        if (smartFeedbackTimer != null) window.clearTimeout(smartFeedbackTimer);
        renderSmartBar();
        smartFeedbackTimer = window.setTimeout(() => {
          smartFeedback = null;
          renderSmartBar();
        }, 1400);
      } catch {
        // Ignore save errors
      }
      return;
    }
    if (act.id === "ask-ai-image" && entry.imagePath) {
      actions.sendFileToChat?.(`${entry.id}.png`, entry.imagePath);
      return;
    }
    if (act.aiPrompt) {
      actions.sendToChat?.(`${act.aiPrompt}${entry.text}`);
      return;
    }
    if (act.output != null) {
      const ok = await Clipboard.copyToSystem(act.output);
      if (!ok) return;
      smartFeedback = `✓ ${t("Copied")}`;
      if (smartFeedbackTimer != null) window.clearTimeout(smartFeedbackTimer);
      renderSmartBar();
      smartFeedbackTimer = window.setTimeout(() => {
        smartFeedback = null;
        renderSmartBar();
      }, 1200);
    }
  }

  function renderSmartBar() {
    clear(smartBarEl);
    const entry = visibleItems[selectedIdx];
    if (!entry) {
      smartBarEl.hidden = true;
      return;
    }
    const smartActions = getSmartClipboardActions(entry);
    if (smartActions.length === 0) {
      smartBarEl.hidden = true;
      return;
    }
    smartBarEl.hidden = false;
    smartBarEl.append(h("span", { class: "clip-smart-label", text: t("Smart") }));

    const chips = h("div", { class: "clip-smart-chips" });
    for (const act of smartActions) {
      const chip = h(
        "button",
        {
          type: "button",
          class: act.aiPrompt ? "clip-smart-chip ai" : "clip-smart-chip",
          title: act.hint ? `${t(act.label)} — ${act.hint}` : t(act.label),
          onclick: (e: Event) => {
            e.stopPropagation();
            void runSmartAction(entry, act);
          },
        },
        h("span", { text: t(act.label) }),
        act.hint ? h("span", { class: "clip-smart-hint", text: act.hint }) : null,
      );
      chips.append(chip);
    }
    smartBarEl.append(chips);

    if (smartFeedback) {
      smartBarEl.append(h("span", { class: "clip-smart-feedback", text: smartFeedback }));
    }
  }

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
      if (!qrOverlayEl.hidden) {
        closeQrOverlay();
      } else if (searchInput.value) {
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

    const badge = isMasked
      ? h("span", { class: "clip-kind-badge secret", title: tl("Sensitive") }, makeLockSvg())
      : entry.kind === "image"
        ? entry.imageThumb
          ? h("img", { class: "clip-thumb", src: entry.imageThumb, alt: entry.text })
          : h("span", { class: "clip-kind-pill img", text: tl("Image") })
        : entry.kind === "color"
          ? h("span", { class: "clip-swatch", style: `background:${entry.text.trim()}` })
          : entry.kind === "link"
            ? h("span", { class: "clip-kind-pill link" }, makeLinkSvg(), h("span", { text: tl("Link") }))
            : entry.kind === "code"
              ? h("span", { class: "clip-kind-pill code", text: tl("Code") })
              : entry.pinned
                ? h("span", { class: "clip-kind-pill pin", text: tl("Pinned") })
                : h("span", { class: "clip-kind-pill text", text: tl("Text") });

    const meta = isCopied
      ? h("span", { class: "clip-copied-tag", text: `✓ ${t("Copied")}` })
      : h("span", {
          class: "clip-meta",
          text: formatClipboardAge(entry.copiedAt).toUpperCase(),
        });

    const previewCls = isMasked
      ? "clip-preview masked"
      : entry.kind === "code"
        ? "clip-preview code"
        : "clip-preview";

    const displayText = isMasked
      ? maskSensitiveText(entry.text)
      : entry.kind === "image"
        ? `${t("Image")} · ${entry.imageWidth ?? "?"}×${entry.imageHeight ?? "?"}`
        : previewText(entry.text);

    const main = h(
      "div",
      { class: "clip-main" },
      h("div", { class: previewCls, text: displayText }),
    );

    const previewBtn =
      entry.kind === "image" && (entry.imageThumb || entry.imagePath)
        ? h(
            "button",
            {
              type: "button",
              class: "clip-act",
              title: tl("Preview"),
              onclick: (e: Event) => {
                e.stopPropagation();
                actions.blip();
                void openImagePreviewOverlay(entry);
              },
            },
            svg(ICONS.eye, 11, { stroke: 1.8 }),
          )
        : null;

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

    const agendaBtn =
      !isMasked && entry.kind !== "image"
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

    const chatBtn =
      !isMasked && (entry.kind !== "image" || !!entry.imagePath)
        ? h(
            "button",
            {
              type: "button",
              class: "clip-act",
              title: tl("Ask AI"),
              onclick: (e: Event) => {
                e.stopPropagation();
                actions.blip();
                if (entry.kind === "image" && entry.imagePath) {
                  actions.sendFileToChat?.(`${entry.id}.png`, entry.imagePath);
                } else {
                  actions.sendToChat?.(entry.text);
                }
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
      entry.kind === "image" ? "is-image" : "",
      isCopied ? "copied" : "",
      entry.pinned ? "pinned" : "",
      isSelected ? "selected" : "",
    ]
      .filter(Boolean)
      .join(" ");

    if (filter === "images" && entry.kind === "image") {
      const tile = h(
        "div",
        {
          class: `clip-img-tile${isSelected ? " selected" : ""}${isCopied ? " copied" : ""}${entry.pinned ? " pinned" : ""}`,
          onmouseenter: () => {
            if (selectedIdx !== index) {
              selectedIdx = index;
              listEl.querySelectorAll<HTMLElement>(".clip-img-tile").forEach((r, i) => {
                r.classList.toggle("selected", i === selectedIdx);
              });
              renderSmartBar();
            }
          },
          onclick: () => void copyAndCollapse(entry),
        },
        entry.imageThumb
          ? h("img", { class: "clip-img-tile-img", src: entry.imageThumb, alt: entry.text })
          : h("div", { class: "clip-img-tile-empty", text: t("Image") }),
        h(
          "div",
          { class: "clip-img-tile-bar" },
          h("span", {
            class: "clip-img-tile-dim",
            text: isCopied ? `✓ ${t("Copied")}` : `${entry.imageWidth ?? "?"}×${entry.imageHeight ?? "?"}`,
          }),
          h("div", { class: "clip-actions" }, previewBtn, pinBtn, chatBtn, delBtn),
        ),
      );
      return tile;
    }

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
            renderSmartBar();
          }
        },
        onclick: () => void copyAndCollapse(entry),
      },
      badge,
      main,
      meta,
      h("div", { class: "clip-actions" }, previewBtn, revealBtn, pinBtn, openBtn, agendaBtn, chatBtn, delBtn),
    );
    return row;
  }

  function renderList() {
    clear(listEl);
    listEl.classList.toggle("grid", filter === "images");
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
      renderSmartBar();
      return;
    }
    if (selectedIdx >= items.length) selectedIdx = items.length - 1;
    if (selectedIdx < 0) selectedIdx = 0;
    for (let i = 0; i < items.length; i++) {
      listEl.append(renderEntry(items[i], i));
    }
    renderSmartBar();
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
      closeQrOverlay();
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
