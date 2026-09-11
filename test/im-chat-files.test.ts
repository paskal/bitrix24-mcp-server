import { test } from "node:test";
import assert from "node:assert/strict";
import { registerImChatTools } from "../src/tools/im-chat.js";
import { captureTools, newClient, stubFetch, textOf } from "./support.js";

const DL = "https://portal.example/disk/download/";
const SMALL = Buffer.from("small-image-bytes");
const BIG = 6 * 1024 * 1024;

// A download response whose body reads and cancellations are counted, so a test can assert
// that a non-image or an oversized image never has its body read.
function download(status: number, mime: string, bytes: Buffer, counters: { read: number; cancelled: number }): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": mime, "content-length": String(bytes.length) }),
    body: { cancel: async () => { counters.cancelled++; } },
    arrayBuffer: async () => { counters.read++; return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length); },
  } as unknown as Response;
}

interface Fixture { name: string; size: number; mime: string; bytes: Buffer; status?: number }

function setup(files: Record<string, Fixture>, messages?: unknown) {
  const counters = { read: 0, cancelled: 0, downloads: 0 };
  const fx = stubFetch(
    (method, params) => {
      if (method === "disk.file.get") {
        const f = files[String(params.id)];
        return f ? [200, { result: { ID: params.id, NAME: f.name, SIZE: String(f.size), DOWNLOAD_URL: `${DL}${params.id}` } }] : [400, { error: "ERROR_NOT_FOUND" }];
      }
      if (method === "im.dialog.messages.get") return [200, { result: messages }];
      throw new Error(`unexpected method ${method}`);
    },
    (url) => {
      counters.downloads++;
      const f = files[url.slice(DL.length)];
      return download(f.status ?? 200, f.mime, f.bytes, counters);
    },
  );
  const tool = captureTools(registerImChatTools, newClient());
  return { tool, counters, calls: fx.calls, restore: fx.restore };
}

test("im_file_get: a PDF is answered from headers and metadata, body never read", async () => {
  const t = setup({ "1": { name: "contract.pdf", size: BIG, mime: "application/pdf", bytes: Buffer.alloc(16) } });
  try {
    const r = await t.tool("bitrix24_im_file_get")({ fileId: 1 });
    assert.deepEqual(JSON.parse(textOf(r)), { name: "contract.pdf", mime: "application/pdf", size: BIG, downloadUrl: `${DL}1` });
    assert.equal(t.counters.read, 0, "body must not be read");
    assert.equal(t.counters.cancelled, 1, "body must be cancelled");
  } finally { t.restore(); }
});

test("im_file_get: an oversized image returns metadata without reading the body", async () => {
  const t = setup({ "2": { name: "photo.jpg", size: BIG, mime: "image/jpeg", bytes: Buffer.alloc(16) } });
  try {
    const r = await t.tool("bitrix24_im_file_get")({ fileId: 2 });
    assert.equal(JSON.parse(textOf(r)).size, BIG);
    assert.equal(t.counters.read, 0);
    assert.equal(t.counters.cancelled, 1);
  } finally { t.restore(); }
});

test("im_file_get: a small image is still inlined", async () => {
  const t = setup({ "3": { name: "pic.png", size: SMALL.length, mime: "image/png", bytes: SMALL } });
  try {
    const r = await t.tool("bitrix24_im_file_get")({ fileId: 3 });
    const img = r.content.find((c) => c.type === "image");
    assert.ok(img, "image block expected");
    assert.equal(img.data, SMALL.toString("base64"));
    assert.equal(img.mimeType, "image/png");
    assert.equal(t.counters.read, 1);
  } finally { t.restore(); }
});

test("im_file_get: a failed download is an error and the body is cancelled", async () => {
  const t = setup({ "4": { name: "gone.png", size: 10, mime: "text/html", bytes: Buffer.alloc(10), status: 404 } });
  try {
    const r = await t.tool("bitrix24_im_file_get")({ fileId: 4 });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /HTTP 404/);
    assert.equal(t.counters.cancelled, 1);
  } finally { t.restore(); }
});

test("im_chat_messages: a listed oversized image makes no disk or download call; a small one inlines", async () => {
  const messages = {
    messages: [
      { id: 11, author_id: 1, date: "d", text: "big", params: { FILE_ID: [21] } },
      { id: 12, author_id: 1, date: "d", text: "small", params: { FILE_ID: [22] } },
    ],
    users: [{ id: 1, name: "Someone" }],
    files: [
      { id: 21, name: "huge.jpg", type: "image", size: BIG },
      { id: 22, name: "tiny.png", type: "image", size: SMALL.length },
    ],
  };
  const t = setup({
    "21": { name: "huge.jpg", size: BIG, mime: "image/jpeg", bytes: Buffer.alloc(16) },
    "22": { name: "tiny.png", size: SMALL.length, mime: "image/png", bytes: SMALL },
  }, messages);
  try {
    const r = await t.tool("bitrix24_im_chat_messages")({ dialogId: "chat1" });
    const diskCalls = t.calls.filter((c) => c.method === "disk.file.get").map((c) => String(c.params.id));
    assert.deepEqual(diskCalls, ["22"], "only the small image goes through disk.file.get");
    assert.equal(t.counters.downloads, 1);
    assert.equal(t.counters.read, 1);
    assert.match(textOf(r), /huge\.jpg.*too large to inline.*fileId 21/);
    assert.equal(r.content.filter((c) => c.type === "image").length, 1);
  } finally { t.restore(); }
});
