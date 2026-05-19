import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BitrixClient } from "../bitrix-client.js";
import type { KbClient } from "../kb-client.js";
import { registerTaskTools } from "./tasks.js";
import { registerTaskCommentTools } from "./task-comments.js";
import { registerTaskChecklistTools } from "./task-checklist.js";
import { registerTaskStageTools } from "./task-stages.js";
import { registerCrmDealTools } from "./crm-deals.js";
import { registerCrmContactTools } from "./crm-contacts.js";
import { registerCrmLeadTools } from "./crm-leads.js";
import { registerUserTools } from "./users.js";
import { registerWorkgroupTools } from "./workgroups.js";
import { registerImChatTools } from "./im-chat.js";
import { registerKbTools } from "./kb-articles.js";

// tools that mutate remote state — hidden when READONLY_MODE is active
const READONLY_WRITER_TOOLS: ReadonlySet<string> = new Set([
  "bitrix24_task_create",
  "bitrix24_task_update",
  "bitrix24_task_complete",
  "bitrix24_task_defer",
  "bitrix24_task_start",
  "bitrix24_task_stage_move",
  "bitrix24_task_checklist_add",
  "bitrix24_task_checklist_complete",
  "bitrix24_task_comment_add",
  "bitrix24_task_comment_update",
  "bitrix24_task_comment_delete",
  "bitrix24_task_attach_file",
  "bitrix24_task_post_image",
  "bitrix24_im_message_delete",
  "bitrix24_im_message_update",
  "kb_article_save",
]);

function isReadonlyMode(): boolean {
  const v = (process.env.READONLY_MODE ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

export function registerAllTools(server: McpServer, client: BitrixClient, kbClient?: KbClient): void {
  const readonly = isReadonlyMode();
  if (readonly) {
    // gate registration: wrap server.tool so calls with a blocked name become no-ops.
    // the wrapper is left in place after registration so late writer registrations stay blocked too.
    const origTool = server.tool.bind(server) as McpServer["tool"];
    const wrapped = ((name: string, ...rest: unknown[]): unknown => {
      if (READONLY_WRITER_TOOLS.has(name)) return undefined;
      return (origTool as unknown as (n: string, ...r: unknown[]) => unknown)(name, ...rest);
    }) as unknown as McpServer["tool"];
    (server as unknown as { tool: McpServer["tool"] }).tool = wrapped;
    console.error(`READONLY_MODE enabled: hiding ${READONLY_WRITER_TOOLS.size} writer tools`);
  }

  // registration happens after the wrapper is installed; the wrapper is left in place
  // so any accidental late registration of a writer tool stays blocked too.
  registerTaskTools(server, client);
  registerTaskCommentTools(server, client);
  registerTaskChecklistTools(server, client);
  registerTaskStageTools(server, client);
  registerCrmDealTools(server, client);
  registerCrmContactTools(server, client);
  registerCrmLeadTools(server, client);
  registerUserTools(server, client);
  registerWorkgroupTools(server, client);
  registerImChatTools(server, client);
  if (kbClient) registerKbTools(server, kbClient);
}
