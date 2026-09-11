import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerCallTranscribeTools } from "../src/tools/call-transcribe.js";
import { captureTools, newClient, stubFetch, textOf } from "./support.js";

const NOTE_ARGS = { ownerType: "lead", ownerId: "10", itemId: "20" };
const NOT_FOUND = { error: "NOT_FOUND", error_description: "Элемент не найден" };

// Bitrix reports a missing note as HTTP 400 + {error: NOT_FOUND}; everything else must not
// look like "no note", or note_save overwrites a note it failed to read.
const scenarios: Array<{ name: string; read: [number, unknown]; blocksSave: boolean }> = [
  { name: "NOT_FOUND permits the save", read: [400, NOT_FOUND], blocksSave: false },
  { name: "another Bitrix error blocks the save", read: [400, { error: "ACCESS_DENIED", error_description: "no" }], blocksSave: true },
  { name: "a 5xx with an HTML body blocks the save", read: [502, "<html>Bad Gateway</html>"], blocksSave: true },
  { name: "a 2xx error envelope blocks the save", read: [200, { error: "INTERNAL", error_description: "boom" }], blocksSave: true },
];

for (const mode of ["create", "append"] as const) {
  for (const s of scenarios) {
    test(`note_save mode=${mode}: ${s.name}`, async () => {
      const fx = stubFetch((method) => {
        if (method === "crm.timeline.note.get") return s.read;
        if (method === "crm.timeline.note.save") return [200, { result: true }];
        throw new Error(`unexpected method ${method}`);
      });
      try {
        const tool = captureTools(registerCallTranscribeTools, newClient());
        const r = await tool("bitrix24_crm_timeline_note_save")({ ...NOTE_ARGS, text: "new", mode });
        const saved = fx.calls.some((c) => c.method === "crm.timeline.note.save");
        if (s.blocksSave) {
          assert.equal(r.isError, true, textOf(r));
          assert.equal(saved, false, "note.save must not be called after a failed read");
        } else {
          assert.equal(saved, true, "note.save expected after NOT_FOUND");
          assert.match(textOf(r), /"saved": true/);
        }
      } finally {
        fx.restore();
      }
    });
  }
}

test("note_save mode=create keeps the anti-clobber block when a note exists", async () => {
  const fx = stubFetch((method) => {
    if (method === "crm.timeline.note.get") return [200, { result: { text: "human note" } }];
    throw new Error(`unexpected method ${method}`);
  });
  // the blocked save writes a draft file into os.tmpdir(): point it at a private directory
  const savedTmp = process.env.TMPDIR;
  const privateTmp = mkdtempSync(join(tmpdir(), "b24-note-test-"));
  process.env.TMPDIR = privateTmp;
  try {
    const tool = captureTools(registerCallTranscribeTools, newClient());
    const r = await tool("bitrix24_crm_timeline_note_save")({ ...NOTE_ARGS, text: "new" });
    assert.match(textOf(r), /"saved": false/);
    assert.equal(fx.calls.some((c) => c.method === "crm.timeline.note.save"), false);
    const draft = JSON.parse(textOf(r)).draftFile as string;
    assert.ok(draft.startsWith(privateTmp), `draft written outside the private dir: ${draft}`);
    assert.equal(readFileSync(draft, "utf8"), "new");
  } finally {
    fx.restore();
    if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp;
    rmSync(privateTmp, { recursive: true, force: true });
  }
});

test("note_get: NOT_FOUND is hasNote=false, a transport failure is an error", async () => {
  let read: [number, unknown] = [400, NOT_FOUND];
  const fx = stubFetch(() => read);
  try {
    const tool = captureTools(registerCallTranscribeTools, newClient());
    assert.match(textOf(await tool("bitrix24_crm_timeline_note_get")(NOTE_ARGS)), /"hasNote": false/);
    read = [503, "<html>unavailable</html>"];
    const r = await tool("bitrix24_crm_timeline_note_get")(NOTE_ARGS);
    assert.equal(r.isError, true, textOf(r));
    assert.match(textOf(r), /503/);
  } finally {
    fx.restore();
  }
});
