// SoundEngine — port of SoundEngine.swift.
// The 29 WAVs are the macOS app's own files (see SOUNDS_DIR in vite.config.ts);
// they are served at /sounds/<name>.wav. Default volume 0.12, slider range 0–0.2,
// exactly like the Mac player, and several sounds may overlap.
// A file of the user's own in the sounds folder (src-tauri/src/sounds.rs)
// replaces a sound; one that doesn't decode falls back to the built-in one.

import { Bridge } from "./bridge";

export const SOUND_NAMES = [
  "peek", "open", "close", "hover", "blip", "slap", "annoyed", "dizzy", "greet",
  "work", "finish", "error", "approval", "question", "approve", "gulp", "tick",
  "send", "love", "pop", "proud", "wink", "yawn", "attach", "think", "search",
  "rate", "sleep", "greeting",
] as const;

export type SoundName = (typeof SOUND_NAMES)[number];

class SoundEngine {
  enabled = true;
  robotAccentEnabled = true;
  volume = 0.12;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private loading: Promise<void> | null = null;
  private idleTimer: number | null = null;
  /** The sounds a file of the user's own replaces, as last loaded. */
  customized = new Set<string>();
  /** Sounds still playing, by name, so one can be faded out (the greeting). */
  private playing = new Map<string, Set<{ src: AudioBufferSourceNode; gain: GainNode }>>();
  private lastServoAt = 0;
  private lastChirpAt = 0;

