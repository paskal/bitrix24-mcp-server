import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BitrixClient } from "../bitrix-client.js";
import { textResult, errorResult, zId } from "../types.js";

// CRM owner-type names → Bitrix OWNER_TYPE_ID (used by crm.activity.list)
const OWNER_TYPE_ID: Record<string, number> = { lead: 1, deal: 2, contact: 3, company: 4 };
const zOwnerType = z.enum(["lead", "deal", "contact", "company"]);

export function registerCrmActivityTools(server: McpServer, client: BitrixClient): void {
  server.tool(
    "bitrix24_crm_activity_list",
    "List timeline activities (calls, emails, SMS, meetings) on a CRM lead/deal/contact/company. " +
      "Use this to see a lead's call log: each phone call is one activity. " +
      "Key fields: TYPE_ID (2=call, 4=email, 6=SMS, 1=meeting, 3=task), PROVIDER_TYPE_ID ('CALL' for phone), " +
      "DIRECTION (1=incoming, 2=outgoing), START_TIME/END_TIME (subtract for duration), RESPONSIBLE_ID (the manager), " +
      "FILES (call recordings — audio only). NOTE: there is NO transcript or BitrixGPT call-assessment field in REST — " +
      "DESCRIPTION/PROVIDER_DATA are empty on calls; that scoring is UI-only and not exposed by any API method. " +
      "For call durations/recording-file-id/transcript-status use bitrix24_voximplant_statistic_get.",
    {
      ownerType: zOwnerType.describe("CRM entity type the activities belong to"),
      ownerId: zId.describe("ID of the lead/deal/contact/company"),
      filter: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "Extra filter merged with the owner, e.g. {PROVIDER_TYPE_ID: 'CALL'} for calls only, " +
            "{COMPLETED: 'Y'}, {DIRECTION: 1}. Date-bound: {'>CREATED': 'YYYY-MM-DD'} (strict >, date-only — " +
            "'>=' with time is silently ignored, same as the list-tool gotcha).",
        ),
      select: z.array(z.string()).optional().describe("Fields to return"),
      order: z.record(z.string(), z.string()).optional().describe("Sort order, e.g. {CREATED: 'desc'}"),
      limit: z
        .number()
        .optional()
        .describe("Max activities to return (default cap 500 = 10 pages x 50; pass limit >= total to fetch all)."),
    },
    async (args) => {
      try {
        const maxPages = args.limit ? Math.ceil(args.limit / 50) : 10;
        const { items, total } = await client.callList(
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
      "TRANSCRIPT_ID / TRANSCRIPT_PENDING report transcript status — on this portal these stay null/'N' (transcription " +
      "and BitrixGPT call scoring are UI-only CoPilot features, NOT exposed via REST). To get call understanding, " +
      "download the recording (RECORD_FILE_ID) and transcribe it yourself.",
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
