import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BitrixClient } from "../bitrix-client.js";
import { textResult, errorResult, zId } from "../types.js";

export function registerTaskChecklistTools(server: McpServer, client: BitrixClient): void {
  server.tool("bitrix24_task_checklist_list", "List checklist items for a Bitrix24 task",
    { taskId: zId.describe("Task ID") },
    async (args) => {
      try {
        const response = await client.call("task.checklistitem.getlist", { TASKID: parseInt(args.taskId) });
        return textResult(response.result);
      } catch (e) { return errorResult(e); }
    },
  );

  server.tool("bitrix24_task_checklist_add", "Add a checklist item to a Bitrix24 task",
    {
      taskId: zId.describe("Task ID"),
      title: z.string().describe("Checklist item text"),
    },
    async (args) => {
      try {
        const response = await client.call("task.checklistitem.add", {
          TASKID: parseInt(args.taskId), FIELDS: { TITLE: args.title, IS_COMPLETE: "N" },
        });
        return textResult(response.result);
      } catch (e) { return errorResult(e); }
    },
  );

  server.tool("bitrix24_task_checklist_complete", "Mark a checklist item as complete",
    { taskId: zId.describe("Task ID"), itemId: zId.describe("Checklist item ID") },
    async (args) => {
      try {
        await client.call("task.checklistitem.complete", {
          TASKID: parseInt(args.taskId), ITEM_ID: parseInt(args.itemId),
        });
        return textResult(`Checklist item ${args.itemId} completed`);
      } catch (e) { return errorResult(e); }
    },
  );
}
