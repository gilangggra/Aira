// EMO Robot Eyes — modular 3D OLED glowing eyes renderer and spring physics.
// Adapted from design/prototype/fiks.html for transparent Notch/Dynamic Island
// integration (the island itself acts as the head) and proportional scaling.

import type { BotEmoteName, BotStateName } from "../core/layout";

export interface EmoEyeSpec {
  w: number;
  h: number;
  topArch: number;
  botArch: number;
  dx: number;
  dy: number;
  rot: number;
  lidCut: number;
  lidAngle: number;
  lidRim: number;
  spiral: number;
}

export type EmoSpring = Record<keyof EmoEyeSpec, { v: number; vel: number }>;

export interface EmoPreset {
  tint: readonly [number, number, number];
  asym?: boolean;
  stiffness?: number;
  damping?: number;
  L: EmoEyeSpec;
  R: EmoEyeSpec;
}

const E = (
  w: number, h: number, ta: number, ba: number,
  dx = 0, dy = 0, lc = 0, la = 0, rot = 0, sp = 0,
): EmoEyeSpec => ({
  w, h, topArch: ta, botArch: ba, dx, dy, rot,
  lidCut: lc, lidAngle: la, lidRim: lc ? 1 : 0, spiral: sp,
});

export function mirrorEmoEye(e: EmoEyeSpec): EmoEyeSpec {
  return { ...e, dx: -e.dx, lidAngle: -e.lidAngle, rot: -e.rot };
}

const NORMAL_EYE = E(46, 86, 23, -23);

export const EMO_STATE_PRESETS: Record<BotStateName, EmoPreset> = {
  idle: { tint: [238, 242, 246], L: NORMAL_EYE, R: NORMAL_EYE },
  working: {
    tint: [200, 230, 255],
    L: E(48, 82, 24, -24, 2, 2, 24, 0.42),
    R: E(48, 82, 24, -24, -2, 2, 24, -0.42),
  },
  thinking: {
    tint: [225, 235, 255],
    asym: true,
    L: E(46, 74, 23, -23, -2, 6, 20, 0.25),
    R: E(46, 86, 23, -23, 0, -4),
  },
  searching: {
    tint: [215, 240, 255],
    L: E(46, 84, 23, -23, -4),
    R: E(46, 84, 23, -23, -4),
  },
  approval: {
    tint: [255, 236, 200],
    stiffness: 220,
    damping: 12,
    L: E(54, 90, 27, -27, -1, -2),
    R: E(54, 90, 27, -27, 1, -2),
  },
  question: {
    tint: [220, 245, 255],
    asym: true,
    L: E(46, 66, 23, -23, -2, 12, 18, 0.22),
    R: E(48, 88, 24, -24, 2, -6),
  },
  error: {
    tint: [255, 195, 205],
    stiffness: 75,
    damping: 16,
    L: E(48, 76, 24, -24, -2, 6, 24, -0.45),
    R: E(48, 76, 24, -24, 2, 6, 24, 0.45),
  },
  finished: {
    tint: [220, 255, 238],
    stiffness: 170,
    damping: 20,
    L: E(52, 52, 26, 12, 0, 4),
    R: E(52, 52, 26, 12, 0, 4),
  },
  ratelimit: {
    tint: [255, 224, 195],
    stiffness: 85,
    damping: 16,
    L: E(48, 72, 24, -24, 0, 6, 30, -0.1),
    R: E(48, 72, 24, -24, 0, 6, 30, 0.1),
  },
  sleeping: {
    tint: [200, 208, 238],
    stiffness: 70,
    damping: 16,
    L: E(52, 54, -10, -27, 0, -2),
    R: E(52, 54, -10, -27, 0, -2),
  },
  dizzy: {
    tint: [245, 220, 245],
    L: E(48, 88, 24, -24, -2, 0, 0, 0, -0.22, 1),
    R: E(48, 88, 24, -24, 2, 0, 0, 0, 0.22, 1),
  },
};

