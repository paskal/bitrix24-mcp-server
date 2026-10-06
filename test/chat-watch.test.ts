import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatWatcher, webhookOwnerId } from "../src/chat-watch.js";
import { newClient, stubFetch, WEBHOOK } from "./support.js";

const OWNER = "1";

interface Msg { id: number; author_id: number; text: string; date?: string; params?: Record<string, unknown> }

// A fake dialog: im.dialog.messages.get honours FIRST_ID (newer than), LAST_ID (older than) and LIMIT.
// With neither, and more unread messages than LIMIT, it answers like Bitrix: from the first unread
// message plus one before it, so the newest message is missing from the response.
function setup(history: Msg[], unread = 0) {
  const chat = [...history];
  const events: Array<{ content: string; meta: Record<string, string> }> = [];
  const fx = stubFetch((method, params) => {
    if (method === "im.dialog.get") return [200, { result: { name: "Объект Лесной" } }];
    if (method === "im.dialog.messages.get") {
      const limit = Number(params.LIMIT ?? 20);
      const byId = [...chat].sort((a, b) => a.id - b.id);
      let msgs: Msg[];
      if (params.FIRST_ID !== undefined) msgs = byId.filter((m) => m.id > Number(params.FIRST_ID)).slice(0, limit);
      else if (params.LAST_ID !== undefined) msgs = byId.filter((m) => m.id < Number(params.LAST_ID)).slice(-limit);
      else if (unread > limit) msgs = byId.slice(-unread - 1, -unread + 1);
      else msgs = byId.slice(-limit);
      return [200, { result: { messages: msgs, users: [{ id: 2, name: "Мария" }, { id: 1, name: "Owner" }] } }];
    }
    throw new Error(`unexpected method ${method}`);
  });
  const notices: Array<{ content: string; meta: Record<string, string> }> = [];
  const watcher = new ChatWatcher(newClient(), async (content, meta) => {
    (meta.event === "subscribed" ? notices : events).push({ content, meta });
  }, OWNER, 3_600_000);
  return { chat, events, notices, watcher, done: () => { watcher.stop(); fx.restore(); } };
}

test("webhookOwnerId takes the user id from the webhook path", () => {
  assert.equal(webhookOwnerId(WEBHOOK), "1");
  assert.equal(webhookOwnerId("https://x.bitrix24.ru/rest/42/abc/"), "42");
  assert.equal(webhookOwnerId("https://x.bitrix24.ru/other/"), null);
});

test("subscribing does not replay history and sends one confirmation event", async () => {
  const { events, notices, watcher, done } = setup([{ id: 10, author_id: 2, text: "old" }, { id: 11, author_id: 2, text: "older still unread" }]);
  try {
    const sub = await watcher.subscribe("chat5");
    assert.equal(sub.lastId, 11);
    assert.equal(sub.title, "Объект Лесной");
    assert.deepEqual(notices.map((n) => n.meta), [{ event: "subscribed", dialog_id: "chat5", chat_title: "Объект Лесной" }]);
    await watcher.subscribe("chat5");
    assert.equal(notices.length, 1, "subscribing again sends no second confirmation");
    await watcher.poll();
    assert.equal(events.length, 0);
  } finally { done(); }
});

test("subscribing with an unread backlog starts after the newest message, not the first unread", async () => {
  const history = [10, 11, 12, 13, 14].map((id) => ({ id, author_id: 2, text: `m${id}` }));
  const { events, watcher, done } = setup(history, 3);
  try {
    assert.equal((await watcher.subscribe("chat5")).lastId, 14);
    await watcher.poll();
    assert.equal(events.length, 0);
  } finally { done(); }
});

test("a concurrent subscribe for the same dialog keeps the cursor a poll is advancing", async () => {
  const { chat, events, watcher, done } = setup([{ id: 10, author_id: 2, text: "old" }]);
  try {
    const first = watcher.subscribe("chat5");
    const second = watcher.subscribe("chat5");
    await first;
    chat.push({ id: 11, author_id: 2, text: "new" });
    // the poll captures the first subscription while the second subscribe is still in flight
    const polled = watcher.poll();
    await Promise.all([second, polled]);
    await watcher.poll();
    assert.equal(events.length, 1, "the message is delivered once");
  } finally { done(); }
});

test("a new message arrives as one event for its dialog, in order, with markup stripped", async () => {
  const { chat, events, watcher, done } = setup([{ id: 10, author_id: 2, text: "old" }]);
  try {
    await watcher.subscribe("chat5");
    chat.push({ id: 12, author_id: 2, text: "[B]второе[/B]", params: { FILE_ID: [7] } });
    chat.push({ id: 11, author_id: 2, text: "первое" });
    await watcher.poll();
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].meta, { event: "messages", dialog_id: "chat5", chat_title: "Объект Лесной", first_message_id: "11", last_message_id: "12" });
    assert.match(events[0].content, /^#11 Мария, : первое\n#12 Мария, : второе \[1 file\(s\)\]$/);
    await watcher.poll();
    assert.equal(events.length, 1, "the same messages are not delivered twice");
  } finally { done(); }
});

test("the webhook owner's own messages are skipped but still advance the cursor", async () => {
  const { chat, events, watcher, done } = setup([{ id: 10, author_id: 2, text: "old" }]);
  try {
    await watcher.subscribe("chat5");
    chat.push({ id: 11, author_id: 1, text: "my own reply" });
    await watcher.poll();
    assert.equal(events.length, 0);
    assert.equal(watcher.list()[0].lastId, 11);
    chat.push({ id: 12, author_id: 2, text: "answer" });
    await watcher.poll();
    assert.equal(events.length, 1);
    assert.equal(events[0].meta.first_message_id, "12");
  } finally { done(); }
});

test("an unsubscribed dialog is no longer polled", async () => {
  const { chat, events, watcher, done } = setup([{ id: 10, author_id: 2, text: "old" }]);
  try {
    await watcher.subscribe("chat5");
    assert.equal(watcher.unsubscribe("chat5"), true);
    chat.push({ id: 11, author_id: 2, text: "new" });
    await watcher.poll();
    assert.equal(events.length, 0);
    assert.deepEqual(watcher.list(), []);
  } finally { done(); }
});
