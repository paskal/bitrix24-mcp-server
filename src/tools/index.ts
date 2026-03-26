import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BitrixClient } from "../bitrix-client.js";
import { registerTaskTools } from "./tasks.js";
import { registerTaskCommentTools } from "./task-comments.js";
import { registerTaskChecklistTools } from "./task-checklist.js";
import { registerTaskStageTools } from "./task-stages.js";
import { registerCrmDealTools } from "./crm-deals.js";
import { registerCrmContactTools } from "./crm-contacts.js";
import { registerCrmLeadTools } from "./crm-leads.js";
import { registerUserTools } from "./users.js";
import { registerWorkgroupTools } from "./workgroups.js";

export function registerAllTools(server: McpServer, client: BitrixClient): void {
  registerTaskTools(server, client);
  registerTaskCommentTools(server, client);
  registerTaskChecklistTools(server, client);
  registerTaskStageTools(server, client);
  registerCrmDealTools(server, client);
  registerCrmContactTools(server, client);
  registerCrmLeadTools(server, client);
  registerUserTools(server, client);
  registerWorkgroupTools(server, client);
}
