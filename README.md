# Bitrix24 MCP Server

An MCP (Model Context Protocol) server that exposes Bitrix24 REST API to AI assistants. Provides 35 tools for managing tasks, CRM entities, call recordings (incl. local transcription), users, workgroups, and Knowledge Base articles via Bitrix24's inbound webhook API.

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

### Call transcription (5)
Transcription and note-saving are **separate** — transcribe never writes to Bitrix, so you can get a transcript (and label it) without committing anything. **Three quality/speed tiers**, all decoding the audio **locally** (it never leaves the machine):

| Tier | Tool | Models | Speed | Output |
|---|---|---|---|---|
| **fast** | `bitrix24_call_transcribe_fast` | GigaAM v2 only | ~5× real-time, fastest | raw lowercase, no punctuation, no speaker labels |
| **default** | `bitrix24_call_transcribe` | Whisper large-v3 | slower | punctuated, readable, raw segments (no speaker labels) |
| **max** | `bitrix24_call_transcribe_max` | GigaAM + Whisper + pyannote | slowest (3 models) | both transcripts + speaker-tagged turns to reconcile |

Pick by need: **fast** for the quick gist (cheap, never hallucinates, but rough), **default** for a readable single transcript, **max** for the best possible (dual transcript + diarization the caller reconciles).

- `bitrix24_call_transcribe_fast` — **fast tier.** Single model, **GigaAM v2** (Russian-native RNNT): ~5× real-time on CPU, never hallucinates, gets domain terms right. Raw lowercase / minimal punctuation / no speaker labels. Returns `{text, engine, responsibleId, direction}`. Brand names auto-normalised (вилюкс → Velux). **Requires** a light Python env (gigaam + soundfile + torch) at `B24_FAST_PYTHON`; if missing → `error_type: missing_deps`.
- `bitrix24_call_transcribe` — **default tier.** Transcribe a call recording **locally and fully offline**. Whisper large-v3, auto-bootstrapping venv, no token. Substitutes for Bitrix's UI-only transcription. Returns **raw, unlabelled** `{text, segments, responsibleId, direction}`. Speaker labelling is the calling model's call (it gets the manager via `responsibleId` and the client's name from the lead).
- `bitrix24_call_transcribe_max` — **max tier.** The highest-quality pipeline: **GigaAM v2** (RU-native, never hallucinates) + **Whisper large-v3** (`condition_on_previous_text=False` + domain hotwords, for punctuation/proper-nouns) + **pyannote diarization** (speaker turns). Returns **both transcripts + speaker-tagged segments** (`{whisper_text, gigaam_text, segments, speakers, reconcile_hint}`) for the calling model to reconcile into one clean transcript. Brand names auto-normalised (V-LUX / вилюкс → Velux). **Requires** a heavy Python env at `B24_MAX_PYTHON` (faster-whisper + gigaam + pyannote.audio + torch) and an HF token (`HF_TOKEN`/`B24_HF_TOKEN`) whose account accepted the pyannote gated models. Missing any of that → a clear `error_type` (`missing_hf_token` / `missing_deps` / `model_not_approved`) telling you exactly what to fix. See [Call transcription setup](#call-transcription-local--private).
- `bitrix24_crm_timeline_note_get` — read the «заметка» on a timeline item (returns text or null). Check before saving.
- `bitrix24_crm_timeline_note_save` — save the note on a timeline item (e.g. a call), so it appears at the item, not as a loose lead comment. **Anti-clobber safeguard:** default `mode='create'` will **not** overwrite an existing note — it writes your text to a local draft file and returns the existing note + a recommendation, so the caller decides. Re-call with `mode='replace'` (overwrite) or `mode='append'` (keep both). *(writer — hidden in `READONLY_MODE`)*

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

All three transcription tiers decode call recordings **on the machine running this MCP** — the audio is never sent to any cloud service. Call recordings are customers' voices (personal data); keeping transcription offline avoids shipping PII to a third-party API and keeps it free.

#### Default tier — zero setup

`bitrix24_call_transcribe` works out of the box. On first use the server bootstraps a managed Python venv at `~/.cache/bitrix24-mcp/whisper-venv`, installs [faster-whisper](https://github.com/SYSTRAN/faster-whisper) into it, and downloads the Whisper `large-v3` model (~3 GB) — so the first call is slow, and subsequent calls are served by a persistent worker pool that keeps the model loaded. The only prerequisite is a `python3` on `PATH` able to create venvs. No ffmpeg is needed for this tier (faster-whisper bundles PyAV for audio decoding).

Environment variables (all optional):

| Var | Default | Purpose |
|---|---|---|
| `B24_TRANSCRIBE_PYTHON` | — | Interpreter that already has `faster-whisper`; set it to skip the managed venv |
| `B24_BOOTSTRAP_PYTHON` | `python3` | Base interpreter used to create the managed venv |
| `B24_TRANSCRIBE_SCRIPT` | bundled `scripts/transcribe_worker.py` | Override the worker script |
| `B24_TRANSCRIBE_CONCURRENCY` | CPU cores ÷ 4 | Parallel transcription workers |
| `B24_WHISPER_MODEL` | `large-v3` | Whisper model name/size |
| `B24_WHISPER_COMPUTE` | `int8` | ctranslate2 compute type |
| `B24_WHISPER_LANG` | `ru` | Language hint; empty = autodetect |

#### Fast tier — one venv

`bitrix24_call_transcribe_fast` runs [GigaAM v2](https://github.com/salute-developers/GigaAM), a Russian-only RNNT model (~5× real-time on CPU, never hallucinates; raw lowercase output). It needs a Python environment with `gigaam` — GigaAM requires Python < 3.13 (which pins a compatible torch) and shells out to the `ffmpeg` binary, so ffmpeg must be on `PATH`:

```bash
brew install ffmpeg            # or your platform's package manager
python3.12 -m venv ~/.venvs/b24-giga
~/.venvs/b24-giga/bin/pip install gigaam soundfile
export B24_FAST_PYTHON=~/.venvs/b24-giga/bin/python
```

#### Max tier — heavy venv + HuggingFace token

`bitrix24_call_transcribe_max` runs GigaAM + Whisper (with anti-hallucination settings and domain hotwords) + [pyannote](https://github.com/pyannote/pyannote-audio) speaker diarization, and returns both transcripts plus speaker-tagged segments for the calling model to reconcile. It needs everything from the fast tier plus `faster-whisper` and `pyannote.audio` in one environment, and a HuggingFace token whose account has accepted the gated model terms at [pyannote/speaker-diarization-community-1](https://huggingface.co/pyannote/speaker-diarization-community-1) and [pyannote/segmentation-3.0](https://huggingface.co/pyannote/segmentation-3.0):

```bash
brew install ffmpeg            # or your platform's package manager
python3.12 -m venv ~/.venvs/b24-max
~/.venvs/b24-max/bin/pip install gigaam soundfile faster-whisper pyannote.audio
export B24_MAX_PYTHON=~/.venvs/b24-max/bin/python
export HF_TOKEN=hf_...         # or B24_HF_TOKEN
```

`B24_FAST_SCRIPT` / `B24_MAX_SCRIPT` override the bundled `scripts/transcribe_fast.py` / `scripts/transcribe_max.py`. Models for all tiers download lazily into `~/.cache/huggingface` on first use.

If a tier's environment is missing, its tool returns a clear, actionable error (`error_type`: `missing_deps` / `missing_hf_token` / `model_not_approved`) and the rest of the server is unaffected.

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

After restarting Claude Code, run `/mcp` to confirm the server is connected. You should see 31 tools, or 35 if the Knowledge Base token is configured.

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
