import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BitrixClient } from "../bitrix-client.js";
import { textResult, errorResult, zId } from "../types.js";

export function registerTaskCommentTools(server: McpServer, client: BitrixClient): void {
  server.tool(
    "bitrix24_task_comment_list",
    "List comments for a Bitrix24 task",
    {
      taskId: zId.describe("Task ID"),
      order: z.record(z.string(), z.string()).optional().describe("Sort order, e.g. {POST_DATE: 'desc'}"),
    },
    async (args) => {
      try {
        const response = await client.call("task.commentitem.getlist", {
          TASKID: parseInt(args.taskId),
          ORDER: args.order ?? { POST_DATE: "desc" },
        });
        return textResult(response.result);
      } catch (e) { return errorResult(e); }
    },
  );

  server.tool(
    "bitrix24_task_comment_add",
    "Add a comment to a Bitrix24 task",
    {
      taskId: zId.describe("Task ID"),
      text: z.string().describe("Comment text (BBCode supported, e.g. [USER=854]Name[/USER] for mentions)"),
    },
    async (args) => {
      try {
        const response = await client.call("task.commentitem.add", {
          TASKID: parseInt(args.taskId),
          FIELDS: { POST_MESSAGE: args.text },
        });
        return textResult(response.result);
      } catch (e) { return errorResult(e); }
    },
  );
}
