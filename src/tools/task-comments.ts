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
    "Add a comment to a Bitrix24 task. Uses legacy forum API which posts to both the task chat and the comment section. The message will appear in the task's IM chat for all participants. RETURNS the comment ID (numeric) — keep it: the same ID can later be passed to `bitrix24_task_comment_update` to edit, `bitrix24_task_comment_delete` to remove, or `bitrix24_im_message_update`/`bitrix24_im_message_delete` (same underlying message). To ATTACH A FILE to the task (docx brief, screenshot, pdf, etc.), do NOT try to inline it in the comment — use `bitrix24_task_attach_file` separately. Typical pattern: (1) attach the file, then (2) post a short comment referencing the attached file name. Comment text supports BBCode but NOT Markdown (backticks render literally, ** doesn't bold). Use [B]…[/B], [I]…[/I], [URL=…]…[/URL], [USER=ID]Name[/USER] for mentions. For bullet lists in a COMMENT put a literal • at the line start — [*]/[LIST] render literally («[*]») in comments (they only format inside task DESCRIPTIONS, not comments). DISCLOSURE — the comment text MUST end with a final line, on its own, reading exactly «(написано агентом)»: it posts under the human owner's account but is agent-written (owner rule, favor-group).",
    {
      taskId: zId.describe("Task ID"),
      text: z.string().describe("Comment text (BBCode only — no Markdown. Patterns: [B]bold[/B], [URL=…]text[/URL], [USER=854]Name[/USER])"),
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

  server.tool(
    "bitrix24_task_comment_update",
    "Edit the text of an existing Bitrix24 task comment. Pass the comment ID returned by `bitrix24_task_comment_add` (it equals the IM message ID — task comments mirror 1:1 to the task's IM chat). Use this instead of posting a follow-up «UPD:» comment when you need to correct an earlier message. Only the comment's author can edit. Note: `task.commentitem.update` direct REST returns ACTION_NOT_ALLOWED for typical webhook scopes, so this tool internally calls `im.message.update` which works.",
    {
      commentId: z.number().describe("Comment ID returned by bitrix24_task_comment_add (same as IM message ID)"),
      text: z.string().describe("New comment text (BBCode — same conventions as add)"),
    },
    async (args) => {
      try {
        const response = await client.call("im.message.update", {
          MESSAGE_ID: args.commentId,
          MESSAGE: args.text,
        });
        return textResult(response.result === true ? "Updated" : response.result);
      } catch (e) { return errorResult(e); }
    },
  );

  server.tool(
    "bitrix24_task_comment_delete",
    "Delete a Bitrix24 task comment by ID. Pass the comment ID returned by `bitrix24_task_comment_add`. The deleted comment is replaced by a «Это сообщение было удалено» placeholder in the task chat. Only the author or admins can delete. Internally calls `im.message.delete` (same reason as comment_update — direct task.commentitem.delete is action-not-allowed via webhook scope).",
    {
      commentId: z.number().describe("Comment ID returned by bitrix24_task_comment_add (same as IM message ID)"),
    },
    async (args) => {
      try {
        const response = await client.call("im.message.delete", {
          MESSAGE_ID: args.commentId,
        });
        return textResult(response.result === true ? "Deleted" : response.result);
      } catch (e) { return errorResult(e); }
    },
  );
}
