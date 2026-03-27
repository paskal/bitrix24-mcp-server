import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BitrixClient } from "../bitrix-client.js";
import { textResult, errorResult, zId } from "../types.js";

export function registerTaskCommentTools(server: McpServer, client: BitrixClient): void {
  server.tool(
    "bitrix24_task_comment_list",
    "Read task chat messages (modern B24). In current Bitrix24, all task discussion happens in the task's IM chat (right panel). Legacy forum comments (left panel) are deprecated. This tool reads from IM chat first, falls back to forum comments for old tasks.",
    {
      taskId: zId.describe("Task ID"),
      limit: z.number().optional().describe("Max messages to return (default: 20)"),
    },
    async (args) => {
      try {
        // first, get the task's chatId
        const taskResponse = await client.call<{ task: Record<string, unknown> }>("tasks.task.get", {
          taskId: parseInt(args.taskId),
          select: ["ID", "CHAT_ID"],
        });
        const chatId = taskResponse.result?.task?.chatId;

        if (chatId) {
          // read from IM chat (modern B24 — task chat panel)
          const chatResponse = await client.call("im.dialog.messages.get", {
            DIALOG_ID: `chat${chatId}`,
            LIMIT: args.limit ?? 20,
          });
          const result = chatResponse.result as Record<string, unknown> | null;
          if (result && "messages" in result) {
            const messages = result.messages as Array<Record<string, unknown>>;
            const users = (result.users as Array<Record<string, unknown>>) ?? [];
            const userMap = new Map(users.map((u) => [String(u.id), u.name ?? u.first_name]));

            const formatted = messages.map((m) => ({
              id: m.id,
              author: userMap.get(String(m.author_id)) ?? m.author_id,
              date: m.date,
              text: typeof m.text === "string" ? m.text.replace(/<[^>]+>/g, "").replace(/\[[^\]]+\]/g, "").trim() : m.text,
            }));
            return textResult(formatted);
          }
        }

        // fallback: legacy forum comments
        const response = await client.call("task.commentitem.getlist", {
          TASKID: parseInt(args.taskId),
          ORDER: { POST_DATE: "desc" },
        });
        return textResult(response.result);
      } catch (e) { return errorResult(e); }
    },
  );

  server.tool(
    "bitrix24_task_comment_add",
    "Add a comment to a Bitrix24 task. Uses legacy forum API which posts to both the task chat and the comment section. The message will appear in the task's IM chat for all participants.",
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
