// Live local weather & air quality view for the expanded island.
// Features a real-time Canvas weather particle engine (rain, storm lightning,
// snow, wind-driven clouds, sunbeams, twinkling stars), interactive hourly
// weather preview on hover/click, AQI spectrum bar, and global city search.

import { State } from "../core/state";
import {
  Weather,
  aqiInfo,
  convertTemp,
  formatTemp,
  formatWeatherLocationSub,
  isHourDaytime,
  upcomingHourly,
  upcomingRainPeak,
  uvLevel,
  weatherAdvisory,
  wmoCondition,
  type WeatherAdvisory,
  type WeatherKind,
  type WeatherLocation,
  type WeatherSnapshot,
} from "../core/weather";
import { language, t, tl } from "../i18n/i18n";
import { clear, h, svg } from "./dom";
import { ICONS } from "./icons";
import type { ViewActions, ViewHost } from "./views";

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, String(v));
  }
  return el;
}

/** Builds a lightweight animated SVG illustration for the current weather condition. */
function buildWeatherArt(kind: WeatherKind, isDay: boolean): SVGSVGElement {
  const root = svgEl("svg", {
    viewBox: "0 0 64 64",
    width: 54,
    height: 54,
    class: `weather-svg weather-svg-${kind}`,
    "aria-hidden": "true",
  });

  if (kind === "clear" && isDay) {
    const rays = svgEl("g", { class: "w-sun-rays", stroke: "#FBBF24", "stroke-width": 2.4, "stroke-linecap": "round" });
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      rays.append(
        svgEl("line", {
          x1: (32 + Math.cos(a) * 18).toFixed(1),
          y1: (32 + Math.sin(a) * 18).toFixed(1),
          x2: (32 + Math.cos(a) * 23).toFixed(1),
          y2: (32 + Math.sin(a) * 23).toFixed(1),
        }),
      );
    }
    root.append(rays, svgEl("circle", { cx: 32, cy: 32, r: 12, fill: "#F59E0B", class: "w-sun-core" }));
    return root;
  }

  if (kind === "clear" && !isDay) {
    root.append(
      svgEl("path", {
        d: "M38 15a16 16 0 1 0 13 25.2A13 13 0 0 1 38 15z",
        fill: "#E2E8F0",
        class: "w-moon",
      }),
      svgEl("circle", { cx: 47, cy: 18, r: 1.6, fill: "#FDE68A", class: "w-star w-star-1" }),
      svgEl("circle", { cx: 20, cy: 17, r: 1.2, fill: "#FDE68A", class: "w-star w-star-2" }),
    );
    return root;
  }

  if (kind === "partly-cloudy") {
    if (isDay) {
      root.append(svgEl("circle", { cx: 24, cy: 24, r: 9.5, fill: "#FBBF24", class: "w-sun-core" }));
    } else {
      root.append(
        svgEl("path", {
          d: "M27 14a10 10 0 1 0 9 14.5A8.5 8.5 0 0 1 27 14z",
          fill: "#CBD5E1",
        }),
      );
    }
    root.append(
      svgEl("path", {
        d: "M21 44h23a8 8 0 0 0 1.2-15.9 11 11 0 0 0-21.3-2.5A8.5 8.5 0 0 0 21 44z",
        fill: "rgba(255,255,255,0.92)",
        class: "w-cloud",
      }),
    );
    return root;
  }

  const cloudFill = kind === "storm" ? "rgba(148,163,184,0.92)" : "rgba(226,232,240,0.92)";
  root.append(
    svgEl("path", {
      d: "M17 38h28a8.5 8.5 0 0 0 1.4-16.9A11.5 11.5 0 0 0 24 18.4 9 9 0 0 0 17 38z",
      fill: cloudFill,
      class: "w-cloud",
    }),
  );

  if (kind === "fog") {
    root.append(
      svgEl("line", { x1: 16, y1: 44, x2: 46, y2: 44, stroke: "rgba(255,255,255,0.55)", "stroke-width": 2.4, "stroke-linecap": "round" }),
      svgEl("line", { x1: 20, y1: 50, x2: 42, y2: 50, stroke: "rgba(255,255,255,0.38)", "stroke-width": 2.4, "stroke-linecap": "round" }),
    );
  } else if (kind === "drizzle" || kind === "rain") {
    const drops = kind === "rain" ? [21, 30, 39] : [25, 36];
    for (let i = 0; i < drops.length; i++) {
      root.append(
        svgEl("line", {
          x1: drops[i],
          y1: 42,
          x2: drops[i] - 2.5,
          y2: 51,
          stroke: "#38BDF8",
          "stroke-width": 2.4,
          "stroke-linecap": "round",
          class: `w-drop w-drop-${i + 1}`,
        }),
      );
    }
  } else if (kind === "snow") {
    for (const [i, cx] of [22, 32, 41].entries()) {
      root.append(
        svgEl("circle", {
          cx,
          cy: 46,
          r: 2.1,
          fill: "#E0F2FE",
          class: `w-drop w-drop-${i + 1}`,
        }),
      );
    }
  } else if (kind === "storm") {
    root.append(
      svgEl("polygon", {
        points: "33,38 26,48 31,48 28,57 39,45 33.5,45",
        fill: "#FACC15",
        class: "w-bolt",
      }),
    );
  }

  return root;
}

