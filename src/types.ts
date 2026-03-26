import { z } from "zod";

export const TASK_STATUS_MAP: Record<string, string> = {
  "2": "pending",
  "3": "in_progress",
  "4": "awaiting_control",
  "5": "completed",
  "6": "deferred",
  "-1": "overdue",
};

export const TASK_PRIORITY_MAP: Record<string, string> = {
  "0": "low",
  "1": "normal",
  "2": "high",
};

// helper to build MCP tool responses
export function textResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
  };
}

export function errorResult(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true as const };
}

// zod-compatible positive integer string (e.g. task IDs)
export const zId = z.string().regex(/^\d+$/, "Must be a numeric ID");
