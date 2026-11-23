// Pure LRC lyrics parser, synced-line lookup, and reactive store for Spotify playback.

import { isAd, type SpotifyTrack } from "./spotify";

export interface LyricsPayload {
  syncedLyrics: string | null;
  plainLyrics: string | null;
  instrumental: boolean;
}

export interface LyricLine {
  timeSec: number;
  text: string;
}

export interface TrackLyrics {
  trackKey: string;
  lines: LyricLine[];
  plainLines: string[];
  instrumental: boolean;
  synced: boolean;
}

/** Stable cache key matching how a track is identified across SMTC polls. */
export function trackLyricsKey(track: Pick<SpotifyTrack, "id" | "title" | "artist">): string {
  return `${track.id}|${track.title.trim().toLowerCase()}|${track.artist.trim().toLowerCase()}`;
}

/** Strips karaoke word-level timestamps like `<00:12.34>` from a lyric line. */
function cleanLyricText(raw: string): string {
  return raw.replace(/<\d{1,3}:\d{2}(?:\.\d{1,3})?>/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Parses an LRC string (`[mm:ss.xx] text`) into sorted timed lines.
 * Supports multi-timestamp prefixes like `[00:12.00][01:02.00]Chorus`.
 */
export function parseLrc(lrc: string): LyricLine[] {
  if (!lrc) return [];
  const tagRe = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  const out: LyricLine[] = [];

  for (const rawLine of lrc.split(/\r?\n/)) {
    tagRe.lastIndex = 0;
    const times: number[] = [];
    let lastEnd = 0;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(rawLine)) !== null) {
      const mins = Number(m[1]);
      const secs = Number(m[2]);
      const fracRaw = m[3] ?? "";
      const frac = fracRaw
        ? Number(fracRaw) / (fracRaw.length === 1 ? 10 : fracRaw.length === 2 ? 100 : 1000)
        : 0;
      times.push(mins * 60 + secs + frac);
      lastEnd = m.index + m[0].length;
    }
    if (times.length === 0) continue;
    const text = cleanLyricText(rawLine.slice(lastEnd));
    if (!text) continue;
    for (const timeSec of times) {
      out.push({ timeSec, text });
    }
  }

  out.sort((a, b) => a.timeSec - b.timeSec);
  return out;
}

/** Converts a Rust `LyricsPayload` into normalized synced/plain structures. */
export function buildTrackLyrics(trackKey: string, payload: LyricsPayload | null | undefined): TrackLyrics | null {
  if (!payload) return null;
  const lines = payload.syncedLyrics ? parseLrc(payload.syncedLyrics) : [];
  const plainLines = payload.plainLyrics
    ? payload.plainLyrics
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const instrumental = Boolean(payload.instrumental);
  if (!instrumental && lines.length === 0 && plainLines.length === 0) return null;
  return {
    trackKey,
    lines,
    plainLines,
    instrumental,
    synced: lines.length > 0,
  };
}

/**
 * Returns the index of the line currently playing at `positionSec`,
 * with a subtle +150ms cue lead so transitions feel responsive.
 */
export function activeLyricIndex(lines: readonly LyricLine[], positionSec: number): number {
  if (lines.length === 0 || !Number.isFinite(positionSec)) return -1;
  const target = Math.max(0, positionSec + 0.15);
  let lo = 0;
  let hi = lines.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].timeSec <= target) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/** Active synced lyric line text at `positionSec`, or null if none is active yet. */
export function activeLyricLine(lyrics: TrackLyrics | null, positionSec: number): string | null {
  if (!lyrics || !lyrics.synced || lyrics.instrumental) return null;
  const idx = activeLyricIndex(lyrics.lines, positionSec);
  return idx >= 0 ? lyrics.lines[idx].text : null;
}

export type LyricsFetcher = (
  title: string,
  artist: string,
  album: string,
  duration: number,
) => Promise<LyricsPayload | null>;

class LyricsStore {
  current: TrackLyrics | null = null;
  loading = false;

  private activeKey: string | null = null;
  private cache = new Map<string, TrackLyrics | null>();
  private listeners = new Set<() => void>();

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  async syncForTrack(track: SpotifyTrack | null, fetcher: LyricsFetcher): Promise<void> {
    if (!track || isAd(track) || !track.title.trim()) {
      if (this.activeKey != null || this.current != null || this.loading) {
        this.activeKey = null;
        this.current = null;
        this.loading = false;
        this.emit();
      }
      return;
    }

    const key = trackLyricsKey(track);
    if (key === this.activeKey) return;
    this.activeKey = key;

    if (this.cache.has(key)) {
      this.current = this.cache.get(key) ?? null;
      this.loading = false;
      this.emit();
      return;
    }

    this.current = null;
    this.loading = true;
    this.emit();

    let parsed: TrackLyrics | null = null;
    try {
      const raw = await fetcher(track.title, track.artist, track.album, track.duration);
      parsed = buildTrackLyrics(key, raw);
    } catch {
      parsed = null;
    }

    // Bounded local cache (48 tracks) so repeats resolve instantly.
    if (this.cache.size >= 48) {
      const oldest = this.cache.keys().next().value;
      if (oldest != null) this.cache.delete(oldest);
    }
    this.cache.set(key, parsed);

    if (this.activeKey !== key) return;
    this.current = parsed;
    this.loading = false;
    this.emit();
  }
}

export const SpotifyLyrics = new LyricsStore();
