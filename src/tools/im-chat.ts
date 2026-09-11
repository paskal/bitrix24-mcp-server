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
// Reactions live inside message.params keyed by reaction type, each value an array
// of user ids: params: { LIKE: [8], FILE_ID: [...] }. Bitrix IM ships these seven
// types (bitrix/modules/im/lib/v2/message/reaction). A reaction is often the whole
// reply — a 👍 on «дозаполнив?» is a "yes" — so a chat read that drops them misreads
// the conversation (caught 2026-08-28).
export const REACTION_TYPES = ["LIKE", "KISS", "LAUGH", "ANGRY", "CRY", "FACEPALM", "WONDER"] as const;

export function extractReactions(
  params: Record<string, unknown> | null | undefined,
  resolveUser: (id: string) => unknown,
): Record<string, unknown[]> | undefined {
  if (!params) return undefined;
  const out: Record<string, unknown[]> = {};
  for (const type of REACTION_TYPES) {
    const ids = params[type];
    if (Array.isArray(ids) && ids.length) {
      out[type] = ids.map((id) => resolveUser(String(id)) ?? id);
    }
  }
  return Object.keys(out).length ? out : undefined;
}

// Resolve a chat/disk file via disk.file.get -> DOWNLOAD_URL and fetch it. The body is read
// only for an image within maxBytes; anything else is described from the response headers and
// the disk metadata and the transfer is cancelled unread, so a PDF or an oversized photo costs
// one round-trip instead of a full download. Throws on an HTTP failure of the download itself.
//
// The urlShow/urlDownload returned inside im.dialog.messages.get are session-signed
// (302 -> login for a webhook), so they can't be fetched headless; DOWNLOAD_URL carries
// the webhook token and serves the original bytes directly.
interface DiskFile { name: string; mime: string; size: number; downloadUrl: string; buffer?: Buffer }

