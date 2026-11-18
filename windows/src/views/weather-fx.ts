// Real-time Canvas particle engine & animated SVG weather illustrations.

import { State } from "../core/state";
import type { WeatherKind } from "../core/weather";

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
export function buildWeatherArt(kind: WeatherKind, isDay: boolean): SVGSVGElement {
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

export interface FxScene {
  kind: WeatherKind;
  isDay: boolean;
  windKmh: number;
  cloudCover: number;
  precipMm: number;
}

/** Real-time interactive Canvas particle engine for live weather atmosphere. */
export class WeatherFxEngine {
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

      if (this.pointer.active) {
        const dx = p.x - this.pointer.x;
        const dy = p.y - this.pointer.y;
        const dist2 = dx * dx + dy * dy;
        if (dist2 > 1 && dist2 < 2400) {
          const d = Math.sqrt(dist2);
          const push = (1 - d / 49) * 90 * dt;
          p.x += (dx / d) * push;
          p.y += (dy / d) * push;
        }
      }

      if (k === "rain" || k === "storm" || k === "drizzle" || k === "snow") {
        if (p.y > this.h + 14 || p.x < -40 || p.x > this.w + 40) {
          this.particles[i] = this.spawnParticle(false);
        }
      } else if (k === "cloudy" || k === "fog" || k === "partly-cloudy") {
        if (p.x - p.size > this.w + 40) p.x = -p.size - 20;
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
