import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BitrixClient } from "../bitrix-client.js";
import { textResult, errorResult, zId } from "../types.js";

export function registerCrmDealTools(server: McpServer, client: BitrixClient): void {
  server.tool("bitrix24_crm_deal_list", "List and filter CRM deals",
    {
      filter: z.record(z.string(), z.unknown()).optional().describe("Filter, e.g. {STAGE_ID: 'WON', ASSIGNED_BY_ID: 854}"),
      select: z.array(z.string()).optional().describe("Fields to return"),
      order: z.record(z.string(), z.string()).optional().describe("Sort order, e.g. {ID: 'desc'}"),
      limit: z.number().optional().describe("Max deals to return"),
    },
    async (args) => {
      try {
        const maxPages = args.limit ? Math.ceil(args.limit / 50) : 10;
        const { items, total } = await client.callList("crm.deal.list", {
          filter: args.filter ?? {},
          select: args.select ?? ["ID", "TITLE", "STAGE_ID", "CATEGORY_ID", "OPPORTUNITY", "CURRENCY_ID", "CONTACT_ID", "COMPANY_ID", "ASSIGNED_BY_ID", "DATE_CREATE", "CLOSED"],
          order: args.order ?? { ID: "desc" },
        }, maxPages);
        const deals = args.limit ? items.slice(0, args.limit) : items;
        return textResult({ total, count: deals.length, deals });
      } catch (e) { return errorResult(e); }
    },
  );

  server.tool("bitrix24_crm_deal_get", "Get a single CRM deal by ID",
    { dealId: zId.describe("Deal ID") },
    async (args) => {
      try {
        const response = await client.call("crm.deal.get", { ID: parseInt(args.dealId) });
        return textResult(response.result);
      } catch (e) { return errorResult(e); }
    },
  );
}
