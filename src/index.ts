import { execSync } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BitrixClient } from "./bitrix-client.js";
import { KbClient } from "./kb-client.js";
import { registerAllTools } from "./tools/index.js";
import { CHANNEL_INSTRUCTIONS, ChatWatcher, registerChatWatchTools, webhookOwnerId } from "./chat-watch.js";

function readFromOpRef(ref: string): string | null {
  try {
    const v = execSync(`op read "${ref}"`, {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return v || null;
  } catch {
    return null;
  }
}

function getWebhookUrl(): string {
  if (process.env.BITRIX24_WEBHOOK_URL) return process.env.BITRIX24_WEBHOOK_URL;
  const opRef = process.env.BITRIX24_WEBHOOK_OP_REF;
  if (opRef) {
    const url = readFromOpRef(opRef);
    if (url) return url;
  }
  console.error("Error: set BITRIX24_WEBHOOK_URL or BITRIX24_WEBHOOK_OP_REF");
  console.error("  BITRIX24_WEBHOOK_URL=https://your-domain.bitrix24.ru/rest/USER_ID/SECRET/");
  console.error("  BITRIX24_WEBHOOK_OP_REF=op://Vault/Item/field  (requires `op` CLI)");
  process.exit(1);
}

function getKbToken(): string | null {
  if (process.env.KB_API_TOKEN) return process.env.KB_API_TOKEN;
  const opRef = process.env.KB_API_TOKEN_OP_REF;
  if (opRef) return readFromOpRef(opRef);
  return null;
}

const webhookUrl = getWebhookUrl();
const client = new BitrixClient(webhookUrl);

const kbToken = getKbToken();
const kbClient = kbToken ? new KbClient(kbToken) : undefined;
if (!kbClient) {
  console.error("KB tools disabled: set KB_API_TOKEN or KB_API_TOKEN_OP_REF to enable (IT-Solution «База знаний» API)");
}

// claude/channel lets the server push new chat messages into a Claude Code session
const server = new McpServer(
  { name: "bitrix24", version: "1.0.0" },
  { capabilities: { experimental: { "claude/channel": {} } }, instructions: CHANNEL_INSTRUCTIONS },
);

registerAllTools(server, client, kbClient);

const watcher = new ChatWatcher(
  client,
  async (content, meta) => {
    await server.server.notification({ method: "notifications/claude/channel", params: { content, meta } });
  },
  webhookOwnerId(webhookUrl),
  // 5s to 1h apart; an unset or malformed value falls back to 30s
  Math.min(3600, Math.max(5, Number(process.env.B24_WATCH_INTERVAL_SEC) || 30)) * 1000,
);
registerChatWatchTools(server, watcher);

const transport = new StdioServerTransport();
await server.connect(transport);

for (const dialogId of (process.env.B24_WATCH_DIALOGS ?? "").split(",").map((d) => d.trim()).filter(Boolean)) {
  await watcher.subscribe(dialogId).catch((e: unknown) => {
    console.error(`chat watch: cannot subscribe to ${dialogId}: ${e instanceof Error ? e.message : String(e)}`);
  });
}
