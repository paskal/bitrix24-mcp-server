import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BitrixClient } from "../bitrix-client.js";
import { textResult, errorResult } from "../types.js";

export function registerImChatTools(server: McpServer, client: BitrixClient): void {
  server.tool(
    "bitrix24_im_chat_messages",
    "Read messages from a Bitrix24 IM chat. Use for reading task chats, group chats, or 1-on-1 dialogs. For task chats, the DIALOG_ID is 'chatNNN' where NNN is the task's chatId field.",
    {
      dialogId: z.string().describe("Dialog ID: 'chatNNN' for group/task chats, or user ID as string for 1-on-1"),
      limit: z.number().optional().describe("Max messages to return (default: 20)"),
    },
    async (args) => {
      try {
        const response = await client.call("im.dialog.messages.get", {
          DIALOG_ID: args.dialogId,
          LIMIT: args.limit ?? 20,
        });
        const result = response.result as Record<string, unknown> | null;
        if (!result || !("messages" in result)) {
          return textResult("No messages found");
        }

        const messages = result.messages as Array<Record<string, unknown>>;
        const users = (result.users as Array<Record<string, unknown>>) ?? [];
        const userMap = new Map(users.map((u) => [String(u.id), u.name ?? u.first_name]));

        const formatted = messages.map((m) => ({
          id: m.id,
          author: userMap.get(String(m.author_id)) ?? m.author_id,
          date: m.date,
          text: typeof m.text === "string" ? m.text.replace(/<[^>]+>/g, "").replace(/\[(?!USER)[^\]]+\]/g, "").trim() : m.text,
        }));
        return textResult(formatted);
      } catch (e) { return errorResult(e); }
    },
  );
}
