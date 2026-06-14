import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BitrixClient } from "../bitrix-client.js";
import { textResult, errorResult } from "../types.js";

// Default ceiling on how many images bitrix24_im_chat_messages inlines per read,
// so a long chat with many attachments doesn't blow up the response.
const DEFAULT_MAX_INLINE_IMAGES = 20;
// Skip inlining (just note + offer the id) above this size to avoid huge base64 payloads.
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

// MCP content blocks the chat tools can emit.
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

// Fetch a chat/disk file's raw bytes via the REST disk.file.get -> DOWNLOAD_URL flow.
// The urlShow/urlDownload returned inside im.dialog.messages.get are session-signed
// (302 -> login for a webhook), so they can't be fetched headless; DOWNLOAD_URL carries
// the webhook token and serves the original bytes directly.
async function fetchDiskFile(
  client: BitrixClient,
  fileId: number | string,
): Promise<{ buffer: Buffer; mime: string; name: string } | null> {
  const resp = await client.call<Record<string, unknown>>("disk.file.get", { id: fileId });
  const res = resp.result;
  const url = res?.DOWNLOAD_URL;
  if (typeof url !== "string") return null;
  const dl = await fetch(url);
  if (!dl.ok) return null;
  const buffer = Buffer.from(await dl.arrayBuffer());
  const mime = (dl.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim();
  return { buffer, mime, name: String(res?.NAME ?? fileId) };
}

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
    "Read messages from a Bitrix24 IM chat. Use for reading task chats, group chats, or 1-on-1 dialogs. For task chats, the DIALOG_ID is 'chatNNN' where NNN is the task's chatId field. Messages with attachments carry a 'files' array (fileId, name, type, dimensions); image attachments are inlined as viewable images by default so you see what a human reading the chat sees. Non-image files and over-sized images are listed by metadata — fetch them with bitrix24_im_file_get.",
    {
      dialogId: z.string().describe("Dialog ID: 'chatNNN' for group/task chats, or user ID as string for 1-on-1"),
      limit: z.number().optional().describe("Max messages to return (default: 20)"),
      firstId: z.number().optional().describe("Message ID to start from (for pagination — pass the smallest ID from previous response to go further back in history)"),
      includeImages: z.boolean().optional().describe("Inline image attachments as viewable images (default: true). Set false for a text-only, lower-token read."),
      maxImages: z.number().optional().describe(`Cap on inlined images per read (default: ${DEFAULT_MAX_INLINE_IMAGES}).`),
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

        // im.dialog.messages.get returns a flat files[] array; a message links its
        // attachments via params.FILE_ID. Build a lookup so we can surface them.
        const files = (result.files as Array<Record<string, unknown>>) ?? [];
        const fileMap = new Map(files.map((f) => [String(f.id), f]));

        const messageFileIds = (m: Record<string, unknown>): string[] => {
          const p = (m.params as Record<string, unknown>) ?? {};
          const ids = p.FILE_ID;
          return Array.isArray(ids) ? ids.map(String) : [];
        };

        const formatted = messages.map((m) => {
          const attached = messageFileIds(m)
            .map((id) => fileMap.get(id))
            .filter((f): f is Record<string, unknown> => Boolean(f))
            .map((f) => ({
              fileId: f.id,
              name: f.name,
              type: f.type,
              ...(f.image ? { dimensions: f.image } : {}),
              size: f.size,
            }));
          return {
            id: m.id,
            author: userMap.get(String(m.author_id)) ?? m.author_id,
            date: m.date,
            text: typeof m.text === "string" ? m.text.replace(/<[^>]+>/g, "").replace(/\[(?!USER)[^\]]+\]/g, "").trim() : m.text,
            ...(attached.length ? { files: attached } : {}),
          };
        });

        const content: ContentBlock[] = [{ type: "text", text: JSON.stringify(formatted, null, 2) }];

        const includeImages = args.includeImages ?? true;
        const maxImages = args.maxImages ?? DEFAULT_MAX_INLINE_IMAGES;
        if (includeImages) {
          // Inline oldest-first, matching natural reading order.
          let count = 0;
          let capped = false;
          for (const m of [...messages].reverse()) {
            if (count >= maxImages) { capped = true; break; }
            for (const id of messageFileIds(m)) {
              const f = fileMap.get(id);
              if (!f || f.type !== "image") continue;
              if (count >= maxImages) { capped = true; break; }
              const fetched = await fetchDiskFile(client, id);
              if (!fetched || !fetched.mime.startsWith("image/")) continue;
              if (fetched.buffer.length > MAX_INLINE_IMAGE_BYTES) {
                content.push({ type: "text", text: `[image "${fetched.name}" on msg ${String(m.id)} is ${fetched.buffer.length} bytes — too large to inline; fetch with bitrix24_im_file_get fileId ${id}]` });
                continue;
              }
              content.push({ type: "text", text: `▼ image on msg ${String(m.id)} (${fetched.name}, ${String(m.date ?? "")}):` });
              content.push({ type: "image", data: fetched.buffer.toString("base64"), mimeType: fetched.mime });
              count++;
            }
          }
          if (capped) {
            content.push({ type: "text", text: `[inlined first ${maxImages} images; fetch the rest individually with bitrix24_im_file_get]` });
          }
        }

        return { content };
      } catch (e) { return errorResult(e); }
    },
  );

  server.tool(
    "bitrix24_im_message_send",
    "Send a NEW Bitrix24 IM message. Use this to message a person privately (1-on-1) or post into a group/task chat — it's the send counterpart to bitrix24_im_message_update (edit) and bitrix24_im_message_delete. The message is sent under the webhook owner's identity. For a PRIVATE 1-on-1 message pass the recipient's numeric user ID as dialogId (e.g. '8' for Aleksandr); for a group/task chat pass 'chatNNN'. Returns the new message ID (reuse it with update/delete). FORMATTING — plain text + BBCode only; Bitrix does NOT parse Markdown (**bold**, `backticks`, # headings render literally). Supported: [B]bold[/B], [I]italic[/I], [U]under[/U], [S]strike[/S], [URL=...]text[/URL], [USER=ID]Name[/USER] mentions. For bullet lists put a literal • at the line start — [*]/[LIST] do NOT render in chat (they show as literal «[*]»); no tag exists for inline code/filename, wrap in «…». When attaching a file to a chat (the disk im.disk.file.commit MESSAGE caption), keep the caption to ONE short line and post any long explanation as a SEPARATE following message — captions render in an oversized font, so a multi-paragraph caption becomes a wall of text. To post a comment onto a TASK specifically, prefer bitrix24_task_comment_add (it also shows in the task comment section).",
    {
      dialogId: z.string().describe("Recipient: numeric user ID as a string for a private 1-on-1 message (e.g. '6'), or 'chatNNN' for a group/task chat"),
      text: z.string().describe("Message text — plain text + BBCode only, NO Markdown. Bullet lines start with • (not [*]). See tool description for the full formatting contract + the file-caption rule."),
    },
    async (args) => {
      try {
        const response = await client.call("im.message.add", {
          DIALOG_ID: args.dialogId,
          MESSAGE: args.text,
        });
        return textResult({ messageId: response.result });
      } catch (e) { return errorResult(e); }
    },
  );

  server.tool(
    "bitrix24_im_message_delete",
    "Delete a message from a Bitrix24 IM chat (including task chats). Pass the numeric message ID as returned by bitrix24_im_chat_messages or bitrix24_task_comment_list. Only the message author or admins can delete.",
    {
      messageId: z.number().describe("Numeric ID of the message to delete"),
    },
    async (args) => {
      try {
        const response = await client.call("im.message.delete", {
          MESSAGE_ID: args.messageId,
        });
        return textResult(response.result === true ? "Deleted" : response.result);
      } catch (e) { return errorResult(e); }
    },
  );

  server.tool(
    "bitrix24_im_message_update",
    "Edit the text of a Bitrix24 IM chat message (including task chats). Pass the numeric message ID and the new text. Only the message author can edit. Same formatting rules as bitrix24_im_message_send: plain text + BBCode only (no Markdown), bullet lines start with a literal • (not [*]).",
    {
      messageId: z.number().describe("Numeric ID of the message to edit"),
      text: z.string().describe("New message text (BBCode supported, e.g. [USER=854]Name[/USER] for mentions)"),
    },
    async (args) => {
      try {
        const response = await client.call("im.message.update", {
          MESSAGE_ID: args.messageId,
          MESSAGE: args.text,
        });
        return textResult(response.result === true ? "Updated" : response.result);
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

  server.tool(
    "bitrix24_im_file_get",
    "Fetch a single file attached to a Bitrix24 chat message by its fileId (from bitrix24_im_chat_messages files[].fileId). Images are returned as viewable image content; other file types return metadata plus a webhook-authenticated download URL. Use this for attachments bitrix24_im_chat_messages didn't inline (non-images, or images past the inline size/count cap).",
    {
      fileId: z.number().describe("Numeric disk file ID from a chat message's files[] entry"),
    },
    async (args) => {
      try {
        const resp = await client.call<Record<string, unknown>>("disk.file.get", { id: args.fileId });
        const res = resp.result;
        const url = res?.DOWNLOAD_URL;
        if (typeof url !== "string") return textResult("File not found or no download URL available");
        const dl = await fetch(url);
        if (!dl.ok) return errorResult(new Error(`download failed: HTTP ${dl.status}`));
        const mime = (dl.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim();
        const buffer = Buffer.from(await dl.arrayBuffer());
        const name = String(res?.NAME ?? args.fileId);
        if (mime.startsWith("image/") && buffer.length <= MAX_INLINE_IMAGE_BYTES) {
          return {
            content: [
              { type: "text" as const, text: `${name} (${mime}, ${buffer.length} bytes)` },
              { type: "image" as const, data: buffer.toString("base64"), mimeType: mime },
            ],
          };
        }
        return textResult({ name, mime, size: buffer.length, downloadUrl: url });
      } catch (e) { return errorResult(e); }
    },
  );
}
