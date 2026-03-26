import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BitrixClient } from "../bitrix-client.js";
import { textResult, errorResult } from "../types.js";

export function registerWorkgroupTools(server: McpServer, client: BitrixClient): void {
  server.tool("bitrix24_workgroup_list", "List Bitrix24 workgroups and projects",
    {
      filter: z.record(z.string(), z.unknown()).optional().describe("Filter, e.g. {PROJECT: 'Y'} for projects only"),
    },
    async (args) => {
      try {
        const response = await client.call("sonet_group.get", { FILTER: args.filter ?? {} });
        return textResult(response.result);
      } catch (e) { return errorResult(e); }
    },
  );
}
