import test from "node:test";
import assert from "node:assert/strict";

import {
  SpotifyLyrics,
  activeLyricIndex,
  activeLyricLine,
  buildTrackLyrics,
  parseLrc,
} from "../src/core/lyrics.ts";
import { closedContent } from "../src/core/closed.ts";

test("parseLrc parses timestamps, multi-tag lines, and strips karaoke word tags", () => {
  const sample = [
    "[ar:NewJeans]",
    "[00:05.00] First line",
    "[00:10.50][01:05.250] <00:10.50>Repeated chorus line",
    "[00:15]   ",
    "[00:18.2] Last line\r",
  ].join("\n");

  const lines = parseLrc(sample);
  assert.deepEqual(lines, [
    { timeSec: 5, text: "First line" },
    { timeSec: 10.5, text: "Repeated chorus line" },
    { timeSec: 18.2, text: "Last line" },
    { timeSec: 65.25, text: "Repeated chorus line" },
  ]);
});

test("activeLyricIndex and activeLyricLine track playback position with cue lead", () => {
  const lyrics = buildTrackLyrics("k1", {
    syncedLyrics: "[00:04.00] Line A\n[00:08.50] Line B\n[00:14.00] Line C",
    plainLyrics: null,
    instrumental: false,
  });
  assert.ok(lyrics?.synced);
  assert.equal(activeLyricIndex(lyrics.lines, 1.0), -1);
  assert.equal(activeLyricLine(lyrics, 1.0), null);
  // 150 ms lead lets the cue highlight right on beat.
  assert.equal(activeLyricIndex(lyrics.lines, 3.86), 0);
  assert.equal(activeLyricLine(lyrics, 5.0), "Line A");
  assert.equal(activeLyricLine(lyrics, 10.0), "Line B");
  assert.equal(activeLyricLine(lyrics, 20.0), "Line C");
});

test("instrumental tracks yield no synced lyric lines", () => {
  const lyrics = buildTrackLyrics("inst", {
    syncedLyrics: null,
    plainLyrics: null,
    instrumental: true,
  });
  assert.equal(lyrics?.instrumental, true);
  assert.equal(lyrics?.synced, false);
  assert.equal(activeLyricLine(lyrics, 10), null);
});

test("SpotifyLyrics caches fetched lyrics per track and ignores ads", async () => {
  let calls = 0;
  const fetcher = async (title) => {
    calls += 1;
    return {
      syncedLyrics: `[00:01.00] ${title} lyric`,
      plainLyrics: `${title} lyric`,
      instrumental: false,
    };
  };

  await SpotifyLyrics.syncForTrack(
    { id: "spotify:track:A", title: "Alpha", artist: "Art", album: "Alb", duration: 180, artUrl: null },
    fetcher,
  );
  assert.equal(calls, 1);
  assert.equal(activeLyricLine(SpotifyLyrics.current, 2), "Alpha lyric");

  // Ad clears current lyrics without fetching.
  await SpotifyLyrics.syncForTrack(
    { id: "spotify:ad:1", title: "Spotify", artist: "", album: "", duration: 30, artUrl: null },
    fetcher,
  );
  assert.equal(calls, 1);
  assert.equal(SpotifyLyrics.current, null);

  // Returning to the same track resolves from cache.
  await SpotifyLyrics.syncForTrack(
    { id: "spotify:track:A", title: "Alpha", artist: "Art", album: "Alb", duration: 180, artUrl: null },
    fetcher,
  );
  assert.equal(calls, 1);
  assert.equal(activeLyricLine(SpotifyLyrics.current, 2), "Alpha lyric");
});

test("closedContent shows active lyric when closedIsland is music, falling back to title and artist", () => {
  const base = {
    now: new Date(2026, 10, 23, 12, 0),
    locale: "en",
    planUsage: null,
    music: { title: "Song", artist: "Singer" },
  };
  assert.deepEqual(closedContent("music", { ...base, lyric: "Sing along now" }), {
    text: "Sing along now",
    dot: null,
    note: true,
  });
  assert.deepEqual(closedContent("music", { ...base, lyric: null }), {
    text: "Song · Singer",
    dot: null,
    note: true,
  });
});