export const EMO_EMOTE_PRESETS: Partial<Record<BotEmoteName, EmoPreset>> = {
  happy: {
    tint: [255, 242, 226],
    stiffness: 170,
    damping: 20,
    L: E(52, 52, 26, 12, 0, 4),
    R: E(52, 52, 26, 12, 0, 4),
  },
  love: {
    tint: [255, 205, 225],
    stiffness: 180,
    damping: 18,
    L: E(52, 52, 26, 12, 0, 4),
    R: E(52, 52, 26, 12, 0, 4),
  },
  proud: {
    tint: [255, 240, 195],
    stiffness: 180,
    damping: 18,
    L: E(52, 52, 26, 12, 0, 4),
    R: E(52, 52, 26, 12, 0, 4),
  },
  surprised: {
    tint: [255, 255, 255],
    stiffness: 235,
    damping: 11.5,
    L: E(56, 90, 28, -28, -2),
    R: E(56, 90, 28, -28, 2),
  },
  annoyed: {
    tint: [255, 212, 200],
    L: E(48, 76, 24, -24, 2, 6, 26, 0.48),
    R: E(48, 76, 24, -24, -2, 6, 26, -0.48),
  },
  yawn: {
    tint: [220, 226, 246],
    stiffness: 90,
    damping: 16,
    L: E(52, 52, 26, 12, 0, 4),
    R: E(52, 52, 26, 12, 0, 4),
  },
};

export function makeEmoSpring(o: EmoEyeSpec): EmoSpring {
  const s = {} as EmoSpring;
  for (const k of Object.keys(o) as (keyof EmoEyeSpec)[]) {
    s[k] = { v: o[k], vel: 0 };
  }
  return s;
}

export function stepEmoSpring(sp: EmoSpring, tg: EmoEyeSpec, dt: number, k = 155, c = 16.5) {
  const n = 4;
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    for (const key of Object.keys(tg) as (keyof EmoEyeSpec)[]) {
      const a = -k * (sp[key].v - tg[key]) - c * sp[key].vel;
      sp[key].vel += a * h;
      sp[key].v += sp[key].vel * h;
    }
  }
}

export function traceEmoEye(ctx: CanvasRenderingContext2D, w: number, h: number, ta: number, ba: number) {
  if (ta - ba < 10) {
    const mid = (ta + ba) / 2;
    ta = mid + 5;
    ba = mid - 5;
  }
  const hw = w / 2;
  const sh = Math.max(0, (h - w) / 2);
  const k = 1.3333;
  ctx.beginPath();
  ctx.moveTo(-hw, -sh);
  ctx.bezierCurveTo(-hw, -sh - ta * k, hw, -sh - ta * k, hw, -sh);
  ctx.lineTo(hw, sh);
  ctx.bezierCurveTo(hw, sh - ba * k, -hw, sh - ba * k, -hw, sh);
  ctx.closePath();
}

// Reusable offscreen canvas for transparent eyelid masking (destination-out)
let lidScratch: HTMLCanvasElement | null = null;
let lidScratchCtx: CanvasRenderingContext2D | null = null;

function getLidScratch(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  if (typeof document === "undefined") return null;
  if (!lidScratch) {
    lidScratch = document.createElement("canvas");
    lidScratchCtx = lidScratch.getContext("2d");
  }
  if (!lidScratchCtx) return null;
  const px = Math.max(64, Math.ceil(size));
  if (lidScratch.width < px || lidScratch.height < px) {
    lidScratch.width = px;
    lidScratch.height = px;
  }
  return { canvas: lidScratch, ctx: lidScratchCtx };
}

export interface DrawEmoEyeParams {
  x: number;
  y: number;
  scale: number;
  spring: EmoSpring;
  isLeft: boolean;
  lookX: number; // -28..28 in prototype coords
  lookY: number; // -16..16 in prototype coords
  blinkScale: number;
  lookVelX: number;
  bounceOffset: number;
  pop: number;
  cross: number;
  breath: number;
  arousal: number;
  tint: readonly [number, number, number];
  t: number;
  isDrowsy: boolean;
  isBrightBoost: boolean;
}

