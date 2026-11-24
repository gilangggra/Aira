// Local file converter view — FFmpeg (video/audio) and LibreOffice headless +
// Pandoc (office documents, EPUB, Markdown, PDF), running 100% locally via Rust.

import { Bridge, onEvent } from "../core/bridge";
import {
  engineRequirementLabel,
  formatBytes,
  isToolInstallBusy,
  isToolInstallDone,
  type ConvertInspect,
  type ConvertOption,
  type ConvertResult,
  type ConverterToolInfo,
  type ToolInstallStep,
} from "../core/converter";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { N_, t, tl } from "../i18n/i18n";
import { clear, h, svg } from "./dom";
import { ICONS } from "./icons";
import type { ViewActions, ViewHost } from "./views";

const OPTION_KEYS: Record<string, string> = {
  mp4: N_("MP4 Video"),
  compress_mp4: N_("Compress MP4"),
  compress_gif: N_("Compress GIF"),
  mp3: N_("Extract MP3"),
  wav: N_("WAV Audio"),
  m4a: N_("M4A Audio"),
  ogg: N_("OGG Audio"),
  gif: N_("GIF"),
  pdf: N_("PDF"),
  docx: N_("Word (DOCX)"),
  xlsx: N_("Excel (XLSX)"),
  pptx: N_("PowerPoint (PPTX)"),
  csv: N_("CSV"),
  md: N_("Markdown"),
  epub: N_("EPUB"),
  html: N_("HTML"),
  txt: N_("Plain Text"),
};

function optionLabel(opt: ConvertOption, ext: string): string {
  if (opt.id === "mp3" && !["mp4", "mkv", "mov", "avi", "webm", "flv", "wmv", "m4v", "3gp"].includes(ext)) {
    return t("MP3 Audio");
  }
  const key = OPTION_KEYS[opt.id];
  return key ? t(key) : opt.label;
}

