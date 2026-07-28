import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BitrixClient } from "../bitrix-client.js";
import { textResult, errorResult, zId } from "../types.js";

export function registerCrmLeadTools(server: McpServer, client: BitrixClient): void {
  server.tool("bitrix24_crm_lead_list", "List and filter CRM leads",
    {
      filter: z.record(z.string(), z.unknown()).optional().describe("Filter, e.g. {STATUS_ID: 'NEW', ASSIGNED_BY_ID: 854}. Comparison operators DO work here, re-verified against this portal 2026-07-28: {'>=DATE_CREATE': '2026-07-20T00:00:00+03:00'} (inclusive, full ISO timestamp honoured), {'>DATE_CREATE': ...} (exclusive), {'>=ID': N} and {'>ID': N} all filter correctly — this tool posts the filter as JSON, so the curl --data-urlencode trap (which leaves the '>' in the KEY unencoded and makes Bitrix drop the condition) does not apply. Date-only values with a strict '>' are NOT required. The operator that IS unreliable: {FIELD: ''} (\"is empty\") on UF string fields returns records regardless (measured: 8 of 50 rows came back non-empty), so always client-check the value. {'!FIELD': ''} (truthy) and {FIELD: value} (exact) are reliable."),
      select: z.array(z.string()).optional().describe("Fields to return"),
      order: z.record(z.string(), z.string()).optional().describe("Sort order, e.g. {ID: 'desc'}"),
      limit: z.number().optional().describe("Max leads to return. WITHOUT this the tool returns at most 500 (10 pages x 50) and silently truncates — the response 'total' shows the true match count while 'leads' is capped at 500. For a query that matches more, pass limit >= total to fetch everything."),
    },
    async (args) => {
      try {
        const maxPages = args.limit ? Math.ceil(args.limit / 50) : 10;
        const { items, total } = await client.callList("crm.lead.list", {
          filter: args.filter ?? {},
          select: args.select ?? ["ID", "TITLE", "NAME", "LAST_NAME", "STATUS_ID", "ASSIGNED_BY_ID", "SOURCE_ID", "DATE_CREATE"],
          order: args.order ?? { ID: "desc" },
        }, maxPages);
        const leads = args.limit ? items.slice(0, args.limit) : items;
        return textResult({ total, count: leads.length, leads });
      } catch (e) { return errorResult(e); }
    },
  );

  server.tool("bitrix24_crm_lead_get", "Get a single CRM lead by ID",
    { leadId: zId.describe("Lead ID") },
    async (args) => {
      try {
        const response = await client.call("crm.lead.get", { ID: parseInt(args.leadId) });
        return textResult(response.result);
      } catch (e) { return errorResult(e); }
    },
  );
}