async function fetchDiskFile(
  client: BitrixClient,
  fileId: number | string,
  maxBytes = MAX_INLINE_IMAGE_BYTES,
): Promise<DiskFile | null> {
  const resp = await client.call<Record<string, unknown>>("disk.file.get", { id: fileId });
  const res = resp.result;
  const url = res?.DOWNLOAD_URL;
  if (typeof url !== "string") return null;
  const dl = await fetch(url);
  if (!dl.ok) {
    await dl.body?.cancel();
    throw new Error(`download failed: HTTP ${dl.status}`);
  }
  const mime = (dl.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim();
  const file: DiskFile = {
    name: String(res?.NAME ?? fileId),
    mime,
    size: Number(res?.SIZE ?? dl.headers.get("content-length") ?? 0),
    downloadUrl: url,
  };
  if (!mime.startsWith("image/") || file.size > maxBytes) {
    await dl.body?.cancel();
    return file;
  }
  const buffer = Buffer.from(await dl.arrayBuffer());
  // the metadata can understate the size; the real byte count decides
  return buffer.length > maxBytes ? { ...file, size: buffer.length } : { ...file, size: buffer.length, buffer };
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
    "Read messages from a Bitrix24 IM chat. Use for reading task chats, group chats, or 1-on-1 dialogs. For task chats, the DIALOG_ID is 'chatNNN' where NNN is the task's chatId field. Messages carry a 'reactions' object when anyone reacted ({LIKE: ['Александр Верхотуров'], …}; types LIKE/KISS/LAUGH/ANGRY/CRY/FACEPALM/WONDER) — treat a reaction as a reply: a 👍 on a question is a 'yes', an unanswered message with a reaction is not unanswered. Messages with attachments carry a 'files' array (fileId, name, type, dimensions); image attachments are inlined as viewable images by default so you see what a human reading the chat sees. Non-image files and over-sized images are listed by metadata — fetch them with bitrix24_im_file_get. ⚠️ TEXT FIELDS: 'text' is the display-rendered form with BBCode/HTML stripped — it is LOSSY. A message containing [URL=https://…]#146426[/URL] comes back as bare '#146426', and [USER=…] mentions and [B]bold[/B] are flattened the same way. When the original markup exists, the message also carries 'textRaw' with it intact. NEVER rebuild a message for bitrix24_im_message_update from 'text' — you will silently destroy every link, mention and format in it (caught 2026-07-24: an edited ads report lost all 8 CRM deep links). Edit from 'textRaw', or re-author the BBCode explicitly.",
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
          // `text` is display-rendered (BBCode/HTML stripped) and is LOSSY — never feed it back
          // into bitrix24_im_message_update, or links/mentions/bold are silently destroyed.
          // `textRaw` preserves the original markup so an edit can round-trip losslessly.
          const reactions = extractReactions(
            m.params as Record<string, unknown> | undefined,
            (id) => userMap.get(id),
          );
          const rawText = typeof m.text === "string" ? m.text : undefined;
          const displayText =
            rawText !== undefined
              ? rawText.replace(/<[^>]+>/g, "").replace(/\[(?!USER)[^\]]+\]/g, "").trim()
              : m.text;
          return {
            id: m.id,
            author: userMap.get(String(m.author_id)) ?? m.author_id,
            date: m.date,
            text: displayText,
            ...(rawText !== undefined && rawText !== displayText ? { textRaw: rawText } : {}),
            ...(attached.length ? { files: attached } : {}),
            ...(reactions ? { reactions } : {}),
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
              // the listing already carries the size: skip the round-trips for a known oversized image
              if (Number(f.size ?? 0) > MAX_INLINE_IMAGE_BYTES) {
                content.push({ type: "text", text: `[image "${String(f.name)}" on msg ${String(m.id)} is ${String(f.size)} bytes — too large to inline; fetch with bitrix24_im_file_get fileId ${id}]` });
                continue;
              }
              // a failed download skips this one file; the rest of the chat still renders
              const fetched = await fetchDiskFile(client, id).catch(() => null);
              if (!fetched || !fetched.mime.startsWith("image/")) continue;
              if (!fetched.buffer) {
                content.push({ type: "text", text: `[image "${fetched.name}" on msg ${String(m.id)} is ${fetched.size} bytes — too large to inline; fetch with bitrix24_im_file_get fileId ${id}]` });
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
    "Send a NEW Bitrix24 IM message. Use this to message a person privately (1-on-1) or post into a group/task chat — it's the send counterpart to bitrix24_im_message_update (edit) and bitrix24_im_message_delete. The message is sent under the webhook owner's identity. For a PRIVATE 1-on-1 message pass the recipient's numeric user ID as dialogId (e.g. '8' for Aleksandr); for a group/task chat pass 'chatNNN'. Returns the new message ID (reuse it with update/delete). FORMATTING — plain text + BBCode only; Bitrix does NOT parse Markdown (**bold**, `backticks`, # headings render literally). Supported: [B]bold[/B], [I]italic[/I], [U]under[/U], [S]strike[/S], [URL=...]text[/URL], [USER=ID]Name[/USER] mentions. For bullet lists put a literal • at the line start — [*]/[LIST] do NOT render in chat (they show as literal «[*]»); no tag exists for inline code/filename, wrap in «…». When attaching a file to a chat (the disk im.disk.file.commit MESSAGE caption), keep the caption to ONE short line and post any long explanation as a SEPARATE following message — captions render in an oversized font, so a multi-paragraph caption becomes a wall of text. To post a comment onto a TASK specifically, prefer bitrix24_task_comment_add (it also shows in the task comment section). DISCLOSURE — the message text MUST end with a final line, on its own, reading exactly «(написано агентом)»: it posts under the human owner's account but is agent-written, and this line discloses that to the reader (owner rule, favor-group).",
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
    "Edit the text of a Bitrix24 IM chat message (including task chats). Pass the numeric message ID and the new text. Only the message author can edit. Same formatting rules as bitrix24_im_message_send: plain text + BBCode only (no Markdown), bullet lines start with a literal • (not [*]). Keep the «(написано агентом)» disclosure line as the final line of the edited text (owner rule, favor-group). ⚠️ The text you pass REPLACES the message wholesale — there is no merge. If you are editing an existing message, build the new text from that message's 'textRaw' (bitrix24_im_chat_messages), NOT from its 'text', which has BBCode stripped: round-tripping 'text' silently deletes every [URL=…] deep link, [USER=…] mention and [B]bold[/B]. Re-emit CRM references in full BBCode, e.g. [URL=https://fs-group.bitrix24.ru/crm/lead/details/NNNNN/]#NNNNN[/URL].",
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
        const file = await fetchDiskFile(client, args.fileId);
        if (!file) return textResult("File not found or no download URL available");
        const { name, mime, size, downloadUrl, buffer } = file;
        if (buffer) {
          return {
            content: [
              { type: "text" as const, text: `${name} (${mime}, ${size} bytes)` },
              { type: "image" as const, data: buffer.toString("base64"), mimeType: mime },
            ],
          };
        }
        return textResult({ name, mime, size, downloadUrl });
      } catch (e) { return errorResult(e); }
    },
  );

  server.tool(
    "bitrix24_im_post_file",
    "Post local file(s) of ANY type into a Bitrix24 chat — .txt/.docx/.pdf/.zip/images alike — in a group/workgroup/project chat, a task chat, or a 1-on-1. This is the attachment counterpart to bitrix24_im_message_send (which is text-only) and the chat equivalent of bitrix24_task_attach_file / bitrix24_task_post_image (which only post into a TASK). IMAGES additionally render INLINE as a preview thumbnail; every other type posts as a normal downloadable file message with the caption — so use this whenever a file has to reach a chat, not just for pictures. Under the hood it uploads each file into the CHAT'S OWN disk folder and commits it (im.disk.folder.get → disk.folder.uploadfile → im.disk.file.commit) — the native-client flow, so every chat member can see it regardless of shared-folder permissions. One SEPARATE message is posted per file (Bitrix renders multiple images stacked in a single message with broken placeholders), and the same `message` caption is reused on each; for distinct captions call once per file. CAPTION RULE — the file-commit caption renders in an OVERSIZED font, so keep it to ONE short line and post any long explanation as a separate bitrix24_im_message_send message. Returns an array of the created message IDs. Same disclosure convention as bitrix24_im_message_send applies to any accompanying text message. ALWAYS prefer this over hand-rolling the upload with curl: it uses a proper multipart encoder, so filenames containing commas, spaces or Cyrillic are handled correctly, whereas `curl -F 'file=@x;filename=a, b.txt'` treats the comma as a multi-file separator and dies with «curl: (26) Failed to open/read local data» (caught 2026-07-24).",
    {
      dialogId: z.string().describe("Target chat: 'chatNNN' for a group/task chat, or a numeric user ID for a 1-on-1"),
      filePaths: z.array(z.string()).min(1).describe("Absolute local path(s) to the file(s) — any type. One message is posted per file."),
      message: z.string().optional().describe("Short one-line caption, reused on each file's message (see the caption rule). Optional — omit for no caption."),
    },
    async (args) => {
      try {
        const results: Array<{ file: string; messageId: number; diskFileId: number }> = [];
        for (const filePath of args.filePaths) {
          const r = await client.postChatFile(args.dialogId, filePath, args.message ?? "");
          results.push({ file: filePath, messageId: r.messageId, diskFileId: r.diskFileId });
        }
        return textResult({ posted: results.length, messages: results });
      } catch (e) { return errorResult(e); }
    },
  );
}