interface FxParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  alpha: number;
  phase: number;
}

interface FxScene {
  kind: WeatherKind;
  isDay: boolean;
  windKmh: number;
  cloudCover: number;
  precipMm: number;
}

/** Real-time interactive Canvas particle engine for live weather atmosphere. */
class WeatherFxEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private particles: FxParticle[] = [];
  private rafId: number | null = null;
  private lastTs = 0;
  private w = 520;
  private h = 194;
  private flashAlpha = 0;
  private nextFlashAt = 0;
  private pointer = { x: -999, y: -999, active: false };
  private scene: FxScene = {
    kind: "clear",
    isDay: true,
    windKmh: 8,
    cloudCover: 20,
    precipMm: 0,
  };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.seedParticles();
  }

  setPointer(x: number, y: number, active: boolean) {
    this.pointer.x = x;
    this.pointer.y = y;
    this.pointer.active = active;
  }

  triggerBurst() {
    if (this.scene.kind === "storm") {
      this.flashAlpha = 0.55;
      return;
    }
    for (let i = 0; i < Math.min(14, this.particles.length); i++) {
      this.particles[i].vy *= 1.35;
      this.particles[i].alpha = Math.min(1, this.particles[i].alpha + 0.35);
    }
  }

  setScene(next: FxScene) {
    const changed =
      this.scene.kind !== next.kind ||
      this.scene.isDay !== next.isDay ||
      Math.abs(this.scene.cloudCover - next.cloudCover) > 15;
    this.scene = next;
    if (changed) this.seedParticles();
  }

  start() {
    if (this.rafId != null) return;
    this.lastTs = performance.now();
    const loop = (now: number) => {
      if (State.view !== "weather" || State.mode !== "expanded") {
        this.rafId = null;
        return;
      }
      const dt = Math.min(0.05, Math.max(0.001, (now - this.lastTs) / 1000));
      this.lastTs = now;
      this.resizeIfNeeded();
      this.step(dt, now);
      this.draw(now);
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop() {
    if (this.rafId != null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private resizeIfNeeded() {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pw = Math.round(rect.width * dpr);
    const ph = Math.round(rect.height * dpr);
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }
    this.w = rect.width;
    this.h = rect.height;
    if (this.ctx) this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private seedParticles() {
    const k = this.scene.kind;
    let count = 18;
    if (k === "rain" || k === "storm") count = Math.min(72, 36 + Math.round(this.scene.precipMm * 8));
    else if (k === "drizzle") count = 28;
    else if (k === "snow") count = 36;
    else if (k === "clear" && !this.scene.isDay) count = 28;
    else if (k === "cloudy" || k === "fog" || k === "partly-cloudy") count = 12;

    this.particles = Array.from({ length: count }, () => this.spawnParticle(true));
  }

  private spawnParticle(randomY: boolean): FxParticle {
    const k = this.scene.kind;
    const windDrift = Math.max(8, this.scene.windKmh * 1.8);
    if (k === "rain" || k === "storm" || k === "drizzle") {
      const speed = k === "drizzle" ? 170 : k === "storm" ? 310 : 250;
      return {
        x: Math.random() * (this.w + 60) - 30,
        y: randomY ? Math.random() * this.h : -12,
        vx: -windDrift * 1.1,
        vy: speed + Math.random() * 80,
        size: k === "drizzle" ? 6 : 10 + Math.random() * 6,
        alpha: k === "drizzle" ? 0.28 + Math.random() * 0.22 : 0.35 + Math.random() * 0.35,
        phase: Math.random() * Math.PI * 2,
      };
    }
    if (k === "snow") {
      return {
        x: Math.random() * this.w,
        y: randomY ? Math.random() * this.h : -8,
        vx: -windDrift * 0.35,
        vy: 28 + Math.random() * 24,
        size: 1.5 + Math.random() * 2.2,
        alpha: 0.45 + Math.random() * 0.4,
        phase: Math.random() * Math.PI * 2,
      };
    }
    if (k === "cloudy" || k === "fog" || k === "partly-cloudy") {
      return {
        x: Math.random() * (this.w + 120) - 60,
        y: 12 + Math.random() * (this.h * 0.72),
        vx: 6 + windDrift * 0.25 + Math.random() * 6,
        vy: 0,
        size: 36 + Math.random() * 48,
        alpha: k === "fog" ? 0.08 : 0.055,
        phase: Math.random() * Math.PI * 2,
      };
    }
    // Clear day dust motes or clear night stars
    return {
      x: Math.random() * this.w,
      y: Math.random() * this.h,
      vx: this.scene.isDay ? 4 + Math.random() * 6 : 0,
      vy: this.scene.isDay ? -3 - Math.random() * 4 : 0,
      size: this.scene.isDay ? 1.4 + Math.random() * 1.6 : 0.9 + Math.random() * 1.4,
      alpha: 0.25 + Math.random() * 0.55,
      phase: Math.random() * Math.PI * 2,
    };
  }

  private step(dt: number, now: number) {
    const k = this.scene.kind;
    if (k === "storm") {
      if (this.flashAlpha > 0) this.flashAlpha = Math.max(0, this.flashAlpha - dt * 2.4);
      if (now > this.nextFlashAt) {
        this.flashAlpha = 0.42;
        this.nextFlashAt = now + 2600 + Math.random() * 4500;
      }
    } else {
      this.flashAlpha = 0;
    }

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;

      if (k === "snow") {
        p.x += Math.sin(now * 0.002 + p.phase) * 14 * dt;
      }

      // Gentle pointer deflection
      if (this.pointer.active) {
        const dx = p.x - this.pointer.x;
        const dy = p.y - this.pointer.y;
        const dist2 = dx * dx + dy * dy;
        if (dist2 > 1 && dist2 < 2400) {
          const push = (1 - Math.sqrt(dist2) / 49) * 90 * dt;
          p.x += (dx / Math.sqrt(dist2)) * push;
          p.y += (dy / Math.sqrt(dist2)) * push;
        }
      }

      if (k === "rain" || k === "storm" || k === "drizzle" || k === "snow") {
        if (p.y > this.h + 14 || p.x < -40 || p.x > this.w + 40) {
          this.particles[i] = this.spawnParticle(false);
        }
      } else if (k === "cloudy" || k === "fog" || k === "partly-cloudy") {
        if (p.x - p.size > this.w + 40) {
          p.x = -p.size - 20;
        }
      } else if (this.scene.isDay) {
        if (p.y < -8 || p.x > this.w + 8) {
          p.x = Math.random() * this.w * 0.7;
          p.y = this.h + 4;
        }
      }
    }
  }

  private draw(now: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.clearRect(0, 0, this.w, this.h);

    const k = this.scene.kind;

    // Interactive sunbeam glow on clear day
    if ((k === "clear" || k === "partly-cloudy") && this.scene.isDay) {
      const gx = this.pointer.active ? 54 + (this.pointer.x - 54) * 0.12 : 54;
      const gy = this.pointer.active ? 44 + (this.pointer.y - 44) * 0.12 : 44;
      const g = ctx.createRadialGradient(gx, gy, 4, gx, gy, 150);
      g.addColorStop(0, "rgba(251, 191, 36, 0.16)");
      g.addColorStop(1, "rgba(251, 191, 36, 0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, this.w, this.h);
    }

    if (this.flashAlpha > 0.01) {
      ctx.fillStyle = `rgba(224, 242, 254, ${this.flashAlpha.toFixed(3)})`;
      ctx.fillRect(0, 0, this.w, this.h);
    }

    for (const p of this.particles) {
      if (k === "rain" || k === "storm" || k === "drizzle") {
        ctx.strokeStyle = `rgba(125, 211, 252, ${p.alpha.toFixed(2)})`;
        ctx.lineWidth = k === "drizzle" ? 1 : 1.35;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + p.vx * 0.032, p.y + p.size);
        ctx.stroke();
      } else if (k === "snow") {
        ctx.fillStyle = `rgba(224, 242, 254, ${p.alpha.toFixed(2)})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      } else if (k === "cloudy" || k === "fog" || k === "partly-cloudy") {
        const g = ctx.createRadialGradient(p.x, p.y, 2, p.x, p.y, p.size);
        g.addColorStop(0, `rgba(226, 232, 240, ${p.alpha.toFixed(3)})`);
        g.addColorStop(1, "rgba(226, 232, 240, 0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      } else if (!this.scene.isDay) {
        const twinkle = 0.35 + 0.65 * Math.abs(Math.sin(now * 0.0018 + p.phase));
        ctx.fillStyle = `rgba(248, 250, 252, ${(p.alpha * twinkle).toFixed(2)})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = `rgba(253, 224, 71, ${(p.alpha * 0.45).toFixed(2)})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

function makePinIcon(): SVGSVGElement {
  const el = document.createElementNS(SVG_NS, "svg");
  el.setAttribute("viewBox", "0 0 16 16");
  el.setAttribute("width", "11");
  el.setAttribute("height", "11");
  el.setAttribute("fill", "none");
  el.setAttribute("class", "weather-pin-svg");
  el.innerHTML =
    `<path d="M8 1.5a4.25 4.25 0 0 0-4.25 4.25c0 3.05 4.25 8.75 4.25 8.75s4.25-5.7 4.25-8.75A4.25 4.25 0 0 0 8 1.5Z" stroke="currentColor" stroke-width="1.5"/>` +
    `<circle cx="8" cy="5.75" r="1.4" fill="currentColor"/>`;
  return el;
}

function makeGpsIcon(): SVGSVGElement {
  const el = document.createElementNS(SVG_NS, "svg");
  el.setAttribute("viewBox", "0 0 16 16");
  el.setAttribute("width", "12");
  el.setAttribute("height", "12");
  el.setAttribute("fill", "none");
  el.innerHTML =
    `<circle cx="8" cy="8" r="4.5" stroke="currentColor" stroke-width="1.45"/>` +
    `<circle cx="8" cy="8" r="1.5" fill="currentColor"/>` +
    `<path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2" stroke="currentColor" stroke-width="1.45" stroke-linecap="round"/>`;
  return el;
}

function formatHourLabel(iso: string): string {
  const idx = iso.indexOf("T");
  return idx >= 0 ? iso.slice(idx + 1, idx + 6) : iso;
}

function formatShortDay(dateIso: string, index: number): string {
  if (index === 0) return t("Today");
  const d = new Date(`${dateIso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return dateIso;
  return new Intl.DateTimeFormat(language() || undefined, { weekday: "short" }).format(d);
}

function formatClockTime(iso?: string | null): string {
  if (!iso) return "--:--";
  const idx = iso.indexOf("T");
  return idx >= 0 ? iso.slice(idx + 1, idx + 6) : iso;
}

function formatAdvisory(adv: WeatherAdvisory): { icon: string; text: string; tone: string } {
  switch (adv.kind) {
    case "rain-likely":
      return {
        icon: "☔",
        text: t("Rain likely around {hour} ({prob}%)", { hour: adv.hour, prob: adv.prob }),
        tone: "rain",
      };
    case "rain-clearing":
      return {
        icon: "🌤️",
        text: t("Rain may clear around {hour}", { hour: adv.hour }),
        tone: "clear",
      };
    case "rain-ongoing":
      return {
        icon: "🌧️",
        text: t("Rain continues nearby"),
        tone: "rain",
      };
    case "aqi":
      return {
        icon: "😷",
        text: t("Air quality alert (AQI {aqi})", { aqi: adv.value }),
        tone: "aqi",
      };
    case "uv":
      return {
        icon: "🕶️",
        text: t("High UV alert (UV {uv})", { uv: adv.value }),
        tone: "uv",
      };
  }
}

export function buildWeatherView(actions: ViewActions): ViewHost {
  let forecastTab: "hourly" | "daily" = "hourly";
  let hoveredHourIdx: number | null = null;
  let lockedHourIdx: number | null = null;
  let showAqiDetail = false;
  let searchOpen = false;
  let searchResults: WeatherLocation[] = [];
  let searching = false;
  let searchTimer: number | null = null;
  let reactedCity = "";

  const fxCanvas = h("canvas", { class: "weather-fx-canvas", "aria-hidden": "true" }) as HTMLCanvasElement;
  const fx = new WeatherFxEngine(fxCanvas);

  const shell = h("div", { class: "weather-shell" });
  const topBar = h("div", { class: "weather-top" });
  const bodyEl = h("div", { class: "weather-body" });

  shell.addEventListener("mousemove", (e: MouseEvent) => {
    const r = shell.getBoundingClientRect();
    fx.setPointer(e.clientX - r.left, e.clientY - r.top, true);
  });
  shell.addEventListener("mouseleave", () => {
    fx.setPointer(-999, -999, false);
  });

  const cityLabel = h("span", { class: "weather-city-name" });
  const cityBtn = h(
    "button",
    {
      type: "button",
      class: "weather-city-btn",
      title: tl("Change city"),
      onclick: () => {
        actions.blip();
        searchOpen = !searchOpen;
        renderSearch();
        if (searchOpen) {
          actions.holdOpen(true);
          actions.keyboard(true);
          searchInput.focus();
        } else {
          actions.holdOpen(false);
          actions.keyboard(false);
        }
      },
    },
    makePinIcon(),
    cityLabel,
    svg(ICONS.chevronDown, 11, { stroke: 2 }),
  );

  const liveBadge = h("span", { class: "weather-live-badge" });

  const gpsBtn = h(
    "button",
    {
      type: "button",
      class: "weather-icon-btn",
      title: tl("Detect current location"),
      onclick: async () => {
        actions.blip();
        const detected = await Weather.detectCurrentLocation();
        if (detected) {
          lockedHourIdx = null;
          hoveredHourIdx = null;
          await Weather.selectLocation(detected);
        }
      },
    },
    makeGpsIcon(),
  );

  const unitBtn = h("button", {
    type: "button",
    class: "weather-unit-btn",
    title: tl("Switch unit"),
    onclick: () => {
      actions.blip();
      Weather.setUnit(Weather.unit === "C" ? "F" : "C");
    },
  });

  const refreshBtn = h(
    "button",
    {
      type: "button",
      class: "weather-icon-btn",
      title: tl("Refresh weather"),
      onclick: () => {
        actions.blip();
        lockedHourIdx = null;
        hoveredHourIdx = null;
        void Weather.ensureLoaded(true);
      },
    },
    svg(ICONS.arrowClockwise, 13, { stroke: 1.9 }),
  );

  topBar.append(
    h("div", { class: "weather-top-left" }, cityBtn, gpsBtn, liveBadge),
    h("div", { class: "weather-top-actions" }, unitBtn, refreshBtn),
  );

  const searchOverlay = h("div", { class: "weather-search-overlay" });
  const searchInput = h("input", {
    type: "text",
    class: "weather-search-input",
    placeholder: tl("Search city…"),
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;
  const searchList = h("div", { class: "weather-search-results" });
  const autoDetectBtn = h("button", {
    type: "button",
    class: "weather-auto-btn",
    text: tl("Auto-detect"),
    onclick: async () => {
      actions.blip();
      searching = true;
      renderSearch();
      const detected = await Weather.detectCurrentLocation();
      if (detected) {
        closeSearch();
        lockedHourIdx = null;
        hoveredHourIdx = null;
        await Weather.selectLocation(detected);
        return;
      }
      searching = false;
      renderSearch();
    },
  });
  const closeSearchBtn = h(
    "button",
    {
      type: "button",
      class: "weather-icon-btn",
      title: tl("Close"),
      onclick: () => closeSearch(),
    },
    svg(ICONS.xmark, 12),
  );

  searchOverlay.append(
    h("div", { class: "weather-search-bar" }, searchInput, autoDetectBtn, closeSearchBtn),
    searchList,
  );

  function closeSearch() {
    searchOpen = false;
    searchInput.value = "";
    searchResults = [];
    actions.holdOpen(false);
    actions.keyboard(false);
    renderSearch();
  }

  searchInput.addEventListener("input", () => {
    const q = searchInput.value.trim();
    if (searchTimer != null) window.clearTimeout(searchTimer);
    if (q.length < 2) {
      searchResults = [];
      renderSearch();
      return;
    }
    searching = true;
    renderSearch();
    searchTimer = window.setTimeout(async () => {
      try {
        searchResults = await Weather.searchCities(q);
      } catch {
        searchResults = [];
      } finally {
        searching = false;
        renderSearch();
      }
    }, 280);
  });

  searchInput.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      closeSearch();
    }
  });

  function renderSearch() {
    searchOverlay.classList.toggle("open", searchOpen);
    if (!searchOpen) return;
    clear(searchList);
    if (searching) {
      searchList.append(h("div", { class: "weather-search-empty", text: t("Searching…") }));
      return;
    }
    const q = searchInput.value.trim();
    if (q.length >= 2 && searchResults.length === 0) {
      searchList.append(h("div", { class: "weather-search-empty", text: t("No cities found") }));
      return;
    }
    for (const loc of searchResults) {
      const sub = formatWeatherLocationSub(loc, searchResults);
      const row = h(
        "button",
        {
          type: "button",
          class: "weather-search-item",
          onclick: () => {
            actions.blip();
            closeSearch();
            lockedHourIdx = null;
            hoveredHourIdx = null;
            void Weather.selectLocation(loc);
          },
        },
        h("span", { class: "w-city", text: loc.name }),
        sub ? h("span", { class: "w-region", text: sub }) : null,
      );
      searchList.append(row);
    }
  }

  function renderBody(snap: WeatherSnapshot | null) {
    clear(bodyEl);

    if (!snap && Weather.loading) {
      bodyEl.append(h("div", { class: "weather-empty", text: t("Loading weather…") }));
      return;
    }
    if (!snap) {
      bodyEl.append(
        h(
          "div",
          { class: "weather-empty" },
          h("span", { text: Weather.error ? t("Weather unavailable") : t("No weather data") }),
          h("button", {
            type: "button",
            class: "btn secondary",
            text: tl("Retry"),
            onclick: () => void Weather.ensureLoaded(true),
          }),
        ),
      );
      return;
    }

    const hours = upcomingHourly(snap.hourly, new Date(), 8);
    const previewIdx = hoveredHourIdx ?? lockedHourIdx;
    const previewPt = previewIdx != null && previewIdx < hours.length ? hours[previewIdx] : null;
    const todayRise = snap.daily[0]?.sunrise ?? null;
    const todaySet = snap.daily[0]?.sunset ?? null;

    const activeCode = previewPt ? previewPt.weatherCode : snap.weatherCode;
    const activeIsDay = previewPt ? isHourDaytime(previewPt.time, todayRise, todaySet, snap.isDay) : snap.isDay;
    const activeTempC = previewPt ? previewPt.tempC : snap.tempC;
    const cond = wmoCondition(activeCode, activeIsDay);

    shell.dataset.mood = cond.kind === "clear" ? (activeIsDay ? "clear-day" : "clear-night") : cond.kind;
    fx.setScene({
      kind: cond.kind,
      isDay: activeIsDay,
      windKmh: snap.windKmh,
      cloudCover: snap.cloudCover ?? (cond.kind === "clear" ? 10 : 65),
      precipMm: snap.precipitationMm ?? (previewPt && previewPt.precipProb > 40 ? 2 : 0),
    });

    if (previewPt) {
      liveBadge.textContent = `${t("Preview")} · ${formatHourLabel(previewPt.time)}`;
      liveBadge.classList.add("preview");
    } else {
      const mins = Math.max(0, Math.floor((Date.now() / 1000 - snap.fetchedAt) / 60));
      liveBadge.textContent = mins < 1 ? `● ${t("Live")}` : `${mins}m`;
      liveBadge.classList.remove("preview");
    }

    const artWrap = h(
      "button",
      {
        type: "button",
        class: "weather-art",
        title: cond.label,
        onclick: () => {
          actions.blip();
          fx.triggerBurst();
          actions.emote?.(cond.emote);
        },
      },
      buildWeatherArt(cond.kind, activeIsDay),
    );

    const tempBtn = h("button", {
      type: "button",
      class: "weather-temp",
      title: tl("Switch unit"),
      text: formatTemp(activeTempC, Weather.unit),
      onclick: () => {
        actions.blip();
        Weather.setUnit(Weather.unit === "C" ? "F" : "C");
      },
    });
    const condText = h("div", { class: "weather-cond", text: t(cond.label) });
    const feelsText = h("div", {
      class: "weather-feels",
      text: previewPt
        ? `${formatHourLabel(previewPt.time)} · 💧${previewPt.precipProb}%`
        : `${t("Feels like")} ${formatTemp(snap.feelsLikeC, Weather.unit)}`,
    });

    const heroMain = h(
      "div",
      { class: "weather-hero-top" },
      artWrap,
      h("div", { class: "weather-hero-nums" }, tempBtn, condText, feelsText),
    );

    const aqi = aqiInfo(snap.usAqi);
    const aqiRow = h("div", { class: "weather-aqi-row" });
    if (aqi && snap.usAqi != null) {
      const pct = Math.min(98, Math.max(2, Math.round((snap.usAqi / 300) * 100)));
      const aqiBtn = h(
        "button",
        {
          type: "button",
          class: "weather-aqi-card",
          onclick: () => {
            actions.blip();
            showAqiDetail = !showAqiDetail;
            renderBody(snap);
          },
        },
        h(
          "div",
          { class: "weather-aqi-head" },
          h(
            "span",
            { class: "weather-aqi-label" },
            h("i", { class: "weather-aqi-dot", style: `background:${aqi.color};box-shadow:0 0 6px ${aqi.color}` }),
            h("span", { text: `AQI ${snap.usAqi} · ${t(aqi.label)}` }),
          ),
          snap.pm25 != null
            ? h("span", {
              class: "weather-pm-detail",
              text: showAqiDetail && snap.pm10 != null
                ? `PM2.5 ${snap.pm25.toFixed(0)} · PM10 ${snap.pm10.toFixed(0)}`
                : `PM2.5 ${snap.pm25.toFixed(1)}`,
            })
            : null,
        ),
        h("div", { class: "weather-aqi-bar" }, h("i", { class: "weather-aqi-marker", style: `left:${pct}%` })),
      );
      aqiRow.append(aqiBtn);
    }

    const rainPeak = upcomingRainPeak(snap, new Date(), 6);
    const metrics = h(
      "div",
      { class: "weather-metrics" },
      h("span", { class: "weather-metric", title: tl("Humidity"), text: `💧 ${snap.humidity}%` }),
      h("span", { class: "weather-metric", title: tl("Wind"), text: `💨 ${Math.round(snap.windKmh)} km/h` }),
      h("span", { class: "weather-metric", title: tl("UV index"), text: `☀️ UV ${Math.round(snap.uvIndex)} · ${t(uvLevel(snap.uvIndex))}` }),
      snap.precipitationMm && snap.precipitationMm > 0
        ? h("span", { class: "weather-metric", title: tl("Precipitation"), text: `🌧️ ${snap.precipitationMm.toFixed(1)} mm` })
        : rainPeak
          ? h("span", { class: "weather-metric", title: tl("Rain chance"), text: `☔ ${rainPeak.precipProb}% · ${rainPeak.hour}` })
          : snap.cloudCover != null
            ? h("span", { class: "weather-metric", title: tl("Cloud cover"), text: `☁️ ${snap.cloudCover}%` })
            : null,
    );

    const leftCol = h("div", { class: "weather-hero" }, heroMain, aqiRow, metrics);

    const tabHourly = h("button", {
      type: "button",
      class: forecastTab === "hourly" ? "weather-ftab on" : "weather-ftab",
      text: tl("Hourly"),
      onclick: () => {
        if (forecastTab === "hourly") return;
        actions.blip();
        forecastTab = "hourly";
        renderBody(snap);
      },
    });
    const tabDaily = h("button", {
      type: "button",
      class: forecastTab === "daily" ? "weather-ftab on" : "weather-ftab",
      text: tl("3-Day"),
      onclick: () => {
        if (forecastTab === "daily") return;
        actions.blip();
        forecastTab = "daily";
        renderBody(snap);
      },
    });

    const resetNowBtn =
      lockedHourIdx != null
        ? h("button", {
          type: "button",
          class: "weather-now-btn",
          text: tl("Now"),
          onclick: () => {
            actions.blip();
            lockedHourIdx = null;
            hoveredHourIdx = null;
            renderBody(snap);
          },
        })
        : null;

    const forecastHead = h(
      "div",
      { class: "weather-fhead" },
      h("div", { class: "weather-ftabs" }, tabHourly, tabDaily, resetNowBtn),
    );

    const forecastContent = h("div", { class: "weather-fcontent" });

    if (forecastTab === "hourly") {
      if (hours.length > 0) {
        const temps = hours.map((p) => convertTemp(p.tempC, Weather.unit));
        const minT = Math.min(...temps);
        const maxT = Math.max(...temps);
        const span = Math.max(1, maxT - minT);

        const activeIdx = previewIdx != null && previewIdx < hours.length ? previewIdx : 0;
        const activePt = hours[activeIdx];
        const activePtDay = isHourDaytime(activePt.time, todayRise, todaySet, snap.isDay);
        const activeCond = wmoCondition(activePt.weatherCode, activePtDay);

        const inspectEl = h("div", {
          class: "weather-inspect",
          text: `${formatHourLabel(activePt.time)} · ${t(activeCond.label)}${activePt.precipProb > 0 ? ` · 💧${activePt.precipProb}%` : ""}`,
        });
        forecastHead.append(inspectEl);

        const bars = h("div", {
          class: "weather-bars",
          onmouseleave: () => {
            if (hoveredHourIdx != null) {
              hoveredHourIdx = null;
              renderBody(snap);
            }
          },
        });
        for (let i = 0; i < hours.length; i++) {
          const pt = hours[i];
          const tVal = temps[i];
          const pct = maxT === minT ? 55 : 32 + Math.round(((tVal - minT) / span) * 60);
          const ptDay = isHourDaytime(pt.time, todayRise, todaySet, snap.isDay);
          const ptCond = wmoCondition(pt.weatherCode, ptDay);
          const isSelected = previewIdx != null ? i === previewIdx : i === 0;
          const isNextDayStart = i > 0 && pt.time.slice(0, 10) !== hours[i - 1].time.slice(0, 10);
          const colClass = [
            "weather-bar-col",
            isSelected ? "on" : "",
            isNextDayStart ? "next-day" : "",
          ]
            .filter(Boolean)
            .join(" ");
          const col = h(
            "button",
            {
              type: "button",
              class: colClass,
              onmouseenter: () => {
                if (hoveredHourIdx !== i) {
                  hoveredHourIdx = i;
                  renderBody(snap);
                }
              },
              onclick: () => {
                actions.blip();
                lockedHourIdx = lockedHourIdx === i ? null : i;
                hoveredHourIdx = null;
                renderBody(snap);
              },
            },
            h("span", { class: "w-bar-temp", text: `${tVal}°` }),
            h(
              "div",
              { class: "w-bar-track" },
              h("div", { class: "w-bar-fill", style: `height:${pct}%` }),
            ),
            h("span", { class: "w-bar-icon", text: ptCond.emoji }),
            h("span", {
              class: pt.precipProb > 0 ? "w-bar-rain" : "w-bar-rain mute",
              text: pt.precipProb > 0 ? `${pt.precipProb}%` : "·",
            }),
            h("span", {
              class: isNextDayStart ? "w-bar-hr next" : "w-bar-hr",
              text: formatHourLabel(pt.time).slice(0, 2),
            }),
          );
          bars.append(col);
        }

        forecastContent.append(bars);
      }
    } else {
      const days = snap.daily.slice(0, 3);
      if (days.length > 0) {
        const allMin = Math.min(...days.map((d) => convertTemp(d.tempMinC, Weather.unit)));
        const allMax = Math.max(...days.map((d) => convertTemp(d.tempMaxC, Weather.unit)));
        const span = Math.max(1, allMax - allMin);

        if (days[0].sunrise || days[0].sunset) {
          forecastHead.append(
            h("div", {
              class: "weather-inspect",
              text: `🌅 ${formatClockTime(days[0].sunrise)} · 🌇 ${formatClockTime(days[0].sunset)}`,
            }),
          );
        }

        const dailyList = h("div", { class: "weather-daily-list" });
        for (let i = 0; i < days.length; i++) {
          const d = days[i];
          const lo = convertTemp(d.tempMinC, Weather.unit);
          const hi = convertTemp(d.tempMaxC, Weather.unit);
          const leftPct = Math.round(((lo - allMin) / span) * 100);
          const widthPct = Math.max(12, Math.round(((hi - lo) / span) * 100));
          const c = wmoCondition(d.weatherCode, true);

          dailyList.append(
            h(
              "div",
              { class: "weather-daily-row" },
              h("span", { class: "w-day-name", text: formatShortDay(d.date, i) }),
              h("span", { class: "w-day-ico", text: c.emoji, title: t(c.label) }),
              h("span", { class: "w-day-lo", text: `${lo}°` }),
              h(
                "div",
                { class: "w-day-range" },
                h("div", { class: "w-day-fill", style: `left:${leftPct}%;width:${widthPct}%` }),
              ),
              h("span", { class: "w-day-hi", text: `${hi}°` }),
            ),
          );
        }
        forecastContent.append(dailyList);
      }
    }

    const advisory = weatherAdvisory(snap);
    const advisoryEl = advisory
      ? (() => {
        const info = formatAdvisory(advisory);
        return h(
          "div",
          { class: `weather-advisory tone-${info.tone}` },
          h("span", { class: "weather-advisory-ico", text: info.icon }),
          h("span", { class: "weather-advisory-text", text: info.text }),
        );
      })()
      : null;

    const rightCol = h("div", { class: "weather-forecast" }, forecastHead, forecastContent, advisoryEl);
    bodyEl.append(leftCol, rightCol);
  }

  shell.append(fxCanvas, topBar, bodyEl, searchOverlay);
  const el = h("div", { class: "view weather" }, shell);

  function sync() {
    const snap = Weather.snapshot;
    const locName = snap?.city ?? Weather.location?.name ?? t("Weather");
    cityLabel.textContent = locName;
    unitBtn.textContent = `°${Weather.unit}`;
    refreshBtn.classList.toggle("spinning", Weather.loading);
    renderBody(snap);
    if (State.view === "weather" && State.mode === "expanded") {
      fx.start();
    } else {
      fx.stop();
    }
  }

  Weather.subscribe(() => {
    if (State.view === "weather") sync();
  });

  return {
    el,
    sync() {
      void Weather.ensureLoaded(false);
      sync();
      const snap = Weather.snapshot;
      if (snap && reactedCity !== snap.city) {
        reactedCity = snap.city;
        const cond = wmoCondition(snap.weatherCode, snap.isDay);
        actions.emote?.(cond.emote);
      }
    },
    focus() {
      void Weather.ensureLoaded(false);
      fx.start();
    },
  };
}
