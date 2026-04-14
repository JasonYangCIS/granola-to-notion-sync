import type { Client } from "@notionhq/client";
import type { Config, GranolaData, GranolaNote, GranolaFolder, SyncResult } from "../types.js";
import { loadGranolaData, getFolderAncestry } from "./granola.js";
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
  listChildPages,
} from "./notion.js";

/** Format date as M/D/YYYY */
function formatDatePrefix(note: GranolaNote): string {
  const dateTime = note.calendar_event?.scheduled_start_time ?? note.created_at;
  const d = new Date(dateTime);
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

/** Build a display path like "Internal / Clients / IHG" */
function getFolderPath(folderId: string, folders: Map<string, GranolaFolder>): string {
  const ancestry = getFolderAncestry(folderId, folders);
  return ancestry.map((id) => folders.get(id)?.name ?? id).join(" / ");
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

  // Reconcile: scan Notion for existing pages to avoid duplicates after reset
  console.log("\nReconciling with existing Notion pages...");
  const counts = { folders: 0, notes: 0 };
  await reconcileExistingPages(client, config.notionParentPageId, data, state, counts);
  if (counts.folders > 0 || counts.notes > 0) {
    saveSyncState(state);
    // Re-filter toCreate: remove notes now recognized as existing
    for (let i = toCreate.length - 1; i >= 0; i--) {
      if (state.syncedDocuments[toCreate[i].id]) {
        toCreate.splice(i, 1);
        skipped++;
      }
    }
    console.log(`  Found ${counts.folders} folders, ${counts.notes} notes already in Notion.`);
    console.log(`  ${toCreate.length} new notes to create.`);
  } else {
    console.log("  No existing pages found.");
  }

  const result: SyncResult = {
    created: 0, updated: 0, skipped, foldersCreated: 0, errors: [],
  };

  // 6. Ensure folder pages exist in Notion (with nesting)
  // Collect all folders needed (leaf folders + all ancestors)
  const neededFolderIds = new Set<string>();
  for (const note of toCreate) {
    const folderId = data.documentFolders.get(note.id);
    if (folderId) {
      for (const ancestorId of getFolderAncestry(folderId, data.folders)) {
        neededFolderIds.add(ancestorId);
      }
    }
  }

  const hasUnfiled = toCreate.some((n) => !data.documentFolders.has(n.id));

  console.log("\nEnsuring folder pages in Notion...");

  // Sort by depth so parents are created before children
  const sortedFolderIds = [...neededFolderIds].sort((a, b) =>
    getFolderAncestry(a, data.folders).length - getFolderAncestry(b, data.folders).length
  );

  for (const folderId of sortedFolderIds) {
    if (state.folderPages[folderId]) continue;
    const folder = data.folders.get(folderId);
    if (!folder) continue;

    // Parent in Notion: the folder's parent page, or the root parent page
    const notionParentId = folder.parentId
      ? state.folderPages[folder.parentId]?.notionId ?? config.notionParentPageId
      : config.notionParentPageId;

    try {
      const pageId = await createPage(client, notionParentId, folder.name, "📁");
      state.folderPages[folderId] = { notionId: pageId, type: "page" };
      result.foldersCreated++;
      saveSyncState(state);
      console.log(`  Created: ${getFolderPath(folderId, data.folders)}`);
    } catch (err) {
      const msg = `Failed to create folder "${folder.name}": ${err}`;
      console.error(`  ${msg}`);
      result.errors.push(msg);
    }
  }

  if (hasUnfiled && !state.folderPages["__unfiled__"]) {
    const pageId = await createPage(client, config.notionParentPageId, "Unfiled", "📥");
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

    const pageId = await createPage(client, targetEntry.notionId, pageTitle, "📝");

    if (blocks.length > 0) {
      await appendBlocks(client, pageId, blocks);
    }

    markDocSynced(state, note.id, pageId, note.updated_at);
    saveSyncState(state);
    result.created++;

    const folderPath = folderId
      ? getFolderPath(folderId, data.folders)
      : "Unfiled";
    console.log(`  + ${pageTitle} → ${folderPath}`);
  } catch (err) {
    const msg = `Failed to sync "${note.title}": ${err}`;
    console.error(`  ${msg}`);
    result.errors.push(msg);
  }
}

async function reconcileExistingPages(
  client: ReturnType<typeof createNotionClient>,
  parentPageId: string,
  data: GranolaData,
  state: ReturnType<typeof loadSyncState>,
  counts: { folders: number; notes: number },
): Promise<void> {
  // Build lookup: expected page title → Granola note ID
  const titleToNoteId = new Map<string, string>();
  for (const [noteId, note] of data.notes) {
    if (state.syncedDocuments[noteId]) continue;
    const datePrefix = formatDatePrefix(note);
    const title = `${datePrefix} - ${note.title}`;
    if (!titleToNoteId.has(title)) {
      titleToNoteId.set(title, noteId);
    }
  }

  await reconcileFolder(client, parentPageId, null, data, state, titleToNoteId, counts);
}

async function reconcileFolder(
  client: ReturnType<typeof createNotionClient>,
  notionPageId: string,
  granolaParentFolderId: string | null,
  data: GranolaData,
  state: ReturnType<typeof loadSyncState>,
  titleToNoteId: Map<string, string>,
  counts: { folders: number; notes: number },
): Promise<void> {
  const children = await listChildPages(client, notionPageId);

  for (const { title, id: childPageId } of children) {
    // Try matching as a Granola folder
    let matchedFolder: GranolaFolder | null = null;
    for (const folder of data.folders.values()) {
      if (folder.name === title && folder.parentId === granolaParentFolderId) {
        matchedFolder = folder;
        break;
      }
    }

    if (matchedFolder) {
      if (!state.folderPages[matchedFolder.id]) {
        state.folderPages[matchedFolder.id] = { notionId: childPageId, type: "page" };
        counts.folders++;
        console.log(`    folder: ${title}`);
      }
      // Always recurse — even duplicate folder pages may contain notes
      await reconcileFolder(
        client, childPageId, matchedFolder.id, data, state, titleToNoteId, counts
      );
      continue;
    }

    // Handle "Unfiled" pseudo-folder at root
    if (title === "Unfiled" && granolaParentFolderId === null) {
      if (!state.folderPages["__unfiled__"]) {
        state.folderPages["__unfiled__"] = { notionId: childPageId, type: "page" };
        counts.folders++;
        console.log(`    folder: Unfiled`);
      }
      await reconcileFolder(
        client, childPageId, "__unfiled__", data, state, titleToNoteId, counts
      );
      continue;
    }

    // Try matching as a note page
    const noteId = titleToNoteId.get(title);
    if (noteId && !state.syncedDocuments[noteId]) {
      const note = data.notes.get(noteId);
      if (note) {
        state.syncedDocuments[noteId] = {
          notionPageId: childPageId,
          granolaUpdatedAt: note.updated_at,
          syncedAt: new Date().toISOString(),
        };
        counts.notes++;
        titleToNoteId.delete(title);
      }
    }
  }
}

function printDryRun(data: GranolaData, toCreate: GranolaNote[]): void {
  console.log("\n--- DRY RUN (no changes will be made) ---\n");

  // Print folder tree
  console.log("Folder structure:");
  printFolderTree(data.folders, data.folderDocuments, null, "");

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
      const folderPath = folderId
        ? getFolderPath(folderId, data.folders)
        : "Unfiled";
      const datePrefix = formatDatePrefix(note);
      const hasSummary = note.summary_text?.trim() || note.summary_markdown?.trim() ? "✓" : "–";
      console.log(`  + ${datePrefix} - ${note.title} → ${folderPath} [summary:${hasSummary}]`);
    }
  }

  console.log("\n--- End dry run ---");
}

function printFolderTree(
  folders: Map<string, GranolaFolder>,
  folderDocuments: Map<string, string[]>,
  parentId: string | null,
  indent: string
): void {
  const children = [...folders.values()].filter((f) => f.parentId === parentId);
  for (const folder of children) {
    const docCount = folderDocuments.get(folder.id)?.length ?? 0;
    const hasChildren = [...folders.values()].some((f) => f.parentId === folder.id);
    const countLabel = docCount > 0 ? ` (${docCount} notes)` : "";
    console.log(`${indent}  📁 ${folder.name}${countLabel}`);
    if (hasChildren) {
      printFolderTree(folders, folderDocuments, folder.id, indent + "  ");
    }
  }
}
