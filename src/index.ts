import { execSync } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BitrixClient } from "./bitrix-client.js";
import { KbClient } from "./kb-client.js";
import { registerAllTools } from "./tools/index.js";

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

const server = new McpServer({
  name: "bitrix24",
  version: "1.0.0",
});

registerAllTools(server, client, kbClient);

const transport = new StdioServerTransport();
await server.connect(transport);
