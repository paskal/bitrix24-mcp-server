import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BitrixClient } from "../bitrix-client.js";
import { textResult, errorResult, zId } from "../types.js";
import { resolveActivityAttachments } from "../attachments.js";

// CRM owner-type names → Bitrix OWNER_TYPE_ID (used by crm.activity.list)
const OWNER_TYPE_ID: Record<string, number> = { lead: 1, deal: 2, contact: 3, company: 4 };
const zOwnerType = z.enum(["lead", "deal", "contact", "company"]);

export function registerCrmActivityTools(server: McpServer, client: BitrixClient): void {
  server.tool(
    "bitrix24_crm_activity_list",
    "List timeline activities (calls, emails, SMS, meetings) on a CRM lead/deal/contact/company. " +
      "Use this to see a lead's call log: each phone call is one activity. " +
      "Key fields: TYPE_ID (2=call, 4=email, 6=SMS, 1=meeting, 3=task), PROVIDER_TYPE_ID ('CALL' for phone), " +
      "DIRECTION (1=incoming, 2=outgoing), START_TIME/END_TIME (subtract for duration), RESPONSIBLE_ID (the manager). " +
      "FILES are ATTACHMENTS, not just call recordings: on an email activity they are the documents that were sent or " +
      "received (счёт, спецификация, смета, КП, договор, ТЗ, чертежи). Raw Bitrix returns them as bare {id, url} with no " +
      "name, so this tool resolves each one and adds name/size/kind plus a per-activity FILES_SUMMARY " +
      "{documents, document_names, call_recordings, signature_images, images, other}. " +
      "ALWAYS read FILES_SUMMARY.document_names before concluding that a manager sent no calculation, no price or no КП — " +
      "the price is routinely in the attached PDF while the email body says only «направляю расчёт». " +
      "Inline Outlook signature logos (image001.png and similar) are classified as signature_image and carry no meaning. " +
      "CALL TRANSCRIPTS: the activity record itself has no transcript field (DESCRIPTION/PROVIDER_DATA are empty on calls, " +
      "and Bitrix's own BitrixGPT call scoring is UI-only), but this portal runs a local speech-to-text pipeline that " +
      "writes finished transcripts into the call's TIMELINE NOTE. So a missing transcript here does NOT mean there is none: " +
      "check bitrix24_crm_timeline_note_get (itemId = the call activity ID) before concluding anything about a call, then " +
      "fall back to bitrix24_crm_timeline_comment_list. Coverage of the note pipeline is partial (~16% of call activities, " +
      "skewed to longer calls), so an absent note is not evidence that no conversation happened. " +
      "For call duration/direction/recording-file-id use bitrix24_voximplant_statistic_get, which is authoritative over " +
      "anything written in a note header.",
    {
      ownerType: zOwnerType.describe("CRM entity type the activities belong to"),
      ownerId: zId.describe("ID of the lead/deal/contact/company"),
      filter: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "Extra filter merged with the owner, e.g. {PROVIDER_TYPE_ID: 'CALL'} for calls only, {PROVIDER_ID: 'CRM_EMAIL'} " +
            "for emails, {COMPLETED: 'Y'}, {DIRECTION: 2} for outgoing. Date-bound filters accept full ISO timestamps and " +
            "are honoured: {'>=CREATED': '2026-07-20T00:00:00+03:00'}, {'<CREATED': '...'}, {'>CREATED': '...'} " +
            "(verified 2026-07-28; the filter is posted as JSON so there is no key-encoding trap).",
        ),
      select: z.array(z.string()).optional().describe("Fields to return"),
      order: z.record(z.string(), z.string()).optional().describe("Sort order, e.g. {CREATED: 'desc'}"),
      limit: z
        .number()
        .optional()
        .describe("Max activities to return (default cap 500 = 10 pages x 50; pass limit >= total to fetch all)."),
      resolveFiles: z
        .boolean()
        .optional()
        .describe(
          "Resolve attachment names/sizes/kinds via disk.file.get (default true). Costs one extra REST call per 50 " +
            "attachments and nothing when the result set has none. Pass false only when attachments are irrelevant and " +
            "latency matters; the raw {id, url} pairs are then useless for judging what was sent.",
        ),
    },
    async (args) => {
      try {
        const maxPages = args.limit ? Math.ceil(args.limit / 50) : 10;
        const { items, total } = await client.callList<Record<string, unknown>>(
          "crm.activity.list",
          {
            filter: { OWNER_TYPE_ID: OWNER_TYPE_ID[args.ownerType], OWNER_ID: parseInt(args.ownerId), ...(args.filter ?? {}) },
            select: args.select ?? [
              "ID", "OWNER_ID", "OWNER_TYPE_ID", "TYPE_ID", "PROVIDER_ID", "PROVIDER_TYPE_ID",
              "SUBJECT", "DIRECTION", "START_TIME", "END_TIME", "COMPLETED", "RESPONSIBLE_ID", "FILES",
            ],
            order: args.order ?? { CREATED: "desc" },
          },
          maxPages,
        );
        const activities = args.limit ? items.slice(0, args.limit) : items;
        if (args.resolveFiles !== false) await resolveActivityAttachments(client, activities);
        return textResult({ total, count: activities.length, activities });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.tool(
    "bitrix24_voximplant_statistic_get",
    "Get telephony call statistics (Mango Office / Voximplant) — one row per call. " +
      "Filter by CRM_ENTITY_ID (the lead/deal id), CRM_ACTIVITY_ID, CALL_ID, or PORTAL_USER_ID. " +
      "Key fields: CALL_DURATION (seconds), CALL_TYPE (1=outbound, 2=inbound), CALL_START_DATE, " +
      "PHONE_NUMBER, PORTAL_USER_ID (the manager), RECORD_FILE_ID (the audio recording's disk file id, null if not recorded), " +
      "CALL_FAILED_CODE (200=answered, 304=missed), CALL_VOTE, REST_APP_NAME (the telephony connector). " +
      "TRANSCRIPT_ID / TRANSCRIPT_PENDING stay null/'N' on this portal (re-verified 2026-07-28 across the 50 most recent " +
      "calls): Bitrix's own transcription and BitrixGPT scoring are UI-only CoPilot features, not exposed via REST. " +
      "To understand a call, first check the local pipeline's transcript in the timeline note " +
      "(bitrix24_crm_timeline_note_get, itemId = CRM_ACTIVITY_ID); only if there is none, download the recording " +
      "(RECORD_FILE_ID) and transcribe it with bitrix24_call_transcribe. " +
      "This method is the authority on direction and duration — a note header that disagrees is wrong.",
    {
      filter: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "e.g. {CRM_ENTITY_ID: 143820} for all calls on a lead, {CRM_ACTIVITY_ID: 693490} for one call, " +
            "{PORTAL_USER_ID: 796} for a manager. Date-bound: {'>CALL_START_DATE': 'YYYY-MM-DD'}.",
        ),
      sort: z.string().optional().describe("Sort column, e.g. 'CALL_START_DATE' (default)"),
      sortOrder: z.enum(["ASC", "DESC"]).optional().describe("Sort direction (default DESC)"),
      limit: z.number().optional().describe("Max rows to return (default cap 500; pass limit >= total to fetch all)."),
    },
    async (args) => {
      try {
        const maxPages = args.limit ? Math.ceil(args.limit / 50) : 10;
        const { items, total } = await client.callList(
          "voximplant.statistic.get",
          {
            FILTER: args.filter ?? {},
            SORT: args.sort ?? "CALL_START_DATE",
            ORDER: args.sortOrder ?? "DESC",
          },
          maxPages,
        );
        const calls = args.limit ? items.slice(0, args.limit) : items;
        return textResult({ total, count: calls.length, calls });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.tool(
    "bitrix24_crm_timeline_comment_list",
    "List manual timeline comments (manager notes) on a CRM lead/deal/contact/company. " +
      "These are the free-text notes a manager types into the entity timeline — separate from activities (calls/emails). " +
      "Returns COMMENT (the note text), AUTHOR_ID (who wrote it), CREATED. " +
      "Useful for reviewing what a manager recorded about a deal beyond the structured fields.",
    {
      ownerType: zOwnerType.describe("CRM entity type the comments belong to"),
      ownerId: zId.describe("ID of the lead/deal/contact/company"),
      order: z.record(z.string(), z.string()).optional().describe("Sort order, e.g. {CREATED: 'desc'}"),
      limit: z.number().optional().describe("Max comments to return (default cap 500)."),
    },
    async (args) => {
      try {
        const maxPages = args.limit ? Math.ceil(args.limit / 50) : 10;
        const { items, total } = await client.callList(
          "crm.timeline.comment.list",
          {
            filter: { ENTITY_ID: parseInt(args.ownerId), ENTITY_TYPE: args.ownerType },
            order: args.order ?? { CREATED: "desc" },
          },
          maxPages,
        );
        const comments = args.limit ? items.slice(0, args.limit) : items;
        return textResult({ total, count: comments.length, comments });
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}
