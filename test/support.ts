import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BitrixClient } from "../src/bitrix-client.js";

// A tool handler as registered through server.tool(name, description, schema, handler).
export type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}>;

// Capture the handlers a register*Tools function installs, keyed by tool name.
export function captureTools(register: (server: McpServer, client: BitrixClient) => void, client: BitrixClient) {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  } as unknown as McpServer;
  register(server, client);
  return (name: string): ToolHandler => {
    const h = tools.get(name);
    if (!h) throw new Error(`tool ${name} not registered`);
    return h;
  };
}

export const WEBHOOK = "https://portal.example/rest/1/token/";

export interface RecordedCall { method: string; params: Record<string, unknown> }

// Route fetch() by request: Bitrix REST methods go to `rest`, any other URL to `other`.
// `rest` returns [status, body] where body is JSON-encoded unless it is already a string.
export function stubFetch(
  rest: (method: string, params: Record<string, unknown>) => [number, unknown],
  other: (url: string) => Response = () => new Response("unexpected", { status: 599 }),
) {
  const calls: RecordedCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(WEBHOOK)) return other(url);
    const method = url.slice(WEBHOOK.length);
    const params = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ method, params });
    const [status, body] = rest(method, params);
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

export function newClient(): BitrixClient {
  return new BitrixClient(WEBHOOK);
}

export function textOf(r: Awaited<ReturnType<ToolHandler>>): string {
  return r.content.map((c) => c.text ?? "").join("\n");
}
