import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BitrixClient } from "../bitrix-client.js";
import { textResult, errorResult, zId } from "../types.js";

export function registerTaskStageTools(server: McpServer, client: BitrixClient): void {
  server.tool("bitrix24_task_stages_list",
    "List Kanban stages for a workgroup/project (entityId=0 for personal Kanban)",
    { entityId: z.number().describe("Workgroup/project ID, or 0 for personal Kanban") },
    async (args) => {
      try {
        const response = await client.call("task.stages.get", { entityId: args.entityId });
        return textResult(response.result);
      } catch (e) { return errorResult(e); }
    },
  );

  server.tool("bitrix24_task_stage_move", "Move a task to a different Kanban stage",
    { taskId: zId.describe("Task ID"), stageId: z.number().describe("Target stage ID") },
    async (args) => {
      try {
        await client.call("task.stages.movetask", { id: parseInt(args.taskId), stageId: args.stageId });
        return textResult(`Task ${args.taskId} moved to stage ${args.stageId}`);
      } catch (e) { return errorResult(e); }
    },
  );
}
