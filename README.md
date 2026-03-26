# Bitrix24 MCP Server

An MCP (Model Context Protocol) server that exposes Bitrix24 REST API to AI assistants. Provides 23 tools for managing tasks, CRM entities, users, and workgroups via Bitrix24's inbound webhook API.

## Tools

### Tasks (7)
- `bitrix24_task_list` — list and filter tasks by status, assignee, project, etc.
- `bitrix24_task_get` — get a single task with full details
- `bitrix24_task_create` — create a task with title, description, assignee, deadline, priority, tags
- `bitrix24_task_update` — update any task field
- `bitrix24_task_complete` — mark a task as completed
- `bitrix24_task_start` — set task status to "in progress"
- `bitrix24_task_defer` — defer a task

### Task Comments (2)
- `bitrix24_task_comment_list` — list comments on a task
- `bitrix24_task_comment_add` — add a comment (supports BBCode and @mentions)

### Task Checklists (3)
- `bitrix24_task_checklist_list` — list checklist items
- `bitrix24_task_checklist_add` — add a checklist item
- `bitrix24_task_checklist_complete` — mark a checklist item as done

### Kanban Stages (2)
- `bitrix24_task_stages_list` — list Kanban stages for a project
- `bitrix24_task_stage_move` — move a task to a different stage

### CRM (6)
- `bitrix24_crm_deal_list` / `bitrix24_crm_deal_get` — deals
- `bitrix24_crm_contact_list` / `bitrix24_crm_contact_get` — contacts
- `bitrix24_crm_lead_list` / `bitrix24_crm_lead_get` — leads

### Users & Workgroups (3)
- `bitrix24_user_get` — get user(s) by ID or filter
- `bitrix24_user_search` — search users by name
- `bitrix24_workgroup_list` — list workgroups and projects

## Prerequisites

- Node.js 20+
- A Bitrix24 portal with an **inbound webhook**

### Creating a Webhook

1. Go to your Bitrix24 portal → **Приложения** → **Разработчикам** → **Готовые сценарии** → **Другое** → **Входящий вебхук**
2. Select the required scopes:
   - `task`, `tasks_extended` — task management
   - `crm` — CRM read access
   - `user`, `user_basic` — user lookups
   - `sonet_group` — workgroups/projects
   - `bizproc` — business processes (optional)
   - `im` — chat/notifications (optional)
   - `calendar` — calendar (optional)
   - `telephony` — telephony (optional)
   - `department` — org structure (optional)
3. Click **Сохранить** and copy the webhook URL (format: `https://your-domain.bitrix24.ru/rest/USER_ID/SECRET/`)

## Setup

```bash
git clone <this-repo>
cd bitrix24-mcp-server
npm install
```

### Authentication

The server reads the webhook URL from (checked in order):

1. **`BITRIX24_WEBHOOK_URL`** environment variable — the full webhook URL
2. **`BITRIX24_WEBHOOK_OP_REF`** environment variable — a 1Password reference (e.g. `op://Vault/Item/field`), resolved via `op` CLI at startup

## Claude Code Integration

### Option A: Shell wrapper (recommended)

Create a `start.sh` script:

```bash
#!/bin/sh
export BITRIX24_WEBHOOK_URL="https://your-domain.bitrix24.ru/rest/USER_ID/SECRET/"
cd /path/to/bitrix24-mcp-server
exec npx tsx src/index.ts
```

```bash
chmod +x start.sh
```

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "bitrix24": {
      "command": "/path/to/bitrix24-mcp-server/start.sh",
      "args": []
    }
  }
}
```

### Option B: Direct command

```json
{
  "mcpServers": {
    "bitrix24": {
      "command": "npx",
      "args": ["tsx", "src/index.ts"],
      "cwd": "/path/to/bitrix24-mcp-server",
      "env": {
        "BITRIX24_WEBHOOK_URL": "https://your-domain.bitrix24.ru/rest/USER_ID/SECRET/"
      }
    }
  }
}
```

> **Note:** Option B depends on the MCP client correctly passing `env` and resolving `npx` from `PATH`. If it doesn't connect, use Option A.

### Verify

After restarting Claude Code, run `/mcp` to confirm the server is connected and all 23 tools are available.

## Development

```bash
npm run typecheck    # type-check without emitting
npm run build        # compile to dist/
npm run inspect      # open MCP Inspector UI
```

### Testing manually

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | \
  BITRIX24_WEBHOOK_URL="https://..." npx tsx src/index.ts
```

## Architecture

```
src/
  index.ts            # entry point, auth, stdio transport
  bitrix-client.ts    # REST client with rate limiting (2 req/s) and pagination
  types.ts            # helpers (textResult, errorResult, zId, status/priority maps)
  tools/
    index.ts          # registers all tool modules
    tasks.ts          # tasks.task.* CRUD
    task-comments.ts  # task.commentitem.*
    task-checklist.ts # task.checklistitem.*
    task-stages.ts    # task.stages.*
    crm-deals.ts      # crm.deal.*
    crm-contacts.ts   # crm.contact.*
    crm-leads.ts      # crm.lead.*
    users.ts          # user.*
    workgroups.ts     # sonet_group.*
```

### Bitrix24 API Notes

- **Rate limit:** 2 requests/second for webhooks (enforced by the client's request queue)
- **Pagination:** 50 items per page; `callList()` fetches all pages up to a configurable max
- **Tasks API** uses camelCase field names; **CRM API** uses UPPER_CASE
- **Batch API** (`batch()` method) executes up to 50 sub-requests in a single rate-limited call

## Extending

Add a new tool module:

1. Create `src/tools/my-entity.ts` exporting `registerMyEntityTools(server, client)`
2. Import and call it in `src/tools/index.ts`
3. Use `client.call()` for single requests, `client.callList()` for paginated lists
4. Wrap handlers in try/catch → `errorResult(e)`
5. Validate IDs with `zId` from `types.ts`

## Licence

MIT
