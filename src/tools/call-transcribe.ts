import { z } from "zod";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BitrixClient } from "../bitrix-client.js";
import { textResult, errorResult, zId } from "../types.js";
import { getTranscriberPool } from "../transcriber.js";

// CRM owner-type names → Bitrix OWNER_TYPE_ID
const OWNER_TYPE_ID: Record<string, number> = { lead: 1, deal: 2, contact: 3, company: 4 };
// timeline-note ITEM_TYPE (verified live): 2 = activity note (the «заметка» on a call),
// 1 = history record. note.save with the wrong type silently returns result:false.
const NOTE_ITEM_TYPE: Record<string, number> = { activity: 2, history: 1 };
const zOwnerType = z.enum(["lead", "deal", "contact", "company"]);
const zItemType = z.enum(["activity", "history"]);

async function getNoteText(
  client: BitrixClient,
  p: { ownerTypeId: number; ownerId: number; itemType: number; itemId: number },
): Promise<string | null> {
  try {
    const r = await client.call<{ text?: string } | null>("crm.timeline.note.get", {
      ownerTypeId: p.ownerTypeId, ownerId: p.ownerId, itemType: p.itemType, itemId: p.itemId,
    });
    const t = (r.result?.text ?? "").trim();
    return t || null;
  } catch {
    return null; // NOT_FOUND = no note
  }
}

