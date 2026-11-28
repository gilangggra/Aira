import assert from "node:assert/strict";
import test from "node:test";

import {
  ClipboardStore,
  MAX_CLIPBOARD_CHARS,
  MAX_CLIPBOARD_ITEMS,
  addClipboardEntry,
  addClipboardImageEntry,
  cleanTrackingUrl,
  clearUnpinnedClipboard,
  countClipboardLines,
  decodeUrlText,
  detectClipboardKind,
  filterClipboardEntries,
  formatClipboardAge,
  getSmartClipboardActions,
  hexToHslString,
  hexToRgbString,
  isSensitiveClipboardText,
  maskSensitiveText,
  parseUnixTimestamp,
  removeClipboardEntry,
  togglePinClipboardEntry,
  tryFormatJson,
} from "../src/core/clipboard.ts";

test("detectClipboardKind classifies links, hex colors, and text", () => {
  assert.equal(detectClipboardKind("https://example.com/docs"), "link");
  assert.equal(detectClipboardKind("  http://localhost:3000/api "), "link");
  assert.equal(detectClipboardKind("#38BDF8"), "color");
  assert.equal(detectClipboardKind("#fff"), "color");
  assert.equal(detectClipboardKind("hello world"), "text");
  assert.equal(detectClipboardKind("https://a.com\nhttps://b.com"), "text");
});

test("addClipboardEntry deduplicates, ignores whitespace, and clamps huge text", () => {
  let list = addClipboardEntry([], "   \n\t  ", 1000);
  assert.equal(list.length, 0);

  list = addClipboardEntry(list, "first clip", 1000);
  list = addClipboardEntry(list, "second clip", 2000);
  assert.equal(list.length, 2);
  assert.equal(list[0].text, "second clip");

  // Re-copying "first clip" moves it back to top without duplicating
  list = addClipboardEntry(list, "first clip", 3000);
  assert.equal(list.length, 2);
  assert.equal(list[0].text, "first clip");
  assert.equal(list[0].copiedAt, 3000);

  const huge = "x".repeat(MAX_CLIPBOARD_CHARS + 100);
  list = addClipboardEntry(list, huge, 4000);
  assert.equal(list[0].text.length, MAX_CLIPBOARD_CHARS);
});

test("pinned entries survive capacity cap and clearUnpinnedClipboard", () => {
  let list = addClipboardEntry([], "important api note", 100);
  list = togglePinClipboardEntry(list, list[0].id);
  assert.equal(list[0].pinned, true);

  for (let i = 0; i < MAX_CLIPBOARD_ITEMS + 5; i++) {
    list = addClipboardEntry(list, `item-${i}`, 1000 + i);
  }
  assert.equal(list.length, MAX_CLIPBOARD_ITEMS);
  assert.equal(list.some((e) => e.text === "important api note" && e.pinned), true);

  const cleared = clearUnpinnedClipboard(list);
  assert.equal(cleared.length, 1);
  assert.equal(cleared[0].text, "important api note");

  const empty = removeClipboardEntry(cleared, cleared[0].id);
  assert.equal(empty.length, 0);
});

test("filterClipboardEntries filters by tab and query with pinned first", () => {
  let list = addClipboardEntry([], "plain note", 1000);
  list = addClipboardEntry(list, "https://github.com/aira", 2000);
  list = addClipboardEntry(list, "#0ea5e9", 3000);
  const plainId = list.find((e) => e.text === "plain note").id;
  list = togglePinClipboardEntry(list, plainId);

  const all = filterClipboardEntries(list, "", "all");
  assert.equal(all[0].text, "plain note");

  const pinned = filterClipboardEntries(list, "", "pinned");
  assert.equal(pinned.length, 1);
  assert.equal(pinned[0].text, "plain note");

  const links = filterClipboardEntries(list, "github", "links");
  assert.equal(links.length, 1);
  assert.equal(links[0].kind, "link");
});

test("formatClipboardAge formats seconds, minutes, hours, and days", () => {
  const now = 10_000_000;
  assert.equal(formatClipboardAge(now - 10_000, now), "now");
  assert.equal(formatClipboardAge(now - 5 * 60_000, now), "5m");
  assert.equal(formatClipboardAge(now - 3 * 3600_000, now), "3h");
  assert.equal(formatClipboardAge(now - 2 * 86400_000, now), "2d");
});

test("detectClipboardKind classifies code snippets without false-positives on plain text", () => {
  assert.equal(detectClipboardKind('{"name": "aira", "version": 2}'), "code");
  assert.equal(detectClipboardKind("const sum = (a, b) => a + b;"), "code");
  assert.equal(detectClipboardKind("SELECT id, name FROM users WHERE active = 1;"), "code");
  assert.equal(detectClipboardKind("function hello() {\n  return 42;\n}"), "code");
  assert.equal(detectClipboardKind("Meeting notes:\nBuy milk\nCall Alice"), "text");
  assert.equal(countClipboardLines("line1\nline2\nline3"), 3);
});

