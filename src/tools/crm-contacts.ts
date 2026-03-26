import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BitrixClient } from "../bitrix-client.js";
import { textResult, errorResult, zId } from "../types.js";

export function registerCrmContactTools(server: McpServer, client: BitrixClient): void {
  server.tool("bitrix24_crm_contact_list", "List and filter CRM contacts",
    {
      filter: z.record(z.string(), z.unknown()).optional().describe("Filter, e.g. {ASSIGNED_BY_ID: 854}"),
      select: z.array(z.string()).optional().describe("Fields to return"),
      order: z.record(z.string(), z.string()).optional().describe("Sort order, e.g. {ID: 'desc'}"),
      limit: z.number().optional().describe("Max contacts to return"),
    },
    async (args) => {
      try {
        const maxPages = args.limit ? Math.ceil(args.limit / 50) : 10;
        const { items, total } = await client.callList("crm.contact.list", {
          filter: args.filter ?? {},
          select: args.select ?? ["ID", "NAME", "LAST_NAME", "PHONE", "EMAIL", "ASSIGNED_BY_ID"],
          order: args.order ?? { ID: "desc" },
        }, maxPages);
        const contacts = args.limit ? items.slice(0, args.limit) : items;
        return textResult({ total, count: contacts.length, contacts });
      } catch (e) { return errorResult(e); }
    },
  );

  server.tool("bitrix24_crm_contact_get", "Get a single CRM contact by ID",
    { contactId: zId.describe("Contact ID") },
    async (args) => {
      try {
        const response = await client.call("crm.contact.get", { ID: parseInt(args.contactId) });
        return textResult(response.result);
      } catch (e) { return errorResult(e); }
    },
  );
}
