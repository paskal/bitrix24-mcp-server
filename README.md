# Bitrix24 MCP Server

An MCP (Model Context Protocol) server that exposes Bitrix24 REST API to AI assistants. Provides 32 tools for managing tasks, CRM entities, call recordings (incl. local transcription), users, workgroups, and Knowledge Base articles via Bitrix24's inbound webhook API.

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

### CRM (9)
- `bitrix24_crm_deal_list` / `bitrix24_crm_deal_get` — deals
- `bitrix24_crm_contact_list` / `bitrix24_crm_contact_get` — contacts
- `bitrix24_crm_lead_list` / `bitrix24_crm_lead_get` — leads
- `bitrix24_crm_activity_list` — timeline activities (calls/emails/SMS) on a lead/deal; call log with direction, duration, recording files
- `bitrix24_voximplant_statistic_get` — telephony call stats (duration, in/out, recording file id, transcript status)
- `bitrix24_crm_timeline_comment_list` — manual timeline comments (manager notes)

> Note: Bitrix's own call **transcripts** and **BitrixGPT call scoring** are UI-only CoPilot features — not exposed by any Bitrix24 REST method (verified against all ~1170 webhook methods), so no tool can read or trigger them. Instead we download the recording and transcribe it ourselves — see below.

### Call transcription (2)
- `bitrix24_call_transcribe` — transcribe a call recording **locally and fully offline** (audio never leaves the machine), optionally storing the transcript as the note **on the call itself**. Substitutes for Bitrix's UI-only transcription. Requires a local ASR env (see [Call transcription setup](#call-transcription-local--private)). Returns **raw, unlabelled** `{text, segments}` (Whisper segments by pause, not by speaker). Speaker labelling is intentionally **not** in the server — the calling model decides whether to add «who-said-what» labels (it already has the call's manager and client names from the activity/lead) and saves the result via `bitrix24_crm_timeline_note_save`.
- `bitrix24_crm_timeline_note_save` — save the «заметка» note attached to a specific timeline item (e.g. a call), via `crm.timeline.note.save`. The note appears at the item, not as a loose lead comment. *(writer — hidden in `READONLY_MODE`)*

### Users & Workgroups (3)
- `bitrix24_user_get` — get user(s) by ID or filter
- `bitrix24_user_search` — search users by name
- `bitrix24_workgroup_list` — list workgroups and projects

### Knowledge Base (4, optional)
Requires the third-party marketplace app [«База знаний и тестирование» by IT-Solution](https://it-solution.ru/b24apps/prilozhenie_bitrix24_baza_znanii/) installed on your portal. Bitrix24's native REST API does not expose knowledge base content — this app fills the gap with its own REST API.

- `kb_article_get` — fetch a KB article by ID (rendered HTML body, title, access lists, metadata)
- `kb_directory_structure` — list a directory's nested sub-directories and articles (IDs and titles, no bodies)
- `kb_article_save` — create or update an article (HTML body)
- `kb_gpt_ask` — query the KB's built-in GPT assistant

KB tools are registered only when `KB_API_TOKEN` (or `KB_API_TOKEN_OP_REF`) is set; otherwise they're silently skipped.

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

### Knowledge Base token (optional)

To enable the `kb_*` tools, install [«База знаний и тестирование»](https://it-solution.ru/b24apps/prilozhenie_bitrix24_baza_znanii/) on your portal, obtain an integration token in the app's settings, and set one of:

1. **`KB_API_TOKEN`** — the raw token string
2. **`KB_API_TOKEN_OP_REF`** — a 1Password reference, same format as above

If neither is set, KB tools are silently omitted and the rest of the server runs normally.

### Call transcription (local & private)

`bitrix24_call_transcribe` decodes call recordings **on the machine running this MCP** — the audio is never sent to any cloud service. It shells out to a bundled Python script (`scripts/transcribe.py`) that runs an ONNX speech-to-text model via `ffmpeg`.

Why local: call recordings are customers' voices (personal data); keeping transcription offline avoids shipping PII to a third-party API and keeps it free.

One-off setup:

```bash
# ffmpeg must be on PATH
brew install ffmpeg            # or your platform's package manager

# a Python venv with the ASR runtime
python3 -m venv ~/.venvs/b24-asr
~/.venvs/b24-asr/bin/pip install onnx-asr onnxruntime
```

The default model is **NVIDIA Parakeet TDT 0.6b v3 (int8)** — multilingual incl. Russian, fast (~real-time/17 on CPU). It reuses the model bundled by [Handy](https://github.com/cjpais/Handy) if installed; otherwise point `PARAKEET_MODEL_DIR` at your own copy. For higher Russian accuracy on noisy phone audio, swap the script for Whisper `large-v3` (slower) or GigaAM v2.

Environment variables (all optional):

| Var | Default | Purpose |
|---|---|---|
| `B24_TRANSCRIBE_PYTHON` | `python3` | Python interpreter with `onnx-asr` installed — set to `~/.venvs/b24-asr/bin/python` |
| `B24_TRANSCRIBE_SCRIPT` | bundled `scripts/transcribe.py` | Override to use a different transcription script |
| `PARAKEET_MODEL_DIR` | Handy's bundled v3-int8 model | ASR model directory |
| `ASR_CHUNK_SECONDS` | `30` | Segment length (the TDT ONNX export can't stream long audio) |

If the venv/model isn't set up, `bitrix24_call_transcribe` returns a clear error and the rest of the server is unaffected.

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

After restarting Claude Code, run `/mcp` to confirm the server is connected. You should see 23 tools, or 27 if the Knowledge Base token is configured.

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
  kb-client.ts        # IT-Solution KB API client (optional, activated by token)
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
    im-chat.ts        # im.chat.*
    kb-articles.ts    # IT-Solution KB: article.*, directory.*, gpt.ask
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