  /** Creates the context and decodes every WAV. Safe to call more than once. */
  preload(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();
      this.ctx = ctx;
      const master = ctx.createGain();
      master.gain.value = this.volume;
      master.connect(ctx.destination);
      this.master = master;
      await this.loadAll(ctx);
    })();
    return this.loading;
  }

  /** Reads the sounds folder again (Settings → Reload sounds). */
  async reload(): Promise<void> {
    await this.preload();
    if (this.ctx) await this.loadAll(this.ctx);
  }

  private async loadAll(ctx: AudioContext) {
    const own = new Set((await Bridge.customSounds(SOUND_NAMES)) ?? []);
    const customized = new Set<string>();
    await Promise.all(
      SOUND_NAMES.map(async (name) => {
        if (own.has(name)) {
          try {
            const bytes = await Bridge.customSound(name);
            if (bytes && bytes.byteLength > 0) {
              this.buffers.set(name, await ctx.decodeAudioData(bytes));
              customized.add(name);
              return;
            }
          } catch {
            /* not a format this webview decodes: the built-in sound stays */
          }
        }
        try {
          const res = await fetch(`/sounds/${name}.wav`);
          if (!res.ok) return;
          const buf = await ctx.decodeAudioData(await res.arrayBuffer());
          this.buffers.set(name, buf);
        } catch {
          /* a missing sound must never break the island */
        }
      }),
    );
    this.customized = customized;
  }

  /** WebView2 can hand us a suspended context; call after any user input. */
  resume() {
    if (this.idleTimer != null) {
      window.clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    void this.ctx?.resume();
  }

  /**
   * Called when the island goes quiet. A running AudioContext keeps an audio
   * thread and its render quantum alive even with nothing playing, which shows
   * up as a steady trickle of CPU on a machine that is supposed to be idle.
   *
   * The delay covers the tail of whatever just played — suspending mid-sound
   * would clip it — and `play()` resumes the context on its own.
   */
  idle() {
    if (!this.ctx || this.ctx.state !== "running" || this.idleTimer != null) return;
    this.idleTimer = window.setTimeout(() => {
      this.idleTimer = null;
      void this.ctx?.suspend();
    }, 1500);
  }

  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(0.2, v));
    if (this.master) this.master.gain.value = this.volume;
  }

  setEnabled(on: boolean) {
    this.enabled = on;
  }

  play(name: SoundName | string) {
    if (!this.enabled) return;
    const ctx = this.ctx;
    const master = this.master;
    const buf = this.buffers.get(name);
    if (!ctx || !master || !buf) return;
    if (this.idleTimer != null) {
      window.clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (ctx.state === "suspended") void ctx.resume();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    src.connect(gain);
    gain.connect(master);
    const voice = { src, gain };
    let voices = this.playing.get(name);
    if (!voices) this.playing.set(name, (voices = new Set()));
    voices.add(voice);
    src.onended = () => {
      voices.delete(voice);
      gain.disconnect();
    };
    src.start();
  }

  /** Fades every playing copy of `name` to silence over `seconds`, then stops it. */
  fadeOut(name: string, seconds: number) {
    const ctx = this.ctx;
    const voices = this.playing.get(name);
    if (!ctx || !voices) return;
    const t = ctx.currentTime;
    for (const { src, gain } of voices) {
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(gain.gain.value, t);
      gain.gain.linearRampToValueAtTime(0, t + seconds);
      try {
        src.stop(t + seconds);
      } catch {
        /* already stopped */
      }
    }
  }

  /** Subtle robotic servo sweep for quick eye saccades (hybrid accent, throttled). */
  playServo(intensity = 0.7) {
    if (!this.enabled || !this.robotAccentEnabled || !this.ctx || !this.master || this.ctx.state !== "running") return;
    const now = performance.now();
    if (now - this.lastServoAt < 160) return;
    this.lastServoAt = now;
    try {
      const c = this.ctx;
      const t = c.currentTime;
      const osc = c.createOscillator();
      const gain = c.createGain();
      const f = 820 + Math.random() * 280;
      osc.type = "triangle";
      osc.frequency.setValueAtTime(f, t);
      osc.frequency.exponentialRampToValueAtTime(f * 1.32, t + 0.05);
      const peak = 0.045 * Math.max(0.1, Math.min(1, intensity));
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.linearRampToValueAtTime(peak, t + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0003, t + 0.06);
      osc.connect(gain);
      gain.connect(this.master);
      osc.start(t);
      osc.stop(t + 0.07);
      osc.onended = () => gain.disconnect();
    } catch {
      /* ignore audio context errors */
    }
  }

  /** Subtle synthesized robotic chirp accent for eye interactions (hybrid). */
  playChirp(type: "happy" | "curious" | "surprised" | "sad" | "annoyed" | "idle" = "idle") {
    if (!this.enabled || !this.robotAccentEnabled || !this.ctx || !this.master || this.ctx.state !== "running") return;
    const now = performance.now();
    if (now - this.lastChirpAt < 90) return;
    this.lastChirpAt = now;
    const spec = ROBOT_CHIRPS[type] ?? ROBOT_CHIRPS.idle;
    try {
      const c = this.ctx;
      const t = c.currentTime;
      const pitch = 0.94 + Math.random() * 0.12;
      const o1 = c.createOscillator();
      const o2 = c.createOscillator();
      const mix = c.createGain();
      const sub = c.createGain();
      sub.gain.value = 0.42;
      o1.type = spec.a;
      o2.type = spec.b;
      o1.connect(mix);
      o2.connect(sub);
      sub.connect(mix);
      mix.connect(this.master);

      const n = spec.f.length;
      spec.f.forEach((freq, i) => {
        const tm = t + (spec.d * i) / Math.max(1, n - 1);
        if (i === 0) {
          o1.frequency.setValueAtTime(freq * pitch, t);
          o2.frequency.setValueAtTime(freq * 1.5 * pitch, t);
        } else {
          o1.frequency.exponentialRampToValueAtTime(freq * pitch, tm);
          o2.frequency.exponentialRampToValueAtTime(freq * 1.5 * pitch, tm);
        }
      });
      mix.gain.setValueAtTime(0.001, t);
      mix.gain.linearRampToValueAtTime(spec.g, t + 0.02);
      mix.gain.exponentialRampToValueAtTime(0.0008, t + spec.d + 0.01);
      o1.start(t);
      o2.start(t);
      o1.stop(t + spec.d + 0.02);
      o2.stop(t + spec.d + 0.02);
      o1.onended = () => {
        sub.disconnect();
        mix.disconnect();
      };
    } catch {
      /* ignore audio context errors */
    }
  }
}

const ROBOT_CHIRPS: Record<
  "happy" | "curious" | "surprised" | "sad" | "annoyed" | "idle",
  { a: OscillatorType; b: OscillatorType; f: number[]; d: number; g: number }
> = {
  happy: { a: "sine", b: "triangle", f: [540, 960, 1280], d: 0.22, g: 0.35 },
  curious: { a: "sine", b: "sine", f: [480, 640, 920], d: 0.21, g: 0.30 },
  surprised: { a: "triangle", b: "sine", f: [420, 1180], d: 0.15, g: 0.36 },
  sad: { a: "sine", b: "sine", f: [460, 210], d: 0.30, g: 0.26 },
  annoyed: { a: "sawtooth", b: "triangle", f: [205, 160], d: 0.20, g: 0.22 },
  idle: { a: "sine", b: "sine", f: [580, 740], d: 0.10, g: 0.20 },
};

export const Sound = new SoundEngine();