export function registerCallTranscribeTools(server: McpServer, client: BitrixClient): void {
  // --- transcription only (no writes) ---
  server.tool(
    "bitrix24_call_transcribe",
    "Transcribe a CRM call recording LOCALLY and fully offline (audio never leaves the machine). Resolves the call's " +
      "recording (Voximplant/Mango RECORD_FILE_ID), downloads it, and decodes it with local Whisper large-v3 (strong " +
      "Russian). Works out of the box — the MCP auto-bootstraps its own Python venv + model on first use (first call is " +
      "slow: it downloads the ~3 GB model). A bounded worker pool serves calls, so firing hundreds at once just queues " +
      "and drains N-at-a-time. This does NOT write anything to Bitrix — it only returns the transcript. To store it, the " +
      "caller saves it with bitrix24_crm_timeline_note_save. " +
      "Returns {text, segments, responsibleId, direction}: raw, unlabelled segments (Whisper splits by pause, not by " +
      "speaker). For «who-said-what» labels the calling model decides — it has responsibleId (the manager) here and the " +
      "client's name on the lead. Substitutes for Bitrix's UI-only call transcription/BitrixGPT scoring, which is NOT in " +
      "the REST API. NOTE: phone audio is 8 kHz mono (mixed-speaker), so expect substance-accurate but imperfect text.",
    {
      activityId: zId.describe("The call activity ID (from bitrix24_crm_activity_list — a VOXIMPLANT_CALL activity)"),
    },
    async (args) => {
      try {
        const activityId = parseInt(args.activityId);
        const recId = await client.getCallRecordingFileId(activityId);
        if (!recId) {
          return textResult({ activityId, error: "no recording for this call (missed/declined or not recorded)" });
        }
        const { url } = await client.getDiskFileDownloadUrl(recId);
        const audioPath = await client.downloadToTemp(url, ".mp3");
        const { text, segments } = await getTranscriberPool().submit(audioPath);
        // surface the manager + direction so the caller can label speakers without extra round-trips
        let responsibleId: string | null = null;
        let direction: string | null = null;
        try {
          const act = await client.call<{ RESPONSIBLE_ID: string; DIRECTION: string }>("crm.activity.get", { id: activityId });
          responsibleId = act.result.RESPONSIBLE_ID ?? null;
          direction = act.result.DIRECTION === "1" ? "incoming" : act.result.DIRECTION === "2" ? "outgoing" : null;
        } catch {
          /* non-fatal */
        }
        return textResult({ activityId, recordingFileId: recId, responsibleId, direction, segmentCount: segments.length, text, segments });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  // --- read the note on a timeline item ---
  server.tool(
    "bitrix24_crm_timeline_note_get",
    "Read the «заметка» note attached to a CRM timeline item (e.g. a specific call). Returns the note text, or null if " +
      "there is none. Use this before saving to check whether a note already exists (so you don't clobber a human note " +
      "or a prior transcript).",
    {
      ownerType: zOwnerType.describe("CRM entity the timeline item belongs to"),
      ownerId: zId.describe("ID of the lead/deal/contact/company"),
      itemId: zId.describe("Timeline item ID — for a call note this is the call activity's ID"),
      itemType: zItemType.optional().describe("Timeline item type (default 'activity' — a call/email/meeting)"),
    },
    async (args) => {
      try {
        const text = await getNoteText(client, {
          ownerTypeId: OWNER_TYPE_ID[args.ownerType], ownerId: parseInt(args.ownerId),
          itemType: NOTE_ITEM_TYPE[args.itemType ?? "activity"], itemId: parseInt(args.itemId),
        });
        return textResult({ itemId: args.itemId, hasNote: text !== null, text });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  // --- write the note on a timeline item, with an anti-clobber safeguard ---
  server.tool(
    "bitrix24_crm_timeline_note_save",
    "Save the «заметка» note on a CRM timeline item (e.g. the note on a specific call, so it appears at the call, not as " +
      "a loose lead comment). A timeline item has exactly ONE note — saving REPLACES it. " +
      "Anti-clobber safeguard: in the default mode='create', if a note already exists this does NOT overwrite it — it " +
      "writes your text to a local draft file and returns the existing note plus a recommendation, so the calling model " +
      "can decide. Re-call with mode='replace' to overwrite, or mode='append' to keep both (existing + a separator + new).",
    {
      ownerType: zOwnerType.describe("CRM entity the timeline item belongs to"),
      ownerId: zId.describe("ID of the lead/deal/contact/company"),
      itemId: zId.describe("Timeline item ID — for a call note this is the call activity's ID"),
      itemType: zItemType.optional().describe("Timeline item type the note hangs off (default 'activity')"),
      text: z.string().describe("Note text to save"),
      mode: z
        .enum(["create", "replace", "append"])
        .optional()
        .describe(
          "create (default): save only if no note exists; if one exists, do NOT overwrite — return it + a draft file so " +
            "you can decide. replace: overwrite any existing note. append: existing note + separator + new text.",
        ),
    },
    async (args) => {
      try {
        const ownerTypeId = OWNER_TYPE_ID[args.ownerType];
        const ownerId = parseInt(args.ownerId);
        const itemType = NOTE_ITEM_TYPE[args.itemType ?? "activity"];
        const itemId = parseInt(args.itemId);
        const mode = args.mode ?? "create";
        const existing = await getNoteText(client, { ownerTypeId, ownerId, itemType, itemId });

        if (existing && mode === "create") {
          // safeguard: don't clobber. Persist the would-be note so it isn't lost, and hand the decision back.
          const draftFile = join(tmpdir(), `b24-note-${args.ownerType}${ownerId}-${itemId}.txt`);
          writeFileSync(draftFile, args.text);
          return textResult({
            saved: false,
            blocked: "a note already exists on this item; not overwritten",
            existingNote: existing,
            draftFile,
            recommendation:
              "decide whether the existing note is worth keeping. To overwrite, re-call with mode='replace'. To keep " +
              "both, re-call with mode='append'. The new text is saved at draftFile meanwhile.",
          });
        }

        const finalText =
          mode === "append" && existing ? `${existing}\n\n— — —\n\n${args.text}` : args.text;
        await client.call("crm.timeline.note.save", { ownerTypeId, ownerId, itemType, itemId, text: finalText });
        return textResult({ saved: true, mode, replacedExisting: existing !== null, itemId: args.itemId });
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}
