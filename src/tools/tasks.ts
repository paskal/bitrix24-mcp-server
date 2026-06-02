import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BitrixClient } from "../bitrix-client.js";
import { TASK_STATUS_MAP, TASK_PRIORITY_MAP, textResult, errorResult, zId } from "../types.js";

const DEFAULT_TASK_SELECT = [
  "ID", "TITLE", "STATUS", "PRIORITY", "RESPONSIBLE_ID",
  "CREATED_BY", "GROUP_ID", "STAGE_ID", "DEADLINE",
  "CREATED_DATE", "CHANGED_DATE", "TAGS", "DESCRIPTION",
  "ACCOMPLICES", "AUDITORS", "PARENT_ID",
];

function formatTask(t: Record<string, unknown>): Record<string, unknown> {
  return {
    ...t,
    statusLabel: TASK_STATUS_MAP[String(t.status ?? t.STATUS)] ?? t.status ?? t.STATUS,
    priorityLabel: TASK_PRIORITY_MAP[String(t.priority ?? t.PRIORITY)] ?? t.priority ?? t.PRIORITY,
  };
}

export function registerTaskTools(server: McpServer, client: BitrixClient): void {
  server.tool(
    "bitrix24_task_list",
    "List and filter Bitrix24 tasks. Filter by status, responsible user, workgroup, etc.",
    {
      filter: z.record(z.string(), z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))]))
        .optional()
        .describe("Bitrix24 filter, e.g. {RESPONSIBLE_ID: 854, '!REAL_STATUS': [5,6]}"),
      select: z.array(z.string()).optional().describe("Fields to return"),
      order: z.record(z.string(), z.string()).optional().describe("Sort order, e.g. {DEADLINE: 'asc'}"),
      limit: z.number().optional().describe("Max tasks to return. WITHOUT this the tool returns at most 1000 (20 pages x 50) and silently truncates — 'total' shows the true match count. For a query that matches more, pass limit >= total."),
    },
    async (args) => {
      try {
        const select = args.select ?? DEFAULT_TASK_SELECT;
        const maxPages = args.limit ? Math.ceil(args.limit / 50) : 20;
        const { items, total } = await client.callList(
          "tasks.task.list",
          { filter: args.filter ?? {}, select, order: args.order ?? { ID: "desc" } },
          maxPages,
        );
        const tasks = (args.limit ? items.slice(0, args.limit) : items).map((t) =>
          formatTask(t as Record<string, unknown>),
        );
        return textResult({ total, count: tasks.length, tasks });
      } catch (e) { return errorResult(e); }
    },
  );

  server.tool(
    "bitrix24_task_get",
    "Get a single Bitrix24 task by ID with full details",
    { taskId: zId.describe("Task ID") },
    async (args) => {
      try {
        const response = await client.call<{ task: Record<string, unknown> }>("tasks.task.get", {
          taskId: parseInt(args.taskId), select: ["*"],
        });
        return textResult(formatTask(response.result.task));
      } catch (e) { return errorResult(e); }
    },
  );

  server.tool(
    "bitrix24_task_create",
    "Create a new Bitrix24 task",
    {
      title: z.string().describe("Task title"),
      description: z.string().optional().describe("Task description (BBCode supported)"),
      responsibleId: z.number().describe("Assignee user ID"),
      groupId: z.number().optional().describe("Workgroup/project ID"),
      deadline: z.string().optional().describe("Deadline in ISO 8601 format"),
      priority: z.number().optional().describe("Priority: 0=low, 1=normal, 2=high"),
      accomplices: z.array(z.number()).optional().describe("Co-executor user IDs"),
      auditors: z.array(z.number()).optional().describe("Observer user IDs"),
      parentId: z.number().optional().describe("Parent task ID"),
      tags: z.array(z.string()).optional().describe("Task tags"),
      taskControl: z.boolean().optional().describe("Require creator acceptance on completion"),
    },
    async (args) => {
      try {
        const fields: Record<string, unknown> = { TITLE: args.title, RESPONSIBLE_ID: args.responsibleId };
        if (args.description !== undefined) fields.DESCRIPTION = args.description;
        if (args.groupId !== undefined) fields.GROUP_ID = args.groupId;
        if (args.deadline !== undefined) fields.DEADLINE = args.deadline;
        if (args.priority !== undefined) fields.PRIORITY = args.priority;
        if (args.accomplices !== undefined) fields.ACCOMPLICES = args.accomplices;
        if (args.auditors !== undefined) fields.AUDITORS = args.auditors;
        if (args.parentId !== undefined) fields.PARENT_ID = args.parentId;
        if (args.tags !== undefined) fields.TAGS = args.tags;
        if (args.taskControl !== undefined) fields.TASK_CONTROL = args.taskControl ? "Y" : "N";

        const response = await client.call<{ task: Record<string, unknown> }>("tasks.task.add", { fields });
        return textResult(response.result);
      } catch (e) { return errorResult(e); }
    },
  );

  server.tool(
    "bitrix24_task_update",
    "Update an existing Bitrix24 task",
    {
      taskId: zId.describe("Task ID to update"),
      fields: z.record(z.string(), z.unknown()).describe("Fields to update (TITLE, DESCRIPTION, DEADLINE, PRIORITY, RESPONSIBLE_ID, etc.)"),
    },
    async (args) => {
      try {
        await client.call("tasks.task.update", { taskId: parseInt(args.taskId), fields: args.fields });
        return textResult(`Task ${args.taskId} updated`);
      } catch (e) { return errorResult(e); }
    },
  );

  server.tool("bitrix24_task_complete", "Mark a Bitrix24 task as completed",
    { taskId: zId.describe("Task ID") },
    async (args) => {
      try {
        await client.call("tasks.task.complete", { taskId: parseInt(args.taskId) });
        return textResult(`Task ${args.taskId} completed`);
      } catch (e) { return errorResult(e); }
    },
  );

  server.tool("bitrix24_task_start", "Start working on a Bitrix24 task (set status to In Progress)",
    { taskId: zId.describe("Task ID") },
    async (args) => {
      try {
        await client.call("tasks.task.start", { taskId: parseInt(args.taskId) });
        return textResult(`Task ${args.taskId} started`);
      } catch (e) { return errorResult(e); }
    },
  );

  server.tool("bitrix24_task_defer", "Defer a Bitrix24 task",
    { taskId: zId.describe("Task ID") },
    async (args) => {
      try {
        await client.call("tasks.task.defer", { taskId: parseInt(args.taskId) });
        return textResult(`Task ${args.taskId} deferred`);
      } catch (e) { return errorResult(e); }
    },
  );

  server.tool(
    "bitrix24_task_attach_file",
    "Attach a local file (docx, pdf, image, anything) to a Bitrix24 task. Use this for delivering briefs, reports, signed-off specs — anything that should land as a downloadable attachment in the task's Files tab. The file shows as «<user> добавил файл» in chat but WITHOUT an image thumbnail/preview even for PNG/JPG (chat just shows filename). For screenshots / images you want INLINE-PREVIEWED in chat, use `bitrix24_task_post_image` instead — that posts a proper chat message with IMAGE attachment blocks that render as thumbnails. Stays linked to UF_TASK_WEBDAV_FILES. SAFE: existing attachments are preserved (read-merge-write); your file is appended, not replaced. Two-step under the hood: disk.folder.uploadfile → multipart POST → tasks.task.update with the merged UF_TASK_WEBDAV_FILES list (each id encoded as 'n<diskFileId>').",
    {
      taskId: zId.describe("Task ID"),
      filePath: z.string().describe("Absolute local path to the file to upload (e.g. /tmp/brief.docx)"),
      folderId: z.number().optional().describe("Disk folder ID to upload to. Default 732896 (shared 'Блог' folder, verified writable for user 854). Override only if you need the file in a specific workgroup folder."),
      fileName: z.string().optional().describe("Override the file name visible in B24. Defaults to basename(filePath)."),
    },
    async (args) => {
      try {
        const folderId = args.folderId ?? 732896;
        // step 1+2: upload to disk
        const uploaded = await client.uploadFileToFolder(folderId, args.filePath, args.fileName);
        // step 3a: read existing UF_TASK_WEBDAV_FILES (replace-semantics — must merge, not clobber)
        const taskResp = await client.call<{ task: Record<string, unknown> }>("tasks.task.get", {
          taskId: parseInt(args.taskId), select: ["ID", "UF_TASK_WEBDAV_FILES"],
        });
        const existingRaw = taskResp.result?.task?.ufTaskWebdavFiles;
        const existing: string[] = Array.isArray(existingRaw)
          ? existingRaw.map((v) => String(v))
          : [];
        // step 3b: append new id (in disk-id form 'n<id>') and write back
        const merged = [...existing, `n${uploaded.diskFileId}`];
        await client.call("tasks.task.update", {
          taskId: parseInt(args.taskId),
          fields: { UF_TASK_WEBDAV_FILES: merged },
        });
        return textResult({
          ok: true,
          taskId: args.taskId,
          diskFileId: uploaded.diskFileId,
          name: uploaded.name,
          size: uploaded.size,
          attachedCount: merged.length,
          previousAttachmentCount: existing.length,
        });
      } catch (e) { return errorResult(e); }
    },
  );

  server.tool(
    "bitrix24_task_post_image",
    "Post chat message(s) to a Bitrix24 task with images that render INLINE as thumbnails (not just filename links). Use this for screenshots, design mockups, photo evidence — anything where the reader should see the image without clicking through. Each local file path is uploaded to disk, then a SEPARATE chat message is posted per image (Bitrix renders multi-image single-messages with broken second-image placeholders — verified 2026-05-19). The same `message` caption is reused on each image's message; if you want per-image captions, call this tool once per image with a distinct message. Returns array of IM message IDs (one per image). Files are saved to B24 disk (folder 732896 by default) so they're permanently accessible, but NOT added to UF_TASK_WEBDAV_FILES — for that, use `bitrix24_task_attach_file` separately.",
    {
      taskId: zId.describe("Task ID to post into"),
      message: z.string().describe("Caption posted above each image. Same text on every message. Supports BBCode ([B]…[/B], [URL=…]…[/URL], [USER=ID]Name[/USER]). For distinct per-image captions, call this tool multiple times with single-element filePaths arrays."),
      filePaths: z.array(z.string()).min(1).describe("Array of absolute local paths to image files (PNG / JPG / WebP). One message posted per file."),
      folderId: z.number().optional().describe("Disk folder ID for upload. Default 732896 (shared 'Блог' folder, verified writable for user 854)."),
    },
    async (args) => {
      try {
        const folderId = args.folderId ?? 732896;
        // step 1: fetch task to get its chat ID
        const taskResp = await client.call<{ task: Record<string, unknown> }>("tasks.task.get", {
          taskId: parseInt(args.taskId), select: ["ID", "CHAT_ID"],
        });
        const chatIdRaw = (taskResp.result?.task as Record<string, unknown>)?.chatId
          ?? (taskResp.result?.task as Record<string, unknown>)?.CHAT_ID;
        const chatId = Number(chatIdRaw);
        if (!chatId) throw new Error(`Task ${args.taskId} has no associated chat ID (got ${JSON.stringify(chatIdRaw)})`);
        // step 2 + 3: for each file, upload then post a single-image message (multi-attach renders broken)
        const posted: Array<{ messageId: number; diskFileId: number; name: string }> = [];
        for (const filePath of args.filePaths) {
          const u = await client.uploadFileToFolder(folderId, filePath);
          const { messageId } = await client.postChatMessageWithImage(chatId, args.message, {
            diskFileId: u.diskFileId, name: u.name,
          });
          posted.push({ messageId, diskFileId: u.diskFileId, name: u.name });
        }
        return textResult({
          ok: true,
          taskId: args.taskId,
          chatId,
          imageCount: posted.length,
          messages: posted,
        });
      } catch (e) { return errorResult(e); }
    },
  );
}
