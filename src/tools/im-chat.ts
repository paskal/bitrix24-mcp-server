import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BitrixClient } from "../bitrix-client.js";
import { textResult, errorResult } from "../types.js";

export function registerImChatTools(server: McpServer, client: BitrixClient): void {
  server.tool(
    "bitrix24_im_chat_list",
    "List IM chats the current user participates in. Returns recent conversations sorted by last activity. Use to discover chat IDs for reading messages.",
    {
      limit: z.number().optional().describe("Max chats to return (default: 50)"),
      type: z.enum(["all", "chat", "open", "user"]).optional().describe("Filter by type: 'chat' for group chats, 'open' for open channels, 'user' for 1-on-1 (default: all)"),
    },
    async (args) => {
      try {
        const response = await client.call("im.recent.list", {
          LIMIT: args.limit ?? 50,
          ...(args.type && args.type !== "all" ? { FILTER: { TYPE: args.type } } : {}),
        });
        const result = response.result as Record<string, unknown> | null;
        if (!result || !("items" in result)) {
          return textResult("No chats found");
        }

        const items = result.items as Array<Record<string, unknown>>;
        const formatted = items.map((item) => {
          const chat = item.chat as Record<string, unknown> | undefined;
          const user = item.user as Record<string, unknown> | undefined;
          return {
            type: item.type,
            dialogId: chat?.id ? `chat${chat.id}` : item.id,
            chatId: chat?.id,
            title: chat?.name ?? (user ? `${user.first_name} ${user.last_name}` : item.id),
            lastMessage: item.message ? (item.message as Record<string, unknown>).text : null,
            lastDate: item.message ? (item.message as Record<string, unknown>).date : null,
            counter: item.counter,
          };
        });
        return textResult(formatted);
      } catch (e) { return errorResult(e); }
    },
  );

  server.tool(
    "bitrix24_im_chat_messages",
    "Read messages from a Bitrix24 IM chat. Use for reading task chats, group chats, or 1-on-1 dialogs. For task chats, the DIALOG_ID is 'chatNNN' where NNN is the task's chatId field.",
    {
      dialogId: z.string().describe("Dialog ID: 'chatNNN' for group/task chats, or user ID as string for 1-on-1"),
      limit: z.number().optional().describe("Max messages to return (default: 20)"),
      firstId: z.number().optional().describe("Message ID to start from (for pagination — pass the smallest ID from previous response to go further back in history)"),
    },
    async (args) => {
      try {
        const response = await client.call("im.dialog.messages.get", {
          DIALOG_ID: args.dialogId,
          LIMIT: args.limit ?? 20,
          ...(args.firstId ? { FIRST_ID: args.firstId } : {}),
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

  server.tool(
    "bitrix24_im_chat_search",
    "Search for IM chats by name/title. Useful for finding workgroup chats, project chats, or specific conversations.",
    {
      query: z.string().describe("Search query (chat name or partial match)"),
    },
    async (args) => {
      try {
        const response = await client.call("im.search.chat.list", {
          FIND: args.query,
        });
        const result = response.result as Array<Record<string, unknown>> | null;
        if (!result || result.length === 0) {
          return textResult("No chats found");
        }

        const formatted = result.map((chat) => ({
          chatId: chat.id,
          dialogId: `chat${chat.id}`,
          title: chat.name ?? chat.title,
          type: chat.type,
          memberCount: chat.member_count,
          lastMessageDate: chat.date_last_message,
        }));
        return textResult(formatted);
      } catch (e) { return errorResult(e); }
    },
  );
}
