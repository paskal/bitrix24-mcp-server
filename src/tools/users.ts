import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BitrixClient } from "../bitrix-client.js";
import { textResult, errorResult, zId } from "../types.js";

export function registerUserTools(server: McpServer, client: BitrixClient): void {
  server.tool("bitrix24_user_get", "Get Bitrix24 user(s) by ID or filter",
    {
      userId: zId.optional().describe("Specific user ID"),
      filter: z.record(z.string(), z.unknown()).optional().describe("Filter, e.g. {ACTIVE: true}"),
    },
    async (args) => {
      try {
        const params: Record<string, unknown> = {};
        if (args.userId) params.ID = parseInt(args.userId);
        if (args.filter) Object.assign(params, args.filter);
        const response = await client.call("user.get", params);
        return textResult(response.result);
      } catch (e) { return errorResult(e); }
    },
  );

  server.tool("bitrix24_user_search", "Search Bitrix24 users by name",
    { query: z.string().describe("Search query (name, email, etc.)") },
    async (args) => {
      try {
        const response = await client.call("user.search", { FIND: args.query });
        return textResult(response.result);
      } catch (e) { return errorResult(e); }
    },
  );
}