test("isSensitiveClipboardText and maskSensitiveText protect API keys, tokens, and secrets", () => {
  assert.equal(isSensitiveClipboardText("ghp_1234567890abcdefghijklmnop"), true);
  assert.equal(isSensitiveClipboardText("sk-proj-abcdefghijklmnopqrstuvwxyz123456"), true);
  assert.equal(isSensitiveClipboardText("API_KEY=super_secret_token_value"), true);
  assert.equal(isSensitiveClipboardText("Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"), true);
  assert.equal(isSensitiveClipboardText("Just a normal sentence about keys"), false);

  assert.equal(maskSensitiveText("ghp_1234567890abcdefghijklmnop"), "ghp_••••••••••••");
  assert.equal(maskSensitiveText("API_KEY=super_secret_token_value"), "API_KEY=••••••••••••");

  const list = addClipboardEntry([], "ghp_1234567890abcdefghijklmnop", 5000);
  assert.equal(list[0].sensitive, true);
});

test("ClipboardStore suppresses cleared or deleted system clipboard text until new text is copied", () => {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };

  const store = new ClipboardStore();
  store.capture("first item");
  store.capture("still on os clipboard");
  assert.equal(store.entries.length, 2);

  store.clearUnpinned();
  assert.equal(store.entries.length, 0);

  // Re-reading the same text from OS clipboard should NOT resurrect it
  store.capture("still on os clipboard");
  assert.equal(store.entries.length, 0);

  // Even after a fresh store instance (app restart), the top cleared text stays suppressed
  const storeAfterRestart = new ClipboardStore();
  storeAfterRestart.capture("still on os clipboard");
  assert.equal(storeAfterRestart.entries.length, 0);

  // Copying a different text clears suppression and resumes normal capture
  storeAfterRestart.capture("brand new copy");
  assert.equal(storeAfterRestart.entries.length, 1);
  assert.equal(storeAfterRestart.entries[0].text, "brand new copy");

  // Deleting a single item also suppresses it from immediate re-capture
  const id = storeAfterRestart.entries[0].id;
  storeAfterRestart.remove(id);
  assert.equal(storeAfterRestart.entries.length, 0);
  storeAfterRestart.capture("brand new copy");
  assert.equal(storeAfterRestart.entries.length, 0);
});

test("smart clipboard transforms convert colors, JSON, URLs, epochs, and URL-encoded strings", () => {
  assert.equal(hexToRgbString("#38BDF8"), "rgb(56, 189, 248)");
  assert.equal(hexToRgbString("#fff"), "rgb(255, 255, 255)");
  assert.equal(hexToHslString("#38BDF8"), "hsl(198, 93%, 60%)");
  assert.equal(hexToRgbString("not-a-color"), null);

  const json = tryFormatJson('{"a":1,"b":[2,3]}');
  assert.ok(json);
  assert.equal(json.isMultiline, false);
  assert.equal(json.formatted, '{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}');
  assert.equal(tryFormatJson("not json"), null);

  assert.equal(
    cleanTrackingUrl("https://example.com/post?id=42&utm_source=twitter&fbclid=abc"),
    "https://example.com/post?id=42",
  );
  assert.equal(cleanTrackingUrl("https://example.com/post?id=42"), null);

  const ts = parseUnixTimestamp("1700000000");
  assert.ok(ts);
  assert.equal(ts.iso, "2023-11-14T22:13:20.000Z");
  assert.equal(parseUnixTimestamp("12345"), null);

  assert.equal(decodeUrlText("hello%20world%21"), "hello world!");
  assert.equal(decodeUrlText("plain text"), null);
});

test("getSmartClipboardActions returns contextual actions and hides them for sensitive entries", () => {
  const colorEntry = addClipboardEntry([], "#38BDF8", 1000)[0];
  assert.deepEqual(
    getSmartClipboardActions(colorEntry).map((a) => a.id),
    ["copy-rgb", "copy-hsl"],
  );

  const jsonEntry = addClipboardEntry([], '{"name":"aira"}', 2000)[0];
  assert.ok(getSmartClipboardActions(jsonEntry).some((a) => a.id === "format-json"));

  const linkEntry = addClipboardEntry([], "https://example.com/?utm_source=x&q=1", 3000)[0];
  assert.deepEqual(
    getSmartClipboardActions(linkEntry).map((a) => a.id),
    ["clean-url", "qr-code", "summarize-ai"],
  );

  const secretEntry = addClipboardEntry([], "ghp_1234567890abcdefghijklmnop", 4000)[0];
  assert.deepEqual(getSmartClipboardActions(secretEntry), []);
});

test("image clipboard entries deduplicate, filter by images tab, and expose image smart actions", () => {
  const payload = {
    hash: "abc123",
    path: "C:/temp/clip_abc123.png",
    width: 1920,
    height: 1080,
    thumbDataUrl: "data:image/png;base64,iVBORw0KGgo=",
  };
  let list = addClipboardEntry([], "some text", 1000);
  list = addClipboardImageEntry(list, payload, 2000);
  assert.equal(list.length, 2);
  assert.equal(list[0].kind, "image");
  assert.equal(list[0].imageWidth, 1920);

  // Deduplicating same imagePath moves it to top without duplicating
  list = addClipboardImageEntry(list, payload, 3000);
  assert.equal(list.length, 2);
  assert.equal(list[0].copiedAt, 3000);

  const imagesOnly = filterClipboardEntries(list, "", "images");
  assert.equal(imagesOnly.length, 1);
  assert.equal(imagesOnly[0].imagePath, payload.path);

  assert.deepEqual(
    getSmartClipboardActions(imagesOnly[0]).map((a) => a.id),
    ["preview-image", "save-image", "ask-ai-image"],
  );
});