/** Draws a single 3D OLED glowing EMO eye with transparent eyelid cutout. */
export function drawEmoEye(ctx: CanvasRenderingContext2D, p: DrawEmoEyeParams) {
  const { spring: s, isLeft, lookX, lookY, blinkScale, scale } = p;
  const w = s.w.v;
  const h = s.h.v;
  const ta = s.topArch.v;
  const ba = s.botArch.v;

  const crescentAmt = Math.max(0, Math.min(1, Math.max((ba - 2) / 10, (-ta - 2) / 10)));
  const eyeDetail = 1 - crescentAmt;

  const nl = lookX / 28;
  const near = (isLeft && nl < 0) || (!isLeft && nl > 0);
  const rawPsx = near ? 1 - Math.abs(nl) * 0.12 : 1 + Math.abs(nl) * 0.04;
  const psx = 1 + (rawPsx - 1) * eyeDetail;
  const par = 1 + (near ? 0.14 : -0.12) * eyeDetail;

  let dsc = 1;
  let dw = 0;
  if (s.spiral.v > 0.1) {
    const ph = isLeft ? 0 : Math.PI;
    dsc = 1 + Math.sin(p.t * 7 + ph) * 0.07 * s.spiral.v;
    dw = Math.sin(p.t * 6 + ph) * 0.06 * s.spiral.v;
  }

  const ex = p.x + (s.dx.v + lookX * par * 0.42 + (isLeft ? 1 : -1) * p.cross * 5) * scale;
  const ey = p.y + (s.dy.v + lookY * 0.45 + p.bounceOffset) * scale;

  const syB = 1 + (Math.max(0.05, blinkScale) - 1) * eyeDetail;
  const stretch = Math.min(0.12, Math.abs(p.lookVelX) * 0.0004) * eyeDetail;
  const sx = psx * dsc * (1 + (1 - syB) * 0.14 + stretch) * (1 + p.pop * 0.5 + p.cross * 0.05) * (1 + p.breath);
  const sy = syB * dsc * (1 - stretch * 0.45) * (1 - p.pop) * (1 + p.cross * 0.05) * (1 + p.breath * 1.4);

  const gz = (Math.max(0, lookY) * 1.1 - (s.lidCut.v > 0 ? Math.max(0, -lookY) * 0.5 : 0)) * eyeDetail;
  const lc = Math.max(0, s.lidCut.v + gz);
  const rimK = Math.max(s.lidRim.v, Math.max(0, Math.min(1, (gz - 6) / 8))) * eyeDetail;

  const col = (a = 1) => `rgba(${p.tint.map(Math.round).join(",")},${a})`;
  const dk = (a: number) => `rgb(${p.tint.map((v) => Math.round(v * a)).join(",")})`;

  const drawCore = (c: CanvasRenderingContext2D, coreScale: number, applyGlow: boolean) => {
    c.save();
    c.scale(coreScale, coreScale);

    // Outer glow
    if (applyGlow) {
      const gl = 1 + p.arousal * 0.35;
      c.save();
      c.fillStyle = col();
      c.shadowColor = col(0.6);
      c.shadowBlur = Math.max(2, 16 * gl * scale);
      traceEmoEye(c, w, h, ta, ba);
      c.fill();
      c.restore();
    } else {
      c.fillStyle = col();
      traceEmoEye(c, w, h, ta, ba);
      c.fill();
    }

    // 3D dome gradient & specular glint (hidden smoothly in crescent modes)
    const glintVis = eyeDetail * Math.max(0, 1 - s.spiral.v * 1.4);
    if (glintVis > 0.02) {
      c.save();
      traceEmoEye(c, w, h, ta, ba);
      c.clip();
      const nx = lookX / 28;
      const ny = lookY / 16;

      const gx = nx * w * 0.22;
      const gy = -h * 0.04 + ny * h * 0.14;
      const dome = c.createRadialGradient(gx, gy, 2, 0, 0, Math.max(w, h) * 0.74);
      dome.addColorStop(0, dk(1));
      dome.addColorStop(0.55, dk(0.86));
      dome.addColorStop(0.86, dk(0.68));
      dome.addColorStop(1, dk(0.56));
      c.globalAlpha = eyeDetail;
      c.fillStyle = dome;
      c.fillRect(-w, -h, w * 2, h * 2);

      const hx = -w * 0.14 + nx * w * 0.26 + Math.sin(p.t * 1.4) * 0.45;
      const hy = -h * 0.16 + ny * h * 0.16 + Math.cos(p.t * 1.1) * 0.35;
      const boost = p.isBrightBoost ? 1.16 : 1;
      const moodDim = p.isDrowsy ? 0.72 : 1;

      c.globalAlpha = glintVis * 0.55 * moodDim;
      const halo = c.createRadialGradient(hx, hy, 0, hx, hy, w * 0.34 * boost);
      halo.addColorStop(0, "rgba(255,255,255,0.75)");
      halo.addColorStop(0.5, "rgba(255,255,255,0.18)");
      halo.addColorStop(1, "rgba(255,255,255,0)");
      c.fillStyle = halo;
      c.beginPath();
      c.arc(hx, hy, w * 0.34 * boost, 0, Math.PI * 2);
      c.fill();

      c.globalAlpha = glintVis * 0.96 * moodDim;
      c.fillStyle = "#ffffff";
      c.shadowColor = "rgba(255,255,255,0.95)";
      c.shadowBlur = Math.max(1, 5 * scale);
      c.beginPath();
      c.ellipse(hx, hy, w * 0.115 * boost, h * 0.082 * boost, -0.42, 0, Math.PI * 2);
      c.fill();

      c.shadowBlur = Math.max(0.5, 2 * scale);
      c.globalAlpha = glintVis * 0.85 * moodDim;
      c.beginPath();
      c.arc(hx + w * 0.135 * boost, hy + h * 0.085 * boost, w * 0.036 * boost, 0, Math.PI * 2);
      c.fill();

      c.shadowBlur = 0;
      c.globalAlpha = glintVis * 0.34;
      c.strokeStyle = "#ffffff";
      c.lineWidth = Math.max(1.2, w * 0.042);
      c.lineCap = "round";
      c.beginPath();
      c.ellipse(nx * w * 0.06, h * 0.16 + ny * h * 0.04, w * 0.26, h * 0.14, 0, 0.22 * Math.PI, 0.78 * Math.PI);
      c.stroke();
      c.restore();
    }

    // Dizzy rotating spiral
    if (s.spiral.v > 0.05) {
      c.save();
      traceEmoEye(c, w, h, ta, ba);
      c.clip();
      c.strokeStyle = `rgba(35,42,54,${s.spiral.v * 0.72})`;
      c.lineWidth = 3.2;
      c.lineCap = "round";
      c.rotate(p.t * 4.5 * (isLeft ? 1 : -1));
      c.beginPath();
      for (let a = 0; a < Math.PI * 5.2; a += 0.18) {
        const r = a * 1.15;
        const px = Math.cos(a) * r;
        const py = Math.sin(a) * r;
        if (a === 0) c.moveTo(px, py);
        else c.lineTo(px, py);
      }
      c.stroke();
      c.restore();
    }

    c.restore();
  };

  ctx.save();
  ctx.translate(ex, ey);
  ctx.rotate(s.rot.v + dw);
  ctx.scale(sx, sy);

  // Use isolated offscreen canvas when eyelid cutout is active so the upper cut
  // is 100% transparent on any Island gradient or glass background!
  const scratch = lc > 0.5 ? getLidScratch(Math.max(w, h) * scale * 2.8 * 2) : null;
  if (lc > 0.5 && scratch) {
    const hiDpr = typeof window !== "undefined" ? Math.min(2, window.devicePixelRatio || 1) : 1;
    const boxCss = Math.ceil(Math.max(w, h) * scale * 2.8);
    const boxPx = Math.ceil(boxCss * hiDpr);
    const halfCss = boxCss / 2;
    const sc = scratch.ctx;
    sc.setTransform(1, 0, 0, 1, 0, 0);
    sc.clearRect(0, 0, boxPx, boxPx);
    sc.save();
    sc.setTransform(hiDpr, 0, 0, hiDpr, halfCss * hiDpr, halfCss * hiDpr);

    drawCore(sc, scale, false);

    // Punch out transparent eyelid area
    sc.save();
    sc.globalCompositeOperation = "destination-out";
    sc.scale(scale, scale);
    sc.translate(0, -h / 2 + lc);
    sc.rotate(s.lidAngle.v);
    sc.fillStyle = "#000";
    sc.fillRect(-w * 1.6, -h * 1.6, w * 3.2, h * 1.6);
    sc.restore();

    // Glowing eyelid rim
    if (rimK > 0.05) {
      sc.save();
      sc.scale(scale, scale);
      sc.translate(0, -h / 2 + lc);
      sc.rotate(s.lidAngle.v);
      const rw = w + 10 * rimK;
      const rh = 6.5 * rimK;
      sc.fillStyle = col();
      sc.shadowColor = col(0.7);
      sc.shadowBlur = Math.max(1.5, 10 * scale);
      sc.beginPath();
      sc.roundRect(-rw / 2, -rh / 2, rw, rh, rh / 2);
      sc.fill();
      sc.restore();
    }

    sc.restore();

    // Composite masked eye onto main canvas with outer glow
    ctx.save();
    const gl = 1 + p.arousal * 0.35;
    ctx.shadowColor = col(0.55);
    ctx.shadowBlur = Math.max(1.5, 12 * gl * scale);
    ctx.drawImage(scratch.canvas, 0, 0, boxPx, boxPx, -halfCss, -halfCss, boxCss, boxCss);
    ctx.restore();
  } else {
    drawCore(ctx, scale, true);
  }

  ctx.restore();
}
