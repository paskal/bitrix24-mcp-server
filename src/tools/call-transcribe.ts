import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BitrixClient } from "../bitrix-client.js";
import { textResult, errorResult, zId } from "../types.js";
import { getTranscriberPool } from "../transcriber.js";

// CRM owner-type names → Bitrix OWNER_TYPE_ID
const OWNER_TYPE_ID: Record<string, number> = { lead: 1, deal: 2, contact: 3, company: 4 };
// timeline-note ITEM_TYPE (verified live): 2 = activity note (the «заметка» on a call),
// 1 = history record. note.save with the wrong type silently returns result:false.
const NOTE_ITEM_TYPE: Record<string, number> = { activity: 2, history: 1 };

export function registerCallTranscribeTools(server: McpServer, client: BitrixClient): void {
  server.tool(
    "bitrix24_call_transcribe",
    "Transcribe a CRM call recording LOCALLY (fully offline — audio never leaves the machine) and optionally " +
      "store the transcript as a note on the call. Resolves the call's recording (Voximplant/Mango RECORD_FILE_ID), " +
      "downloads it, and decodes it with local Whisper large-v3 (strong Russian). Works out of the box — the MCP " +
      "auto-bootstraps its own Python venv + model on first use (first call is slow: it downloads the ~3 GB model). " +
      "Calls are served by a bounded worker pool, so firing hundreds of transcriptions at once just queues them and " +
      "drains N-at-a-time — never 300 parallel processes. This substitutes for Bitrix's UI-only call " +
      "transcription/BitrixGPT scoring, which is NOT in the REST API. Returns {text, segments}. NOTE: phone audio is " +
      "8 kHz mono (mixed-speaker), so expect substance-accurate but imperfect text with no speaker labels.",
    {
      activityId: zId.describe("The call activity ID (from bitrix24_crm_activity_list — a VOXIMPLANT_CALL activity)"),
      saveAsNote: z
        .boolean()
        .optional()
        .describe(
          "If true, write the transcript as the note ON the call itself (crm.timeline.note.save, itemType=activity). " +
            "Default false — returns the text without writing. This is a WRITE op (hidden in READONLY_MODE).",
        ),
      overwriteNote: z
        .boolean()
        .optional()
        .describe(
          "When saveAsNote is true: if the call already has a note, overwrite it (true) or skip and keep the existing " +
            "one (false, default). Each call has exactly ONE note — saving replaces it, it never appends/duplicates. " +
            "Different calls keep separate notes. Default false makes bulk re-runs idempotent (already-transcribed calls are skipped).",
        ),
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
        // bounded worker pool: many concurrent transcribe calls drain through a fixed
        // number of Whisper workers (model loaded once), never 300 parallel processes.
        const { text, segments } = await getTranscriberPool().submit(audioPath);

        const readonly = ["1", "true"].includes((process.env.READONLY_MODE ?? "").trim().toLowerCase());
        let noteSaved = false;
        if (args.saveAsNote && readonly) {
          return textResult({ activityId, recordingFileId: recId, noteSaved: false, segmentCount: segments.length, text, segments, warning: "READONLY_MODE: transcript returned but NOT saved as note" });
        }
        let noteSkipped = false;
        if (args.saveAsNote && text) {
          const act = await client.call<{ OWNER_TYPE_ID: string; OWNER_ID: string }>("crm.activity.get", { id: activityId });
          const ownerTypeId = parseInt(act.result.OWNER_TYPE_ID);
          const ownerId = parseInt(act.result.OWNER_ID);
          // idempotency: each call has exactly ONE note — save() replaces it. Skip if one
          // already exists unless overwriteNote, so bulk re-runs don't clobber prior work.
          if (!args.overwriteNote) {
            try {
              const existing = await client.call<{ text?: string } | null>("crm.timeline.note.get", {
                ownerTypeId, ownerId, itemType: NOTE_ITEM_TYPE.activity, itemId: activityId,
              });
              if (existing.result && (existing.result.text ?? "").trim()) noteSkipped = true;
            } catch {
              /* NOT_FOUND = no note yet → proceed to save */
            }
          }
          if (!noteSkipped) {
            await client.call("crm.timeline.note.save", {
              ownerTypeId, ownerId, itemType: NOTE_ITEM_TYPE.activity, itemId: activityId, text,
            });
            noteSaved = true;
          }
        }
        return textResult({ activityId, recordingFileId: recId, noteSaved, noteSkipped, segmentCount: segments.length, text, segments });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.tool(
    "bitrix24_crm_timeline_note_save",
    "Save (create/overwrite) the note attached to a CRM timeline item — e.g. the «заметка» box on a specific call. " +
      "Targets the item itself (itemType 'activity' = a call/email/etc., itemId = that activity's ID), so the note " +
      "appears right at the call, not as a loose lead comment. crm.timeline.note.save replaces any existing note text.",
    {
      ownerType: z.enum(["lead", "deal", "contact", "company"]).describe("CRM entity the timeline item belongs to"),
      ownerId: zId.describe("ID of the lead/deal/contact/company"),
      itemId: zId.describe("Timeline item ID — for a call note this is the call activity's ID"),
      itemType: z
        .enum(["activity", "history"])
        .optional()
        .describe("Timeline item type the note hangs off (default 'activity' — a call/email/meeting)"),
      text: z.string().describe("Note text (replaces any existing note on this item)"),
    },
    async (args) => {
      try {
        await client.call("crm.timeline.note.save", {
          ownerTypeId: OWNER_TYPE_ID[args.ownerType],
          ownerId: parseInt(args.ownerId),
          itemType: NOTE_ITEM_TYPE[args.itemType ?? "activity"],
          itemId: parseInt(args.itemId),
          text: args.text,
        });
        return textResult({ ok: true, itemId: args.itemId });
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}
