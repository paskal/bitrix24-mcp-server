import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KbClient } from "../kb-client.js";
import { textResult, errorResult, zId } from "../types.js";

// IT-Solution "База знаний и тестирование" marketplace app — article and directory access.
// Docs: https://it-solution.kdb24.ru/public/kdb24/d162293/

export function registerKbTools(server: McpServer, client: KbClient): void {
  server.tool(
    "kb_article_get",
    "Get a single knowledge base article by ID. Returns rendered HTML body, title, directory, access lists, and metadata. Article ID is the number in the URL: `<portal>.kdb24.ru/article/<id>/`.",
    { articleId: zId.describe("KB article ID") },
    async (args) => {
      try {
        const data = await client.call("article.get", { id: parseInt(args.articleId) });
        return textResult(data);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.tool(
    "kb_directory_structure",
    "Get the tree structure of a KB directory: nested sub-directories and their articles (titles, IDs, timestamps — no bodies). Use this to discover article IDs before fetching content with kb_article_get.",
    { directoryId: zId.describe("KB directory ID") },
    async (args) => {
      try {
        const data = await client.call("directory.structure", { id: parseInt(args.directoryId) });
        return textResult(data);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.tool(
    "kb_article_save",
    "Create or update a KB article. Omit `id` to create new (then `directoryId` is required). Pass `id` to update. Body is HTML (Froala editor format). Changes are live.",
    {
      id: z.number().optional().describe("Article ID (omit to create)"),
      directoryId: z.number().optional().describe("Target directory ID (required when creating)"),
      title: z.string().optional().describe("Article title"),
      body: z.string().optional().describe("Article body as HTML"),
      public: z.boolean().optional().describe("Publish publicly"),
    },
    async (args) => {
      try {
        const params: Record<string, string | number | boolean> = {};
        if (args.id !== undefined) params.id = args.id;
        if (args.directoryId !== undefined) params.directory_id = args.directoryId;
        if (args.title !== undefined) params.title = args.title;
        if (args.body !== undefined) params.rendered_body = args.body;
        if (args.public !== undefined) params.public = args.public;
        const data = await client.call("article.save", params);
        return textResult(data);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.tool(
    "kb_gpt_ask",
    "Ask the KB's built-in GPT assistant a question. Searches the knowledge base and returns an answer grounded in article content.",
    { question: z.string().describe("Question in natural language") },
    async (args) => {
      try {
        const data = await client.call("gpt.ask", { question: args.question });
        return textResult(data);
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}
