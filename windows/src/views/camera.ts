// Quick Camera Mirror view for the expanded notch — live mirrored preview,
// photo capture (PNG), video recording (WebM) with optional mic, and native
// Windows Camera Roll storage (Pictures\Camera Roll\WIN_YYYYMMDD_HH_MM_SS.*).
// Strictly stops all media tracks when closed or navigated away so the webcam
// LED turns off immediately.

import { Bridge } from "../core/bridge";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { t, tl } from "../i18n/i18n";
import { clear, h, svg } from "./dom";
import { ICONS } from "./icons";
import type { ViewActions, ViewHost } from "./views";

function formatStamp(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}_${pad(d.getMinutes())}_${pad(d.getSeconds())}`;
}

function formatRecDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read media blob"));
    reader.readAsDataURL(blob);
  });
}

export function buildCameraView(actions: ViewActions): ViewHost {
  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let recordedChunks: BlobPart[] = [];
  let recTimer: number | null = null;
  let recSeconds = 0;
  let mirrored = true;
  let micEnabled = false;
  let activeDeviceId = "";
  let devices: MediaDeviceInfo[] = [];
  let starting = false;
  let toastTimer: number | null = null;

  const videoEl = h("video", {
    class: "camera-video mirrored",
    autoplay: true,
    playsinline: true,
    muted: true,
  }) as HTMLVideoElement;

  const flashEl = h("div", { class: "camera-flash" });

  const recBadge = h(
    "div",
    { class: "camera-rec-badge", style: "display:none" },
    h("span", { class: "camera-rec-dot" }),
    h("span", { class: "camera-rec-time", text: "00:00" }),
  );
  const recTimeEl = recBadge.querySelector(".camera-rec-time") as HTMLElement;

  const toastBtn = h("button", {
    type: "button",
    class: "camera-toast",
    style: "display:none",
    onclick: () => {
      actions.blip();
      void Bridge.cameraRevealSaved();
    },
  });

  const switchCamBtn = h(
    "button",
    {
      type: "button",
      class: "camera-pill-btn",
      style: "display:none",
      onclick: () => {
        if (devices.length <= 1 || isRecording()) return;
        actions.blip();
        const idx = devices.findIndex((d) => d.deviceId === activeDeviceId);
        const next = devices[(idx + 1) % devices.length];
        activeDeviceId = next.deviceId;
        void startStream();
      },
    },
    svg(ICONS.camera, 12),
    h("span", { class: "camera-switch-lbl", text: "1/1" }),
  );
  const switchLbl = switchCamBtn.querySelector(".camera-switch-lbl") as HTMLElement;

  const mirrorBtn = h(
    "button",
    {
      type: "button",
      class: "camera-ctrl-btn on",
      title: "Mirror",
      onclick: () => {
        actions.blip();
        mirrored = !mirrored;
        videoEl.classList.toggle("mirrored", mirrored);
        mirrorBtn.classList.toggle("on", mirrored);
      },
    },
    svg(ICONS.flip, 14),
  );

  const micBtn = h(
    "button",
    {
      type: "button",
      class: "camera-ctrl-btn",
      title: "Mic",
      onclick: () => {
        if (isRecording()) return;
        actions.blip();
        micEnabled = !micEnabled;
        micBtn.classList.toggle("on", micEnabled);
        clear(micBtn);
        micBtn.append(svg(micEnabled ? ICONS.mic : ICONS.micOff, 14));
        if (stream) void startStream();
      },
    },
    svg(ICONS.micOff, 14),
  );

  const shutterBtn = h(
    "button",
    {
      type: "button",
      class: "camera-shutter-btn",
      title: tl("Photo"),
      onclick: () => void takePhoto(),
    },
    h("span", { class: "camera-shutter-core" }),
  );

  const recordBtn = h(
    "button",
    {
      type: "button",
      class: "camera-record-btn",
      title: tl("Record"),
      onclick: () => toggleRecording(),
    },
    h("span", { class: "camera-record-core" }),
  );

  const folderBtn = h(
    "button",
    {
      type: "button",
      class: "camera-ctrl-btn",
      title: "Camera Roll",
      onclick: () => {
        actions.blip();
        void Bridge.cameraRevealSaved();
      },
    },
    svg(ICONS.folder, 14),
  );

  const errorBox = h("div", { class: "camera-error", style: "display:none" });

  const topBar = h(
    "div",
    { class: "camera-top-hud" },
    recBadge,
    toastBtn,
    h("div", { class: "grow" }),
    switchCamBtn,
  );

  const bottomBar = h(
    "div",
    { class: "camera-bottom-hud" },
    mirrorBtn,
    micBtn,
    shutterBtn,
    recordBtn,
    folderBtn,
  );

  const stage = h(
    "div",
    { class: "camera-stage" },
    videoEl,
    flashEl,
    errorBox,
    topBar,
    bottomBar,
  );

  const el = h("div", { class: "view camera-view" }, stage);

  function isRecording(): boolean {
    return recorder != null && recorder.state === "recording";
  }

  function showToast(text: string) {
    toastBtn.textContent = text;
    toastBtn.style.display = "";
    if (toastTimer != null) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toastBtn.style.display = "none";
      toastTimer = null;
    }, 3200);
  }

  function showError(msg: string) {
    clear(errorBox);
    errorBox.append(
      svg(ICONS.camera, 22, { stroke: 1.5 }),
      h("div", { class: "camera-error-msg", text: msg }),
      h("button", {
        type: "button",
        class: "btn secondary",
        text: t("Retry"),
        onclick: () => {
          actions.blip();
          void startStream();
        },
      }),
    );
    errorBox.style.display = "flex";
  }

  function clearError() {
    errorBox.style.display = "none";
  }

  function stopRecordingTimer() {
    if (recTimer != null) {
      window.clearInterval(recTimer);
      recTimer = null;
    }
    recSeconds = 0;
    recBadge.style.display = "none";
    recordBtn.classList.remove("recording");
    micBtn.classList.remove("disabled");
  }

  function stopStream() {
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        // Ignore stop errors during teardown
      }
    }
    recorder = null;
    stopRecordingTimer();
    if (stream) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
      stream = null;
    }
    videoEl.srcObject = null;
  }

  async function refreshDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      devices = all.filter((d) => d.kind === "videoinput");
      if (devices.length > 1) {
        const idx = Math.max(0, devices.findIndex((d) => d.deviceId === activeDeviceId));
        switchLbl.textContent = `${idx + 1}/${devices.length}`;
        switchCamBtn.style.display = "";
      } else {
        switchCamBtn.style.display = "none";
      }
    } catch {
      switchCamBtn.style.display = "none";
    }
  }

  async function startStream() {
    if (starting) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      showError("Camera API unavailable");
      return;
    }
    starting = true;
    clearError();
    stopStream();

    try {
      const videoConstraint: MediaTrackConstraints | boolean = activeDeviceId
        ? { deviceId: { exact: activeDeviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
        : { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" };

      const nextStream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraint,
        audio: micEnabled,
      });

      // If the user closed the notch while getUserMedia was resolving, kill it immediately.
      if (State.mode !== "expanded" || State.view !== "camera") {
        for (const track of nextStream.getTracks()) track.stop();
        return;
      }

      stream = nextStream;
      const trackSettings = nextStream.getVideoTracks()[0]?.getSettings();
      if (trackSettings?.deviceId) activeDeviceId = trackSettings.deviceId;
      videoEl.srcObject = nextStream;
      await videoEl.play().catch(() => {});
      await refreshDevices();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showError(msg || "Camera permission denied");
    } finally {
      starting = false;
    }
  }

  async function takePhoto() {
    if (!stream || videoEl.videoWidth <= 0 || videoEl.videoHeight <= 0) return;
    Sound.play("pop");
    flashEl.classList.remove("on");
    void flashEl.offsetWidth;
    flashEl.classList.add("on");

    const canvas = document.createElement("canvas");
    canvas.width = videoEl.videoWidth;
    canvas.height = videoEl.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (mirrored) {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);

    const dataUrl = canvas.toDataURL("image/png");
    try {
      const savedPath = await Bridge.cameraSaveCapture(dataUrl, formatStamp(), "png");
      const fileName = savedPath.split(/[\\/]/).pop() ?? "Photo saved";
      showToast(`✓ ${fileName}`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Save failed");
    }
  }

  function pickRecorderMime(): { mimeType?: string; ext: "webm" | "mp4" } {
    if (typeof MediaRecorder === "undefined") return { ext: "webm" };
    const candidates = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ];
    for (const mime of candidates) {
      if (MediaRecorder.isTypeSupported(mime)) return { mimeType: mime, ext: "webm" };
    }
    return { ext: "webm" };
  }

  function toggleRecording() {
    if (!stream) return;
    if (isRecording()) {
      actions.blip();
      recorder?.stop();
      return;
    }
    if (typeof MediaRecorder === "undefined") {
      showToast("Recording unsupported");
      return;
    }

    actions.blip();
    const { mimeType, ext } = pickRecorderMime();
    recordedChunks = [];
    try {
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch {
      recorder = new MediaRecorder(stream);
    }

    const stamp = formatStamp();
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    };
    recorder.onstop = () => {
      const chunks = recordedChunks;
      recordedChunks = [];
      stopRecordingTimer();
      if (chunks.length === 0) return;
      const blob = new Blob(chunks, { type: mimeType ?? "video/webm" });
      void blobToDataUrl(blob)
        .then((dataUrl) => Bridge.cameraSaveCapture(dataUrl, stamp, ext))
        .then((savedPath) => {
          const fileName = savedPath.split(/[\\/]/).pop() ?? "Video saved";
          Sound.play("finish");
          showToast(`✓ ${fileName}`);
        })
        .catch((err) => {
          showToast(err instanceof Error ? err.message : "Save failed");
        });
    };

    recorder.start(250);
    recSeconds = 0;
    recTimeEl.textContent = "00:00";
    recBadge.style.display = "inline-flex";
    recordBtn.classList.add("recording");
    micBtn.classList.add("disabled");
    recTimer = window.setInterval(() => {
      recSeconds += 1;
      recTimeEl.textContent = formatRecDuration(recSeconds);
    }, 1000);
  }

  State.subscribe(() => {
    const active = State.mode === "expanded" && State.view === "camera";
    if (!active && (stream != null || isRecording())) {
      stopStream();
    }
  });

  return {
    el,
    sync() {
      const active = State.mode === "expanded" && State.view === "camera";
      if (active) {
        if (!stream && !starting) void startStream();
      } else if (stream != null || isRecording()) {
        stopStream();
      }
    },
  };
}
