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
  resolveDayPhase,
  upcomingHourly,
  upcomingRainPeak,
  uvLevel,
  weatherAdvisory,
  wmoCondition,
  type DayPhase,
  type WeatherAdvisory,
  type WeatherKind,
  type WeatherLocation,
  type WeatherSnapshot,
} from "../core/weather";
import { language, t, tl } from "../i18n/i18n";
import { clear, h, svg } from "./dom";
import { ICONS } from "./icons";
import type { ViewActions, ViewHost } from "./views";
import {
  buildMetricIcon,
  buildMiniWeatherIcon,
  resolveWeatherScene,
} from "./weather-art";

const SVG_NS = "http://www.w3.org/2000/svg";

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
  dayPhase: DayPhase;
  windKmh: number;
  cloudCover: number;
  precipMm: number;
}

/**
 * Clean Apple Weather-style subtle background atmosphere engine.
 * Renders gentle, unobtrusive ambient particles (soft stars at night, warm solar glow
 * in daytime/afternoon, subtle clouds, clean rain/snow) strictly behind the glass UI.
 */
class WeatherFxEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private particles: FxParticle[] = [];
  private rafId: number | null = null;
  private lastTs = 0;
  private w = 540;
  private h = 230;
  private dpr = 1;
  private flashAlpha = 0;
  private nextFlashAt = 0;
  private pointer = { x: -999, y: -999, active: false };
  private scene: FxScene = {
    kind: "clear",
    isDay: true,
    dayPhase: "day",
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
      this.flashAlpha = 0.28;
      return;
    }
    for (let i = 0; i < Math.min(10, this.particles.length); i++) {
      this.particles[i].alpha = Math.min(0.85, this.particles[i].alpha + 0.2);
    }
  }

  setScene(next: FxScene) {
    const changed =
      this.scene.kind !== next.kind ||
      this.scene.isDay !== next.isDay ||
      this.scene.dayPhase !== next.dayPhase ||
      Math.abs(this.scene.cloudCover - next.cloudCover) > 20;
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
    this.dpr = dpr;
    this.w = rect.width;
    this.h = rect.height;
  }

  private seedParticles() {
    const k = this.scene.kind;
    let count = 16;
    if (k === "rain" || k === "storm") count = Math.min(52, 30 + Math.round(this.scene.precipMm * 5));
    else if (k === "drizzle") count = 24;
    else if (k === "snow") count = 30;
    else if (!this.scene.isDay || this.scene.dayPhase === "night" || this.scene.dayPhase === "dusk") count = 34;
    else if (k === "cloudy" || k === "fog" || k === "partly-cloudy") count = 10;

    this.particles = Array.from({ length: count }, () => this.spawnParticle(true));
  }

  private spawnParticle(randomY: boolean): FxParticle {
    return this.respawnParticle(
      { x: 0, y: 0, vx: 0, vy: 0, size: 1, alpha: 0.5, phase: 0 },
      randomY,
    );
  }

  private respawnParticle(p: FxParticle, randomY: boolean): FxParticle {
    const k = this.scene.kind;
    const windDrift = Math.max(6, this.scene.windKmh * 1.4);
    if (k === "rain" || k === "storm" || k === "drizzle") {
      const speed = k === "drizzle" ? 185 : k === "storm" ? 310 : 255;
      p.x = Math.random() * (this.w + 60) - 30;
      p.y = randomY ? Math.random() * this.h : -14;
      p.vx = -windDrift * 0.9;
      p.vy = speed + Math.random() * 65;
      p.size = k === "drizzle" ? 7 : 11 + Math.random() * 6;
      p.alpha = k === "drizzle" ? 0.16 + Math.random() * 0.14 : 0.22 + Math.random() * 0.2;
      p.phase = Math.random() * Math.PI * 2;
      return p;
    }
    if (k === "snow") {
      p.x = Math.random() * this.w;
      p.y = randomY ? Math.random() * this.h : -8;
      p.vx = -windDrift * 0.28;
      p.vy = 22 + Math.random() * 20;
      p.size = 1.3 + Math.random() * 1.8;
      p.alpha = 0.35 + Math.random() * 0.35;
      p.phase = Math.random() * Math.PI * 2;
      return p;
    }
    if (k === "cloudy" || k === "fog" || k === "partly-cloudy") {
      p.x = Math.random() * (this.w + 140) - 70;
      p.y = 10 + Math.random() * (this.h * 0.65);
      p.vx = 4 + windDrift * 0.18 + Math.random() * 4;
      p.vy = 0;
      p.size = 45 + Math.random() * 55;
      p.alpha = k === "fog" ? 0.08 : 0.055;
      p.phase = Math.random() * Math.PI * 2;
      return p;
    }
    p.x = Math.random() * this.w;
    p.y = Math.random() * this.h;
    p.vx = this.scene.isDay ? 3 + Math.random() * 4 : 0;
    p.vy = this.scene.isDay ? -2 - Math.random() * 3 : 0;
    p.size = this.scene.isDay ? 1.1 + Math.random() * 1.3 : 0.8 + Math.random() * 1.2;
    p.alpha = 0.25 + Math.random() * 0.48;
    p.phase = Math.random() * Math.PI * 2;
    return p;
  }

  private step(dt: number, now: number) {
    const k = this.scene.kind;
    if (k === "storm") {
      if (this.flashAlpha > 0) this.flashAlpha = Math.max(0, this.flashAlpha - dt * 2.2);
      if (now > this.nextFlashAt) {
        this.flashAlpha = 0.24;
        this.nextFlashAt = now + 3400 + Math.random() * 5200;
      }
    } else {
      this.flashAlpha = 0;
    }

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;

      if (k === "snow") {
        p.x += Math.sin(now * 0.0018 + p.phase) * 12 * dt;
      }

      if (k === "rain" || k === "storm" || k === "drizzle" || k === "snow") {
        if (p.y > this.h + 14 || p.x < -40 || p.x > this.w + 40) {
          this.respawnParticle(p, false);
        }
      } else if (k === "cloudy" || k === "fog" || k === "partly-cloudy") {
        if (p.x - p.size > this.w + 50) {
          p.x = -p.size - 25;
        }
      } else if (this.scene.isDay) {
        if (p.y < -8 || p.x > this.w + 8) {
          p.x = Math.random() * this.w * 0.8;
          p.y = this.h + 4;
        }
      }
    }
  }

  private draw(now: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    const k = this.scene.kind;
    const phase = this.scene.dayPhase;

    if (this.flashAlpha > 0.01) {
      ctx.fillStyle = `rgba(224, 242, 254, ${this.flashAlpha.toFixed(3)})`;
      ctx.fillRect(0, 0, this.w, this.h);
    }

    for (const p of this.particles) {
      if (k === "rain" || k === "storm" || k === "drizzle") {
        ctx.strokeStyle = `rgba(186, 230, 253, ${p.alpha.toFixed(2)})`;
        ctx.lineWidth = k === "drizzle" ? 0.9 : 1.15;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + p.vx * 0.028, p.y + p.size);
        ctx.stroke();
      } else if (k === "snow") {
        ctx.fillStyle = `rgba(241, 245, 249, ${p.alpha.toFixed(2)})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      } else if (k === "cloudy" || k === "fog" || k === "partly-cloudy") {
        // Subtle drifting mist specks only (no large radial blobs that create edges)
        ctx.fillStyle = `rgba(241, 245, 249, ${(p.alpha * 0.25).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.2, 0, Math.PI * 2);
        ctx.fill();
      } else if (!this.scene.isDay || phase === "night" || phase === "dusk") {
        const twinkle = 0.3 + 0.7 * Math.abs(Math.sin(now * 0.0018 + p.phase));
        ctx.fillStyle = `rgba(248, 250, 252, ${(p.alpha * twinkle).toFixed(2)})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = `rgba(255, 255, 255, ${(p.alpha * 0.26).toFixed(2)})`;
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

function formatAdvisory(adv: WeatherAdvisory): { icon: "rain" | "cloud" | "aqi" | "uv"; text: string; tone: string } {
  switch (adv.kind) {
    case "rain-likely":
      return {
        icon: "rain",
        text: t("Rain likely around {hour} ({prob}%)", { hour: adv.hour, prob: adv.prob }),
        tone: "rain",
      };
    case "rain-clearing":
      return {
        icon: "cloud",
        text: t("Rain may clear around {hour}", { hour: adv.hour }),
        tone: "clear",
      };
    case "rain-ongoing":
      return {
        icon: "rain",
        text: t("Rain continues nearby"),
        tone: "rain",
      };
    case "aqi":
      return {
        icon: "aqi",
        text: t("Air quality alert (AQI {aqi})", { aqi: adv.value }),
        tone: "aqi",
      };
    case "uv":
      return {
        icon: "uv",
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
    const dayPhase = resolveDayPhase(activeIsDay, todayRise, todaySet, previewPt?.time);

    shell.dataset.mood = cond.kind === "clear" ? (activeIsDay ? "clear-day" : "clear-night") : cond.kind;
    shell.dataset.phase = dayPhase;

    fx.setScene({
      kind: cond.kind,
      isDay: activeIsDay,
      dayPhase,
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

    const sceneKey = resolveWeatherScene(cond.kind, activeIsDay, snap.windKmh);

    const tempBtn = h("button", {
      type: "button",
      class: "weather-temp",
      title: tl("Switch unit"),
      text: formatTemp(activeTempC, Weather.unit),
      onclick: (e: Event) => {
        e.stopPropagation();
        actions.blip();
        Weather.setUnit(Weather.unit === "C" ? "F" : "C");
      },
    });
    const todayRange =
      snap.daily.length > 0
        ? `H:${convertTemp(snap.daily[0].tempMaxC, Weather.unit)}° L:${convertTemp(snap.daily[0].tempMinC, Weather.unit)}°`
        : "";
    const condText = h("span", { class: "weather-cond", text: t(cond.label) });
    const feelsText = h("div", {
      class: "weather-feels",
      text: previewPt
        ? `${formatHourLabel(previewPt.time)} · ${previewPt.precipProb}%`
        : `${todayRange ? `${todayRange} · ` : ""}${t("Feels like")} ${formatTemp(snap.feelsLikeC, Weather.unit)}`,
    });

    const heroLeft = h(
      "div",
      {
        class: "weather-open-hero-left",
        "data-scene": sceneKey,
        title: t(cond.label),
        onclick: () => {
          actions.blip();
          fx.triggerBurst();
          actions.emote?.(cond.emote);
        },
      },
      h("div", { class: "apple-hero-top" }, tempBtn, buildMiniWeatherIcon(cond.kind, activeIsDay, 24)),
      h("div", { class: "apple-hero-sub" }, condText, feelsText),
    );

    const aqi = aqiInfo(snap.usAqi);
    const rainPeak = upcomingRainPeak(snap, new Date(), 6);

    const metricHumidity = h(
      "div",
      { class: "weather-metric-item", title: tl("Humidity") },
      buildMetricIcon("humidity", 12),
      h("span", { class: "weather-metric-val", text: `${snap.humidity}%` }),
    );

    const metricWind = h(
      "div",
      { class: "weather-metric-item", title: tl("Wind") },
      buildMetricIcon("wind", 12),
      h("span", { class: "weather-metric-val", text: `${Math.round(snap.windKmh)} km/h` }),
    );

    const metricUv = h(
      "div",
      { class: "weather-metric-item", title: tl("UV index") },
      buildMetricIcon("uv", 12),
      h("span", { class: "weather-metric-val", text: `UV ${Math.round(snap.uvIndex)} · ${t(uvLevel(snap.uvIndex))}` }),
    );

    const aqiItem =
      aqi && snap.usAqi != null
        ? h(
            "button",
            {
              type: "button",
              class: "weather-metric-item aqi-button",
              title: snap.pm25 != null ? `PM2.5: ${snap.pm25.toFixed(1)}` : "AQI",
              onclick: () => {
                actions.blip();
                showAqiDetail = !showAqiDetail;
                renderBody(snap);
              },
            },
            h("i", { class: "weather-aqi-dot", style: `background:${aqi.color};box-shadow:0 0 6px ${aqi.color}` }),
            h("span", {
              class: "weather-metric-val",
              text: showAqiDetail && snap.pm25 != null
                ? `PM2.5 ${snap.pm25.toFixed(1)}`
                : `AQI ${snap.usAqi} · ${t(aqi.label)}`,
            }),
          )
        : snap.precipitationMm && snap.precipitationMm > 0
          ? h(
              "div",
              { class: "weather-metric-item", title: tl("Precipitation") },
              buildMetricIcon("rain", 12),
              h("span", { class: "weather-metric-val", text: `${snap.precipitationMm.toFixed(1)} mm` }),
            )
          : rainPeak
            ? h(
                "div",
                { class: "weather-metric-item", title: tl("Rain chance") },
                buildMetricIcon("rain", 12),
                h("span", { class: "weather-metric-val", text: `${rainPeak.precipProb}% · ${rainPeak.hour}` }),
              )
            : snap.cloudCover != null
              ? h(
                  "div",
                  { class: "weather-metric-item", title: tl("Cloud cover") },
                  buildMetricIcon("cloud", 12),
                  h("span", { class: "weather-metric-val", text: `${snap.cloudCover}%` }),
                )
              : null;

    const heroRight = h(
      "div",
      { class: "weather-open-hero-right" },
      h(
        "div",
        { class: "weather-metrics-grid" },
        metricHumidity,
        metricWind,
        metricUv,
        aqiItem,
      ),
    );
    const openHero = h("div", { class: "weather-open-hero" }, heroLeft, heroRight);

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

        const activeIdx = previewIdx != null && previewIdx < hours.length ? previewIdx : 0;
        const activePt = hours[activeIdx];
        const activePtDay = isHourDaytime(activePt.time, todayRise, todaySet, snap.isDay);
        const activeCond = wmoCondition(activePt.weatherCode, activePtDay);

        const inspectEl = h("div", {
          class: "weather-inspect",
          text: `${formatHourLabel(activePt.time)} · ${t(activeCond.label)}${activePt.precipProb > 0 ? ` · ${activePt.precipProb}%` : ""}`,
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

          const hourText = i === 0 ? t("Now") : formatHourLabel(pt.time).slice(0, 2);

          const col = h(
            "button",
            {
              type: "button",
              class: colClass,
              title: `${formatHourLabel(pt.time)} · ${t(ptCond.label)} · ${tVal}°`,
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
            h("span", {
              class: isNextDayStart ? "w-bar-hr next" : "w-bar-hr",
              text: hourText,
            }),
            h("span", { class: "w-bar-icon" }, buildMiniWeatherIcon(ptCond.kind, ptDay, 18)),
            h("span", {
              class: pt.precipProb > 0 ? "w-bar-rain" : "w-bar-rain empty",
              text: pt.precipProb > 0 ? `${pt.precipProb}%` : "",
            }),
            h("span", { class: "w-bar-temp", text: `${tVal}°` }),
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
            h(
              "div",
              { class: "weather-inspect weather-sun-times" },
              buildMetricIcon("sunrise", 11),
              h("span", { text: formatClockTime(days[0].sunrise) }),
              h("span", { class: "w-dot-sep", text: "·" }),
              buildMetricIcon("sunset", 11),
              h("span", { text: formatClockTime(days[0].sunset) }),
            ),
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
              h("span", { class: "w-day-ico", title: t(c.label) }, buildMiniWeatherIcon(c.kind, true, 14)),
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
          h("span", { class: "weather-advisory-ico" }, buildMetricIcon(info.icon, 11)),
          h("span", { class: "weather-advisory-text", text: info.text }),
        );
      })()
      : null;

    const forecastSection = h("div", { class: "weather-open-forecast" }, forecastHead, forecastContent, advisoryEl);
    bodyEl.append(openHero, forecastSection);
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
