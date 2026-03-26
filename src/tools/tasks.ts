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
      limit: z.number().optional().describe("Max tasks to return (default: all, paginated)"),
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
}
