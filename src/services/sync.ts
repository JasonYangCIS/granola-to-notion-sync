import type { Client } from "@notionhq/client";
import type { Config, GranolaData, GranolaNote, SyncResult } from "../types.js";
import { loadGranolaData } from "./granola.js";
import { convertToNotionBlocks } from "../utils/converter.js";
import {
  loadSyncState,
  saveSyncState,
  markDocSynced,
} from "../utils/sync-state.js";
import {
  createNotionClient,
  createPage,
  appendBlocks,
  verifyPageAccess,
} from "./notion.js";

/** Format date as M/D/YYYY */
function formatDatePrefix(note: GranolaNote): string {
  const dateTime = note.calendar_event?.scheduled_start_time ?? note.created_at;
  const d = new Date(dateTime);
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

export async function sync(config: Config): Promise<SyncResult> {
  // 1. Load from Granola API
  console.log("Loading Granola data...");
  const data = await loadGranolaData(config.granolaApiKey);
  console.log(`  ${data.notes.size} notes, ${data.folders.size} folders`);

  // 2. Load sync state
  const state = loadSyncState();

  // 3. Find new notes (once synced, never touch again)
  const toCreate: GranolaNote[] = [];
  let skipped = 0;

  for (const note of data.notes.values()) {
    if (state.syncedDocuments[note.id]) {
      skipped++;
    } else {
      toCreate.push(note);
    }
  }

  toCreate.sort((a, b) => a.created_at.localeCompare(b.created_at));
  console.log(`\n  ${toCreate.length} new, ${skipped} already synced`);

  // 4. Dry-run
  if (config.dryRun) {
    printDryRun(data, toCreate);
    return { created: 0, updated: 0, skipped, foldersCreated: 0, errors: [] };
  }

  // 5. Connect to Notion
  const client = createNotionClient(config.notionToken);
  console.log("\nVerifying Notion access...");
  await verifyPageAccess(client, config.notionParentPageId);
  console.log("  Connected.");

  const result: SyncResult = {
    created: 0, updated: 0, skipped, foldersCreated: 0, errors: [],
  };

  // 6. Ensure folder pages exist in Notion
  const neededFolderIds = new Set<string>();
  for (const note of toCreate) {
    const folderId = data.documentFolders.get(note.id);
    if (folderId) neededFolderIds.add(folderId);
  }

  const hasUnfiled = toCreate.some((n) => !data.documentFolders.has(n.id));

  console.log("\nEnsuring folder pages in Notion...");
  for (const folderId of neededFolderIds) {
    if (state.folderPages[folderId]) continue;
    const folder = data.folders.get(folderId);
    if (!folder) continue;

    try {
      const pageId = await createPage(
        client, config.notionParentPageId, folder.name, "📁"
      );
      state.folderPages[folderId] = { notionId: pageId, type: "page" };
      result.foldersCreated++;
      saveSyncState(state);
      console.log(`  Created: ${folder.name}`);
    } catch (err) {
      const msg = `Failed to create folder "${folder.name}": ${err}`;
      console.error(`  ${msg}`);
      result.errors.push(msg);
    }
  }

  if (hasUnfiled && !state.folderPages["__unfiled__"]) {
    const pageId = await createPage(
      client, config.notionParentPageId, "Unfiled", "📥"
    );
    state.folderPages["__unfiled__"] = { notionId: pageId, type: "page" };
    result.foldersCreated++;
    saveSyncState(state);
    console.log("  Created: Unfiled");
  }

  // 7. Sync notes as child pages
  if (toCreate.length > 0) {
    console.log(`\nCreating ${toCreate.length} pages...`);
    for (const note of toCreate) {
      await syncNote(client, note, data, state, result);
    }
  }

  // 8. Summary
  console.log(`\nDone! ${result.created} created, ${result.skipped} already synced.`);
  if (result.foldersCreated > 0) {
    console.log(`  ${result.foldersCreated} folders created.`);
  }
  if (result.errors.length > 0) {
    console.log(`  ${result.errors.length} errors:`);
    for (const err of result.errors) console.log(`    - ${err}`);
  }

  return result;
}

async function syncNote(
  client: Client,
  note: GranolaNote,
  data: GranolaData,
  state: ReturnType<typeof loadSyncState>,
  result: SyncResult
): Promise<void> {
  const folderId = data.documentFolders.get(note.id);
  const targetEntry = folderId
    ? state.folderPages[folderId]
    : state.folderPages["__unfiled__"];

  if (!targetEntry) {
    const msg = `No target folder for "${note.title}" — skipping`;
    console.warn(`  ${msg}`);
    result.errors.push(msg);
    return;
  }

  try {
    const blocks = convertToNotionBlocks(note);
    const datePrefix = formatDatePrefix(note);
    const pageTitle = `${datePrefix} - ${note.title}`;

    const pageId = await createPage(
      client, targetEntry.notionId, pageTitle, "📝"
    );

    if (blocks.length > 0) {
      await appendBlocks(client, pageId, blocks);
    }

    markDocSynced(state, note.id, pageId, note.updated_at);
    saveSyncState(state);
    result.created++;

    const folderName = folderId
      ? data.folders.get(folderId)?.name ?? "Unknown"
      : "Unfiled";
    console.log(`  + ${pageTitle} → ${folderName}`);
  } catch (err) {
    const msg = `Failed to sync "${note.title}": ${err}`;
    console.error(`  ${msg}`);
    result.errors.push(msg);
  }
}

function printDryRun(data: GranolaData, toCreate: GranolaNote[]): void {
  console.log("\n--- DRY RUN (no changes will be made) ---\n");

  console.log("Folders:");
  for (const folder of data.folders.values()) {
    const docCount = data.folderDocuments.get(folder.id)?.length ?? 0;
    console.log(`  📁 ${folder.name} (${docCount} notes)`);
  }

  const unfiledCount = [...data.notes.keys()].filter(
    (id) => !data.documentFolders.has(id)
  ).length;
  if (unfiledCount > 0) {
    console.log(`  📥 Unfiled (${unfiledCount} notes)`);
  }

  if (toCreate.length > 0) {
    console.log(`\nWould create ${toCreate.length} pages:`);
    for (const note of toCreate) {
      const folderId = data.documentFolders.get(note.id);
      const folderName = folderId
        ? data.folders.get(folderId)?.name ?? "Unknown"
        : "Unfiled";
      const datePrefix = formatDatePrefix(note);
      const hasSummary = note.summary_text?.trim() || note.summary_markdown?.trim() ? "✓" : "–";
      console.log(`  + ${datePrefix} - ${note.title} → ${folderName} [summary:${hasSummary}]`);
    }
  }

  console.log("\n--- End dry run ---");
}
