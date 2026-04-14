#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig } from "./utils/config.js";
import { sync } from "./services/sync.js";

const program = new Command();

program
  .name("granola-to-notion")
  .description("Sync meeting notes from Granola to Notion")
  .version("1.0.0");

program
  .command("sync")
  .description("Sync Granola meeting notes to Notion")
  .option("--dry-run", "Preview what would be synced without making changes")
  .option("--granola-key <key>", "Granola API key (overrides .env)")
  .option("--notion-token <token>", "Notion integration token (overrides .env)")
  .option("--parent-page <id>", "Notion parent page ID (overrides .env)")
  .action(async (opts) => {
    const config = loadConfig({
      granolaApiKey: opts.granolaKey,
      notionToken: opts.notionToken,
      notionParentPageId: opts.parentPage,
      dryRun: opts.dryRun ?? false,
    });

    await sync(config);
  });

program.parse();
