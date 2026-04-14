import { config as loadDotenv } from "dotenv";
import type { Config } from "../types.js";

export function loadConfig(overrides: Partial<Config> = {}): Config {
  loadDotenv();

  const granolaApiKey = overrides.granolaApiKey || process.env.GRANOLA_API_KEY || "";
  const notionToken = overrides.notionToken || process.env.NOTION_TOKEN || "";
  const notionParentPageId =
    overrides.notionParentPageId || process.env.NOTION_PARENT_PAGE_ID || "";
  const dryRun = overrides.dryRun ?? false;

  if (!granolaApiKey) {
    console.error(
      "Error: GRANOLA_API_KEY is required. Set it in .env or pass --granola-key.\n" +
        "Generate a key in the Granola desktop app: Settings → API → Create new key"
    );
    process.exit(1);
  }

  if (!notionToken && !dryRun) {
    console.error(
      "Error: NOTION_TOKEN is required. Set it in .env or pass --notion-token.\n" +
        "Create an integration at https://www.notion.so/my-integrations"
    );
    process.exit(1);
  }

  if (!notionParentPageId && !dryRun) {
    console.error(
      "Error: NOTION_PARENT_PAGE_ID is required. Set it in .env or pass --parent-page.\n" +
        "This is the Notion page under which meeting folders will be created."
    );
    process.exit(1);
  }

  return { granolaApiKey, notionToken, notionParentPageId, dryRun };
}
