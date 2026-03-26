import { execSync } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BitrixClient } from "./bitrix-client.js";
import { registerAllTools } from "./tools/index.js";

function getWebhookUrl(): string {
  // 1. Environment variable (highest priority)
  if (process.env.BITRIX24_WEBHOOK_URL) {
    return process.env.BITRIX24_WEBHOOK_URL;
  }

  // 2. Try 1Password CLI (op://vault/item/field)
  const opRef = process.env.BITRIX24_WEBHOOK_OP_REF;
  if (opRef) {
    try {
      const url = execSync(`op read "${opRef}"`, {
        encoding: "utf-8",
        timeout: 10000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      if (url) return url;
    } catch {
      // 1Password not available or timed out
    }
  }

  console.error("Error: set BITRIX24_WEBHOOK_URL or BITRIX24_WEBHOOK_OP_REF");
  console.error("  BITRIX24_WEBHOOK_URL=https://your-domain.bitrix24.ru/rest/USER_ID/SECRET/");
  console.error("  BITRIX24_WEBHOOK_OP_REF=op://Vault/Item/field  (requires `op` CLI)");
  process.exit(1);
}

const webhookUrl = getWebhookUrl();
const client = new BitrixClient(webhookUrl);

const server = new McpServer({
  name: "bitrix24",
  version: "1.0.0",
});

registerAllTools(server, client);

const transport = new StdioServerTransport();
await server.connect(transport);