export function buildConvertView(actions: ViewActions): ViewHost {
  const fileNameEl = h("div", { class: "conv-file-name" });
  const fileMetaEl = h("div", { class: "conv-file-meta" });
  const pickBtn = h(
    "button",
    {
      type: "button",
      class: "conv-pick-btn",
      onclick: () => void pickFile(),
    },
    svg(ICONS.folder, 11),
    h("span", { text: tl("Choose file…") }),
  );
  const clearBtn = h(
    "button",
    {
      type: "button",
      class: "conv-clear-btn",
      title: tl("Clear"),
      "aria-label": tl("Clear"),
      onclick: () => {
        if (busyTarget) return;
        actions.blip();
        clearFile();
      },
    },
    svg(ICONS.xmark, 11, { stroke: 2 }),
  );
  const toolsRow = h("div", { class: "conv-tools" });
  const bodyEl = h("div", { class: "conv-body" });

  const card = h(
    "div",
    { class: "card conv-card" },
    h(
      "div",
      { class: "conv-head" },
      h("div", { class: "conv-file-info" }, fileNameEl, fileMetaEl),
      toolsRow,
      pickBtn,
      clearBtn,
    ),
    bodyEl,
  );
  const el = h("div", { class: "view" }, card);

  let inspectedPath: string | null = null;
  let inspected: ConvertInspect | null = null;
  let tools: ConverterToolInfo[] = [];
  let busyTarget: string | null = null;
  let lastResult: ConvertResult | null = null;
  let errorMsg: string | null = null;
  let installStep: ToolInstallStep = { step: "idle" };
  let loading = false;

  void onEvent<ToolInstallStep>("converter-install", (step) => {
    installStep = step;
    if (isToolInstallDone(step)) {
      void refreshTools();
      if (inspectedPath) void inspectActive(true);
    }
    render();
  });

  function isInstallBusy(): boolean {
    return isToolInstallBusy(installStep);
  }

  function toolDisplayName(id: string): string {
    return tools.find((x) => x.id === id)?.name ?? (id === "ffmpeg" ? "FFmpeg" : id === "libreoffice" ? "LibreOffice" : "Pandoc");
  }

  function installStatusText(step: ToolInstallStep): string {
    if (step.step === "checking") return t("Checking {tool}…", { tool: toolDisplayName(step.tool) });
    if (step.step === "downloading") {
      return t("Downloading {tool} (~{mb} MB)…", { tool: toolDisplayName(step.tool), mb: step.megabytes });
    }
    if (step.step === "installing") return t("Installing {tool}…", { tool: toolDisplayName(step.tool) });
    if (step.step === "uninstalling") return t("Uninstalling {tool}…", { tool: toolDisplayName(step.tool) });
    return "";
  }

  function clearFile() {
    State.droppedFile = null;
    State.droppedOriginalPath = null;
    inspectedPath = null;
    inspected = null;
    lastResult = null;
    errorMsg = null;
    busyTarget = null;
    State.notify();
    render();
  }

  function activeSourcePath(): { primary: string; fallback: string | null } | null {
    const primary = State.droppedOriginalPath || State.droppedFile?.path || null;
    if (!primary) return null;
    const fallback =
      State.droppedFile?.path && State.droppedFile.path !== primary ? State.droppedFile.path : null;
    return { primary, fallback };
  }

  async function refreshTools() {
    const [list, step] = await Promise.all([
      Bridge.converterTools(),
      Bridge.converterInstallStatus(),
    ]);
    if (list) tools = list;
    if (step && (step.step === "checking" || step.step === "downloading" || step.step === "installing")) {
      installStep = step;
    }
    if (list || step) render();
  }

  async function inspectActive(force = false) {
    const src = activeSourcePath();
    if (!src) {
      inspectedPath = null;
      inspected = null;
      if (tools.length === 0) void refreshTools();
      render();
      return;
    }
    if (!force && inspectedPath === src.primary && inspected) {
      render();
      return;
    }
    inspectedPath = src.primary;
    loading = true;
    errorMsg = null;
    lastResult = null;
    render();
    try {
      const info = await Bridge.converterInspect(src.primary, src.fallback);
      if (inspectedPath !== src.primary) return;
      inspected = info;
      tools = info.tools;
    } catch (err) {
      if (inspectedPath !== src.primary) return;
      inspected = null;
      errorMsg = String(err).replace(/^Error:\s*/, "");
      void refreshTools();
    } finally {
      if (inspectedPath === src.primary) {
        loading = false;
        render();
      }
    }
  }

  async function pickFile() {
    if (busyTarget) return;
    actions.blip();
    actions.holdOpen(true);
    const picked = await Bridge.converterPickFile();
    actions.holdOpen(false);
    if (!picked) return;
    const name = picked.split(/[\\/]/).pop() || "file";
    State.droppedOriginalPath = picked;
    State.droppedFile = { name, path: picked };
    lastResult = null;
    errorMsg = null;
    await inspectActive(true);
  }

  async function runConvert(opt: ConvertOption) {
    if (busyTarget || isInstallBusy() || !inspected) return;
    if (!opt.available) {
      actions.blip();
      const missingName = engineRequirementLabel(opt);
      errorMsg = t("Please install {tool} in Settings to convert this format.", {
        tool: missingName,
      });
      Sound.play("error");
      render();
      return;
    }

    const src = activeSourcePath();
    if (!src) return;
    actions.blip();
    busyTarget = opt.id;
    errorMsg = null;
    lastResult = null;
    actions.holdOpen(true);
    render();

    try {
      const res = await Bridge.converterConvert(src.primary, src.fallback, opt.id);
      lastResult = res;
      Sound.play("approve");
      actions.emote?.("happy");
    } catch (err) {
      errorMsg = String(err).replace(/^Error:\s*/, "");
      Sound.play("error");
    } finally {
      busyTarget = null;
      actions.holdOpen(false);
      render();
    }
  }

  function renderTools() {
    clear(toolsRow);
    const activeInstall = isInstallBusy() ? installStep : null;
    for (const tool of tools) {
      const installingThis = activeInstall != null && "tool" in activeInstall && activeInstall.tool === tool.id;
      const cls = tool.available
        ? "conv-tool ok"
        : installingThis
          ? "conv-tool installing"
          : "conv-tool missing";
      const badge = h(
        "button",
        {
          type: "button",
          class: cls,
          title: tool.available
            ? `${tool.name}: ${tool.path ?? ""}`
            : t("{tool} is not installed — configure in Settings", { tool: tool.name }),
          onclick: () => {
            if (!tool.available) {
              actions.blip();
              actions.openSettingsWindow("integrations");
            }
          },
        },
        h("i", { class: "conv-tool-dot" }),
        h("span", { text: tool.name }),
      );
      toolsRow.append(badge);
    }
  }

  function render() {
    renderTools();
    clear(bodyEl);
    const src = activeSourcePath();
    clearBtn.style.display = src && !busyTarget && !isInstallBusy() ? "" : "none";

    if (isInstallBusy()) {
      fileNameEl.textContent = inspected?.name ?? t("Local File Converter");
      fileMetaEl.textContent = inspected
        ? `${inspected.ext ? `.${inspected.ext.toUpperCase()} · ` : ""}${formatBytes(inspected.size)}`
        : "FFmpeg · LibreOffice · Pandoc";
      bodyEl.append(
        h(
          "div",
          { class: "conv-status busy" },
          h("span", { class: "conv-spinner" }),
          h("span", { text: installStatusText(installStep) }),
        ),
      );
      return;
    }

    if (!src) {
      fileNameEl.textContent = t("Local File Converter");
      fileMetaEl.textContent = "FFmpeg · LibreOffice · Pandoc";
      if (errorMsg) {
        bodyEl.append(
          h(
            "div",
            { class: "conv-error" },
            h("div", { class: "conv-error-msg", text: errorMsg }),
            h("button", {
              type: "button",
              class: "conv-error-link",
              text: t("Open Settings"),
              onclick: () => {
                actions.blip();
                actions.openSettingsWindow("integrations");
              },
            }),
          ),
        );
      }
      bodyEl.append(
        h(
          "div",
          { class: "conv-empty" },
          h("div", {
            class: "conv-empty-title",
            text: t("Drop a video, audio, or document onto the island, or choose a file."),
          }),
          h(
            "div",
            { class: "conv-empty-caps" },
            h("span", { class: "conv-cap", text: "FFmpeg · MP4 · MP3 · GIF" }),
            h("span", { class: "conv-cap", text: "LibreOffice & Pandoc · DOCX · XLSX · PPTX · EPUB · MD · PDF" }),
          ),
        ),
      );
      return;
    }

    const fallbackName = State.droppedFile?.name || src.primary.split(/[\\/]/).pop() || "file";
    fileNameEl.textContent = inspected?.name ?? fallbackName;
    fileMetaEl.textContent = inspected
      ? `${inspected.ext ? `.${inspected.ext.toUpperCase()} · ` : ""}${formatBytes(inspected.size)}`
      : "";

    if (loading) {
      bodyEl.append(h("div", { class: "conv-status", text: t("Inspecting file…") }));
      return;
    }

    if (busyTarget) {
      const activeOpt = inspected?.options.find((o) => o.id === busyTarget);
      bodyEl.append(
        h(
          "div",
          { class: "conv-status busy" },
          h("span", { class: "conv-spinner" }),
          h("span", {
            text: t("Converting to {format}…", {
              format: activeOpt ? optionLabel(activeOpt, inspected?.ext ?? "") : busyTarget.toUpperCase(),
            }),
          }),
        ),
      );
      return;
    }

    if (lastResult) {
      bodyEl.append(
        h(
          "div",
          { class: "conv-done" },
          h(
            "div",
            { class: "conv-done-head" },
            h("span", { class: "conv-done-check" }, svg(ICONS.check, 12, { stroke: 2.5 })),
            h("span", { class: "conv-done-name", text: lastResult.outputName }),
          ),
          h("div", {
            class: "conv-done-meta",
            text: `${formatBytes(lastResult.size)} · ${lastResult.engine} · ${(lastResult.durationMs / 1000).toFixed(1)}s`,
          }),
          h(
            "div",
            { class: "conv-done-actions" },
            h("button", {
              type: "button",
              class: "btn primary",
              text: tl("Show in folder"),
              onclick: () => void Bridge.converterRevealOutput(lastResult!.outputPath),
            }),
            h("button", {
              type: "button",
              class: "btn secondary",
              text: tl("Done"),
              onclick: () => {
                actions.blip();
                clearFile();
              },
            }),
            h("button", {
              type: "button",
              class: "btn secondary",
              text: tl("Back"),
              onclick: () => {
                actions.blip();
                lastResult = null;
                render();
              },
            }),
          ),
        ),
      );
      return;
    }

    if (errorMsg) {
      bodyEl.append(
        h(
          "div",
          { class: "conv-error" },
          h("div", { class: "conv-error-msg", text: errorMsg }),
          h("button", {
            type: "button",
            class: "conv-error-link",
            text: t("Open Settings"),
            onclick: () => {
              actions.blip();
              actions.openSettingsWindow("integrations");
            },
          }),
        ),
      );
    }

    const opts = inspected?.options ?? [];
    if (opts.length === 0) {
      bodyEl.append(
        h("div", {
          class: "conv-status",
          text: t("No local conversion targets found for this file type."),
        }),
      );
      return;
    }

    const grid = h("div", { class: "conv-grid" });
    for (const opt of opts) {
      const missingTool = !opt.available
        ? tools.find((tool) => !tool.available && (tool.id === opt.engine || tool.id === opt.secondaryEngine))
        : undefined;
      const btn = h(
        "button",
        {
          type: "button",
          class: opt.available ? "conv-opt" : "conv-opt unavailable",
          title: opt.available
            ? undefined
            : t("Please install {tool} in Settings to convert this format.", {
              tool: missingTool?.name ?? engineRequirementLabel(opt),
            }),
          onclick: () => {
            if (!opt.available) {
              actions.blip();
              actions.openSettingsWindow("integrations");
              errorMsg = t("Please install {tool} in Settings to convert this format.", {
                tool: missingTool?.name ?? engineRequirementLabel(opt),
              });
              render();
              return;
            }
            void runConvert(opt);
          },
        },
        h("span", { class: "conv-opt-title", text: optionLabel(opt, inspected?.ext ?? "") }),
        h("span", {
          class: "conv-opt-sub",
          text: opt.available
            ? engineRequirementLabel(opt)
            : t("Needs {tool} (Settings)", { tool: missingTool?.name ?? engineRequirementLabel(opt) }),
        }),
      );
      grid.append(btn);
    }
    bodyEl.append(grid);
  }

  return {
    el,
    sync() {
      if (State.view === "convert" && State.mode === "expanded") {
        void inspectActive(false);
      } else if (lastResult && !busyTarget) {
        State.droppedFile = null;
        State.droppedOriginalPath = null;
        inspectedPath = null;
        inspected = null;
        lastResult = null;
        errorMsg = null;
      }
      render();
    },
  };
}
