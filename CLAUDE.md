# CLAUDE.md

## Project Overview

CLI tool that syncs Granola.ai meeting notes to Notion. Built with TypeScript, runs locally via `npm run sync`.

## Key Commands

```sh
npm run sync              # Sync new notes to Notion
npm run sync -- --dry-run # Preview without changes
npm run reset             # Clear sync state (.sync-state.json)
npx tsc --noEmit          # Type-check
```

## Architecture

- **Entry point**: `src/cli.ts` — Commander.js CLI
- **Services**: `src/services/` — Granola API client, Notion API client, sync orchestration
- **Utils**: `src/utils/` — config loading, content converter, sync state persistence
- **Types**: `src/types.ts` — all shared interfaces

Sync flow: Fetch notes from Granola API → load local sync state → diff → create folder pages in Notion → create note pages → save state after each note.

## Granola API

- **Base URL**: `https://public-api.granola.ai` (NOT `api.granola.ai` — that returns 404)
- **Auth**: `Authorization: Bearer grn_xxx`
- **Rate limit**: 5 req/s sustained, 25 req/5s burst
- **List notes**: `GET /v1/notes` — returns `{ notes: [...], next_cursor? }` with basic fields only (id, title, owner, created_at, updated_at)
- **Note detail**: `GET /v1/notes/{id}` — returns full note with `summary_text`, `summary_markdown`, `attendees`, `calendar_event`, `folder_membership`
- **With transcript**: `GET /v1/notes/{id}?include=transcript` — adds `transcript` array (currently not used)

### API response field names (these differ from the local cache)

| API field | Description |
|---|---|
| `summary_text` | AI summary as plain text (NOT `summary`) |
| `summary_markdown` | AI summary as markdown (NOT `overview`) |
| `calendar_event.scheduled_start_time` | Meeting start (NOT `start.dateTime`) |
| `calendar_event.scheduled_end_time` | Meeting end |
| `attendees` | Array of `{ name, email }` |
| `folder_membership` | Array of `{ id, name }` — flat, no hierarchy |
| `transcript[].speaker.source` | "microphone" or "speaker" (NOT speaker name) |

Note IDs from the API use `not_xxx` format, not UUIDs. Folder IDs use `fol_xxx` format.

## Design Decisions

- **Create-only, never update**: Once a note is synced to Notion, it is never modified or overwritten. The user adds their own notes to the Notion pages after sync.
- **Pages, not databases**: Meeting notes are created as child pages under folder pages (not Notion database entries). Page titles use `M/D/YYYY - Title` format.
- **No transcripts**: Only AI summaries are synced. Transcripts were removed to keep pages clean.
- **Sync state per-document**: `.sync-state.json` is saved after each note for crash safety. Uses Granola note ID as the key.
- **Folder structure from API**: The `folder_membership` field on each note provides folder assignment. Folders are flat in Notion (API doesn't expose parent/child hierarchy).
- **Only user's own notes**: The Granola Personal API only returns notes the user owns or that were shared with them directly.

## Notion API

- **SDK**: `@notionhq/client`
- **Rate limit**: 3 req/s average. Tool adds 340ms delay between calls + exponential backoff on 429.
- **Block limit**: 100 blocks per append call. Converter chunks automatically.
- **Rich text limit**: 2000 chars per rich_text item. Converter chunks automatically.
- **Integration setup**: User must share the parent page with their integration via "Add connections" in Notion.

## Environment Variables

```
GRANOLA_API_KEY=grn_...   # Required. From Granola desktop: Settings > API
NOTION_TOKEN=ntn_...      # Required (except --dry-run)
NOTION_PARENT_PAGE_ID=... # Required (except --dry-run). 32-char hex from Notion URL
```

## Common Issues

- **Granola API 404**: You're using the wrong base URL. Must be `public-api.granola.ai`.
- **Notion 404 on parent page**: Integration hasn't been added to the page. User must click "..." > "Add connections".
- **Duplicate pages after reset**: `npm run reset` clears sync state but doesn't delete Notion pages. User must delete old pages manually before re-syncing.
- **Empty summaries**: The list endpoint (`GET /v1/notes`) doesn't include summaries. Must fetch each note's detail endpoint individually.
