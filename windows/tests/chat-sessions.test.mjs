import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_CHAT_SESSIONS,
  deleteChatSession,
  deriveSessionTitle,
  formatSessionTime,
  groupChatSessions,
  upsertChatSession,
} from "../src/core/chat-sessions.ts";
import { CHAT_OVERLAY_H, chatPromptHeight } from "../src/core/layout.ts";

test("deriveSessionTitle extracts clean first user message and truncates long prompts", () => {
  assert.equal(deriveSessionTitle([]), "New Chat");
  assert.equal(
    deriveSessionTitle([
      { id: 1, role: "user", content: "  Halo   Aira,\napa kabar? " },
      { id: 2, role: "assistant", content: "Baik!" },
    ]),
    "Halo Aira, apa kabar?",
  );

  const long = "a".repeat(60);
  const title = deriveSessionTitle([{ id: 1, role: "user", content: long }]);
  assert.equal(title.length, 42);
  assert.ok(title.endsWith("…"));
});

test("upsertChatSession creates, updates, reorders, and caps sessions", () => {
  const empty = upsertChatSession([], null, [], 1000);
  assert.equal(empty.sessions.length, 0);
  assert.equal(empty.activeId, null);

  const first = upsertChatSession(
    [],
    null,
    [{ id: 1, role: "user", content: "First question" }],
    1000,
  );
  assert.equal(first.sessions.length, 1);
  assert.ok(first.activeId);
  assert.equal(first.sessions[0].title, "First question");

  const second = upsertChatSession(
    first.sessions,
    null,
    [{ id: 2, role: "user", content: "Second question" }],
    2000,
  );
  assert.equal(second.sessions.length, 2);
  assert.equal(second.sessions[0].title, "Second question");

  // Updating the first session moves it back to the top.
  const updatedFirst = upsertChatSession(
    second.sessions,
    first.activeId,
    [
      { id: 1, role: "user", content: "First question" },
      { id: 3, role: "assistant", content: "First answer" },
    ],
    3000,
  );
  assert.equal(updatedFirst.sessions.length, 2);
  assert.equal(updatedFirst.sessions[0].id, first.activeId);
  assert.equal(updatedFirst.sessions[0].messages.length, 2);

  // Capping at MAX_CHAT_SESSIONS.
  let many = [];
  for (let i = 0; i < MAX_CHAT_SESSIONS + 5; i++) {
    many = upsertChatSession(
      many,
      null,
      [{ id: i + 1, role: "user", content: `Prompt ${i}` }],
      4000 + i,
    ).sessions;
  }
  assert.equal(many.length, MAX_CHAT_SESSIONS);
});

test("deleteChatSession removes only the matching session", () => {
  const a = upsertChatSession([], null, [{ id: 1, role: "user", content: "A" }], 1000);
  const b = upsertChatSession(a.sessions, null, [{ id: 2, role: "user", content: "B" }], 2000);
  const remaining = deleteChatSession(b.sessions, a.activeId);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].title, "B");
});

test("groupChatSessions buckets sessions into Today, Yesterday, Last 7 Days, Older", () => {
  const now = new Date(2026, 10, 19, 15, 0, 0).getTime();
  const todayTs = new Date(2026, 10, 19, 9, 30, 0).getTime();
  const yesterdayTs = new Date(2026, 10, 18, 12, 0, 0).getTime();
  const weekTs = new Date(2026, 10, 15, 10, 0, 0).getTime();
  const olderTs = new Date(2026, 10, 1, 10, 0, 0).getTime();

  const sessions = [
    { id: "1", title: "T", createdAt: todayTs, updatedAt: todayTs, messages: [] },
    { id: "2", title: "Y", createdAt: yesterdayTs, updatedAt: yesterdayTs, messages: [] },
    { id: "3", title: "W", createdAt: weekTs, updatedAt: weekTs, messages: [] },
    { id: "4", title: "O", createdAt: olderTs, updatedAt: olderTs, messages: [] },
  ];

  const groups = groupChatSessions(sessions, now);
  assert.deepEqual(
    groups.map((g) => g.key),
    ["Today", "Yesterday", "Last 7 Days", "Older"],
  );
  assert.equal(formatSessionTime(todayTs, now), "09:30");
  assert.equal(formatSessionTime(olderTs, now), "01/11");
});

test("chatPromptHeight and CHAT_OVERLAY_H provide comfortable room even with zero messages", () => {
  assert.equal(chatPromptHeight(0), 256);
  assert.equal(chatPromptHeight(1), 296);
  assert.equal(chatPromptHeight(2), 316);
  assert.ok(CHAT_OVERLAY_H >= 320);
});

test("upsertChatSession preserves file attachments on user messages", () => {
  const res = upsertChatSession(
    [],
    null,
    [
      {
        id: 1,
        role: "user",
        content: "Summarize this",
        attachment: { name: "report.pdf", path: "C:/tmp/report.pdf" },
      },
    ],
    5000,
  );
  assert.deepEqual(res.sessions[0].messages[0].attachment, {
    name: "report.pdf",
    path: "C:/tmp/report.pdf",
  });
});
