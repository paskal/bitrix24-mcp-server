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
  // runs once, right after the next im.dialog.messages.get answers: a change landing between two reads
  let afterRead: (() => void) | null = null;
  const fx = stubFetch((method, params) => {
    if (method === "im.dialog.get") return [200, { result: { name: "Объект Лесной" } }];
    if (method === "im.dialog.messages.get") {
      const hook = afterRead;
      afterRead = null;
      const answer = read(params);
      hook?.();
      return answer;
    }
    throw new Error(`unexpected method ${method}`);
  });
  function read(params: Record<string, unknown>): [number, unknown] {
    {
      const limit = Number(params.LIMIT ?? 20);
      const byId = [...chat].sort((a, b) => a.id - b.id);
      let msgs: Msg[];
      if (params.FIRST_ID !== undefined) msgs = byId.filter((m) => m.id > Number(params.FIRST_ID)).slice(0, limit);
      else if (params.LAST_ID !== undefined) msgs = byId.filter((m) => m.id < Number(params.LAST_ID)).slice(-limit);
      else if (unread > limit) msgs = byId.slice(-unread - 1, -unread + 1);
      else msgs = byId.slice(-limit);
      // a deep copy, so a later change to the chat does not reach into an answer already given
      return [200, { result: { messages: structuredClone(msgs), users: [{ id: 2, name: "Мария" }, { id: 1, name: "Owner" }] } }];
    }
  }
  const notices: Array<{ content: string; meta: Record<string, string> }> = [];
  const watcher = new ChatWatcher(newClient(), async (content, meta) => {
    (meta.event === "subscribed" ? notices : events).push({ content, meta });
  }, OWNER, 3_600_000);
  return { chat, events, notices, watcher, afterNextRead: (fn: () => void) => { afterRead = fn; }, done: () => { watcher.stop(); fx.restore(); } };
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

const changes = (events: Array<{ content: string; meta: Record<string, string> }>) => events.filter((e) => e.meta.event === "changes");

test("another person's reaction on the owner's message is reported; one already there at subscribe is not", async () => {
  const { chat, events, watcher, done } = setup([
    { id: 10, author_id: 1, text: "готово?", params: { LIKE: [2] } },
    { id: 11, author_id: 1, text: "Исправили счётчик" },
  ]);
  try {
    await watcher.subscribe("chat5");
    await watcher.poll();
    assert.equal(events.length, 0, "a reaction present at subscribe is history");
    chat[1].params = { LIKE: [2] };
    await watcher.poll();
    const got = changes(events);
    assert.equal(got.length, 1);
    assert.deepEqual(got[0].meta, { event: "changes", dialog_id: "chat5", chat_title: "Объект Лесной", message_ids: "11" });
    assert.equal(got[0].content, "Мария added LIKE on #11 (your message): Исправили счётчик");
    await watcher.poll();
    assert.equal(changes(events).length, 1, "the same reaction is not reported twice");
    chat[1].params = {};
    await watcher.poll();
    assert.equal(changes(events)[1].content, "Мария removed LIKE on #11 (your message): Исправили счётчик");
  } finally { done(); }
});

test("the owner's own reactions and edits are skipped", async () => {
  const { chat, events, watcher, done } = setup([{ id: 10, author_id: 2, text: "вопрос" }, { id: 11, author_id: 1, text: "ответ" }]);
  try {
    await watcher.subscribe("chat5");
    chat[0].params = { LIKE: [1] };
    chat[1].text = "ответ, исправленный";
    chat[1].params = { IS_EDITED: "Y" };
    await watcher.poll();
    assert.equal(events.length, 0);
  } finally { done(); }
});

test("an edit and a deletion by another person are reported with the text", async () => {
  const { chat, events, watcher, done } = setup([{ id: 10, author_id: 2, text: "цена 100" }, { id: 11, author_id: 2, text: "лишнее" }]);
  try {
    await watcher.subscribe("chat5");
    chat[0].text = "цена 120";
    chat[0].params = { IS_EDITED: "Y" };
    chat[1].text = "Это сообщение было удалено.";
    chat[1].params = { IS_DELETED: "Y" };
    await watcher.poll();
    const got = changes(events);
    assert.equal(got.length, 1);
    assert.equal(got[0].meta.message_ids, "10,11");
    assert.equal(got[0].content, "Мария edited #10, now: цена 120\nМария deleted #11, which read: лишнее");
  } finally { done(); }
});

