# granola-to-notion

A TypeScript CLI tool that syncs your [Granola.ai](https://granola.ai) meeting notes to [Notion](https://notion.so), organized by folder.

## What it does

- Fetches your meeting notes from the Granola API (summaries, attendees, calendar info)
- Creates folder pages in Notion matching your Granola folder structure
- Creates a Notion page per meeting note with date-prefixed titles (e.g., `4/14/2026 - Post Sales Team Meeting`)
- Each page includes a metadata header (date/time, attendees) and the AI-generated summary
- Tracks sync state locally — only new notes are synced on subsequent runs
- Never overwrites existing Notion pages, so you can freely add your own notes to them

## Prerequisites

- **Granola** Business or Enterprise plan (required for API access)
- **Node.js** 24+

## Setup

1. **Clone and install**

   ```sh
   git clone <repo-url>
   cd granola-to-notion
   npm install
   ```

2. **Create a Granola API key**

   In the Granola desktop app: **Settings > API > Create new key**

3. **Create a Notion integration**

   - Go to https://www.notion.so/my-integrations
   - Create a new integration and copy the token
   - Open your target Notion page, click `...` > **Add connections** > select your integration

4. **Configure environment**

   ```sh
   cp .env.example .env
   ```

   Fill in your `.env`:

   ```
   GRANOLA_API_KEY=grn_your_key_here
   NOTION_TOKEN=ntn_your_token_here
   NOTION_PARENT_PAGE_ID=your_page_id_here
   ```

   The parent page ID is the 32-character hex string from the Notion page URL.

## Usage

```sh
# Preview what would be synced
npm run sync -- --dry-run

# Sync meeting notes to Notion
npm run sync

# Reset sync state (next sync will re-create all pages)
npm run reset

# Clear cached Granola API responses (forces re-fetch)
npm run clear-cache
```

> **Note:** Resetting does not delete existing pages in Notion. If you run `npm run sync` after a reset, you'll get duplicate pages unless you manually remove the old ones from Notion first.

### CLI options

| Flag | Description |
|---|---|
| `--dry-run` | Preview changes without creating anything in Notion |
| `--granola-key <key>` | Granola API key (overrides `.env`) |
| `--notion-token <token>` | Notion integration token (overrides `.env`) |
| `--parent-page <id>` | Notion parent page ID (overrides `.env`) |

## Project structure

```
src/
├── cli.ts              # CLI entry point
├── types.ts            # Shared type definitions
├── services/
│   ├── granola.ts      # Granola API client
│   ├── notion.ts       # Notion API client
│   └── sync.ts         # Sync orchestration
└── utils/
    ├── config.ts       # Env loading & validation
    ├── converter.ts    # Granola note → Notion block conversion
    └── sync-state.ts   # Local sync state tracking (.sync-state.json)
```

## How sync works

1. Fetches all notes from the Granola API with full details (summary, attendees, calendar event)
   - Note details are cached locally in `cached/` — unchanged notes are loaded from disk instead of hitting the API again
2. Loads local `.sync-state.json` to determine which notes are new
3. Reconciles with existing Notion pages to avoid duplicates after a reset
4. Creates nested Notion folder pages mirroring your Granola folder hierarchy
5. Creates a Notion page per new note under its corresponding folder
6. Saves sync state after each note (safe to interrupt and resume)

Re-running `npm run sync` only picks up new notes. Previously synced notes are never modified or overwritten.
