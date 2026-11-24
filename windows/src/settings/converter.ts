// Settings → Integrations → File Converter Engines.
// Install on demand FFmpeg, Pandoc, and LibreOffice Headless without leaving Settings.

import { Bridge, onEvent } from "../core/bridge";
import type { ConverterEngine, ConverterToolInfo, ToolInstallStep } from "../core/converter";
import {
  isToolInstallBusy,
  isToolInstallFailed,
  isToolInstallFinished,
  makeToolInstallFailed,
} from "../core/converter";
import { h, clear } from "../views/dom";
import { t } from "../i18n/i18n";
import { statusDot } from "./parts";

interface EngineMeta {
  id: ConverterEngine;
  name: string;
  desc: () => string;
  sizeHint: string;
}

const ENGINES: EngineMeta[] = [
  {
    id: "ffmpeg",
    name: "FFmpeg",
    desc: () => t("Video & audio processing: MP4, MP3 extraction, GIF creation, and video compression."),
    sizeHint: "~70 MB",
  },
  {
    id: "pandoc",
    name: "Pandoc",
    desc: () => t("Document markup converter: Markdown, EPUB, DOCX, and HTML cross-conversion."),
    sizeHint: "~40 MB",
  },
  {
    id: "libreoffice",
    name: "LibreOffice (Headless)",
    desc: () => t("Office documents: Word DOCX, Excel XLSX, PowerPoint PPTX, and PDF without Microsoft Office."),
    sizeHint: "~350 MB",
  },
];

export function converterSection(): HTMLElement {
  let tools: ConverterToolInfo[] = [];
  let installStep: ToolInstallStep = { step: "idle" };

  const listEl = h("div", { class: "setting-list" });
  const section = h(
    "section",
    {},
    h("h2", {}, h("span", { text: t("File Converter Engines") })),
    h("div", {
      class: "hint",
      text: t(
        "Local engines for video, audio, and document conversion. Downloaded once on demand and run 100% locally on your computer with no cloud upload.",
      ),
    }),
    listEl,
  );

  async function refresh() {
    const [fetchedTools, status] = await Promise.all([
      Bridge.converterTools(),
      Bridge.converterInstallStatus(),
    ]);
    if (fetchedTools) tools = fetchedTools;
    if (status) installStep = status;
    draw();
  }

  void onEvent<ToolInstallStep>("converter-install", (step) => {
    installStep = step;
    if (isToolInstallFinished(step)) {
      void refresh();
    } else {
      draw();
    }
  });

  async function install(toolId: ConverterEngine) {
    if (isToolInstallBusy(installStep)) return;
    try {
      await Bridge.converterInstallTool(toolId);
    } catch (err) {
      installStep = makeToolInstallFailed(toolId, String(err).replace(/^Error:\s*/, ""));
      draw();
    }
  }

  async function uninstall(toolId: ConverterEngine) {
    if (isToolInstallBusy(installStep)) return;
    try {
      await Bridge.converterUninstallTool(toolId);
    } catch (err) {
      installStep = makeToolInstallFailed(toolId, String(err).replace(/^Error:\s*/, ""));
      draw();
    }
  }

  function draw() {
    clear(listEl);
    for (const meta of ENGINES) {
      const tool = tools.find((t) => t.id === meta.id) ?? {
        id: meta.id,
        name: meta.name,
        available: false,
        path: null,
        installUrl: "",
      };

      const isThisBusy = isToolInstallBusy(installStep) && "tool" in installStep && installStep.tool === meta.id;
      const dot = statusDot(tool.available);

      const title = h(
        "div",
        { class: "setting-title" },
        dot,
        h("span", { text: meta.name }),
      );

      const desc = h("div", {
        class: "setting-desc",
        text: `${meta.desc()} (${meta.sizeHint})`,
      });

      const info = h("div", { class: "setting-info" }, title, desc);
      if (tool.available && tool.path) {
        info.append(
          h("div", {
            style: "font-size:11px;color:var(--dim);word-break:break-all;font-family:monospace;margin-top:2px",
            text: tool.path,
          }),
        );
      }

      if (isToolInstallFailed(installStep) && installStep.tool === meta.id) {
        info.append(
          h("div", {
            class: "notice err",
            style: "margin-top:6px;font-size:11.5px",
            text: installStep.reason,
          }),
        );
      }

      const control = h("div", { class: "setting-control" });

      if (isThisBusy) {
        let label = t("Installing {tool}…", { tool: meta.name });
        if (installStep.step === "downloading") {
          label = t("Downloading {tool} (~{mb} MB)…", { tool: meta.name, mb: installStep.megabytes });
        } else if (installStep.step === "checking") {
          label = t("Checking {tool}…", { tool: meta.name });
        } else if (installStep.step === "uninstalling") {
          label = t("Uninstalling {tool}…", { tool: meta.name });
        }
        const busyText = h("span", {
          style: "font-size:12px;color:var(--dim)",
          text: label,
        });
        const spinner = h("span", { class: "conv-spinner", style: "display:inline-block" });
        control.append(spinner, busyText);
      } else if (tool.available) {
        const badge = h("span", {
          style: "font-size:12px;color:#22c55e;font-weight:500;margin-right:6px",
          text: `✓ ${t("Installed")}`,
        });
        const reinstallBtn = h("button", {
          type: "button",
          text: t("Reinstall"),
          onclick: () => void install(meta.id),
        });
        const uninstallBtn = h("button", {
          type: "button",
          class: "danger",
          text: t("Uninstall"),
          onclick: () => void uninstall(meta.id),
        });
        control.append(badge, reinstallBtn, uninstallBtn);
      } else {
        const installBtn = h("button", {
          type: "button",
          class: "primary",
          text: t("Install"),
          onclick: () => void install(meta.id),
        });
        control.append(installBtn);
      }

      listEl.append(h("div", { class: "setting-item" }, info, control));
    }
  }

  void refresh();
  return section;
}