test("a new message arrives once as a message, and only its reactions as a change", async () => {
  const { chat, events, watcher, done } = setup([{ id: 10, author_id: 2, text: "old" }]);
  try {
    await watcher.subscribe("chat5");
    chat.push({ id: 11, author_id: 2, text: "новое", params: { LIKE: [3] } });
    await watcher.poll();
    assert.deepEqual(events.map((e) => e.meta.event), ["messages", "changes"]);
    assert.match(changes(events)[0].content, /^user 3 added LIKE on #11 \(Мария's message\): новое$/);
    chat[1].text = "новое!";
    await watcher.poll();
    assert.equal(changes(events).length, 2, "a later edit of the new message is a change");
  } finally { done(); }
});

test("an edit right after a message is delivered is reported, not lost", async () => {
  const { chat, events, watcher, afterNextRead, done } = setup([{ id: 10, author_id: 2, text: "old" }]);
  try {
    await watcher.subscribe("chat5");
    chat.push({ id: 11, author_id: 2, text: "цена 100" });
    afterNextRead(() => { chat[1].text = "цена 120"; chat[1].params = { IS_EDITED: "Y" }; });
    await watcher.poll();
    await watcher.poll();
    assert.deepEqual(events.map((e) => [e.meta.event, e.content]), [
      ["messages", "#11 Мария, : цена 100"],
      ["changes", "Мария edited #11, now: цена 120"],
    ]);
  } finally { done(); }
});

test("a message posted and then edited between polls arrives once, with its latest text", async () => {
  const { chat, events, watcher, afterNextRead, done } = setup([{ id: 10, author_id: 2, text: "old" }]);
  try {
    await watcher.subscribe("chat5");
    afterNextRead(() => { chat.push({ id: 11, author_id: 2, text: "цена 100" }); });
    await watcher.poll();
    chat[1].text = "цена 120";
    await watcher.poll();
    await watcher.poll();
    assert.deepEqual(events.map((e) => [e.meta.event, e.content]), [["messages", "#11 Мария, : цена 120"]]);
  } finally { done(); }
});

test("a message removed outright is reported, and the older one sliding into view is not", async () => {
  const history = Array.from({ length: 51 }, (_, i) => ({ id: i + 1, author_id: 2, text: `m${i + 1}`, params: i === 0 ? { LIKE: [3] } : undefined }));
  const { chat, events, watcher, done } = setup(history);
  try {
    await watcher.subscribe("chat5");
    chat.splice(chat.findIndex((m) => m.id === 30), 1);
    await watcher.poll();
    assert.deepEqual(events.map((e) => [e.meta.event, e.content]), [["changes", "Мария's message #30 was removed, which read: m30"]]);
  } finally { done(); }
});

test("a deletion that clears reactions reports the deletion alone", async () => {
  const { chat, events, watcher, done } = setup([{ id: 10, author_id: 2, text: "вопрос", params: { LIKE: [3] } }]);
  try {
    await watcher.subscribe("chat5");
    chat[0].text = "Это сообщение было удалено.";
    chat[0].params = { IS_DELETED: "Y" };
    await watcher.poll();
    assert.deepEqual(events.map((e) => e.content), ["Мария deleted #10, which read: вопрос"]);
  } finally { done(); }
});

for (const [label, history] of [["after an existing message", [{ id: 1, author_id: 2, text: "old" }]], ["into a chat empty at subscribe", []]] as const) test(`a burst larger than one read ${label} is delivered oldest first across polls, with nothing replayed`, async () => {
  const { chat, events, watcher, done } = setup([...history]);
  try {
    await watcher.subscribe("chat5");
    for (let id = history.length ? 2 : 1; id <= 61; id++) chat.push({ id, author_id: 2, text: `m${id}` });
    await watcher.poll();
    await watcher.poll();
    await watcher.poll();
    const delivered = events.filter((e) => e.meta.event === "messages").flatMap((e) => [...e.content.matchAll(/^#(\d+)/gm)].map((x) => Number(x[1])));
    assert.deepEqual(delivered, Array.from({ length: history.length ? 60 : 61 }, (_, i) => i + (history.length ? 2 : 1)));
    assert.match(events[0].content, /more messages follow/);
    assert.equal(changes(events).length, 0);
  } finally { done(); }
});
