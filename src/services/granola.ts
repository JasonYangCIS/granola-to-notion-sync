import fs from "node:fs";
import path from "node:path";
import type {
  GranolaData,
  GranolaNote,
  GranolaNotesListResponse,
  GranolaFolder,
} from "../types.js";

const GRANOLA_API_BASE = "https://public-api.granola.ai";
const API_DELAY_MS = 220; // ~5 req/s
const CACHE_DIR = path.resolve("cached");

async function apiDelay(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, API_DELAY_MS));
}

/**
 * Fetch all notes from the Granola API with full details.
 */
export async function loadGranolaData(apiKey: string): Promise<GranolaData> {
  // 1. Fetch note list
  console.log("  Fetching notes from Granola API...");
  const noteList = await fetchAllNotes(apiKey);
  console.log(`  Found ${noteList.size} notes`);

  // 2. Fetch full details for each (with disk cache)
  console.log("  Fetching note details...");
  const notes = new Map<string, GranolaNote>();
  let fetched = 0;
  let cacheHits = 0;

  for (const [id, listNote] of noteList) {
    const cached = readCachedNote(id, listNote.updated_at);
    if (cached) {
      notes.set(id, cached);
      cacheHits++;
    } else {
      const detail = await fetchNoteDetail(apiKey, id);
      const note = detail ?? listNote;
      notes.set(id, note);
      writeCachedNote(id, note);
    }
    fetched++;
    if (fetched % 5 === 0 || fetched === noteList.size) {
      process.stdout.write(`\r  ${fetched}/${noteList.size}`);
    }
  }
  console.log(cacheHits > 0 ? ` (${cacheHits} cached)` : "");

  // 3. Build folder structures with hierarchy from folder_membership
  //
  // The API returns folder_membership as an array ordered leaf → root.
  // e.g. [IHG, Clients, Internal] means IHG is under Clients, which is under Internal.
  // Different notes can disagree on ordering (e.g. one says A→B, another B→A),
  // so we use majority voting to resolve parent relationships.
  const folders = new Map<string, GranolaFolder>();
  const folderDocuments = new Map<string, string[]>();
  const documentFolders = new Map<string, string>();

  // Pass 1: collect parent votes from all notes
  // parentVotes maps folderId → (candidateParentId → vote count)
  // "__root__" represents no parent (top-level folder)
  const ROOT = "__root__";
  const parentVotes = new Map<string, Map<string, number>>();

  for (const [noteId, note] of notes) {
    if (!note.folder_membership?.length) continue;

    const fms = note.folder_membership;

    for (let i = 0; i < fms.length; i++) {
      const fm = fms[i];
      const parentFm = fms[i + 1] ?? null;
      const parentKey = parentFm?.id ?? ROOT;

      // Register folder name
      if (!folders.has(fm.id)) {
        folders.set(fm.id, { id: fm.id, name: fm.name, parentId: null });
      }

      // Cast a vote for this parent relationship
      if (!parentVotes.has(fm.id)) parentVotes.set(fm.id, new Map());
      const votes = parentVotes.get(fm.id)!;
      votes.set(parentKey, (votes.get(parentKey) ?? 0) + 1);
    }

    // Assign note to the leaf folder (first in the array)
    const leafFolder = fms[0];
    if (!folderDocuments.has(leafFolder.id)) {
      folderDocuments.set(leafFolder.id, []);
    }
    folderDocuments.get(leafFolder.id)!.push(noteId);
    documentFolders.set(noteId, leafFolder.id);
  }

  // Pass 2: resolve each folder's parent by picking the top-voted candidate
  for (const [folderId, votes] of parentVotes) {
    let bestParent = ROOT;
    let bestCount = 0;
    for (const [candidate, count] of votes) {
      if (count > bestCount) {
        bestParent = candidate;
        bestCount = count;
      }
    }
    const folder = folders.get(folderId);
    if (folder) {
      folder.parentId = bestParent === ROOT ? null : bestParent;
    }
  }

  return { notes, folders, folderDocuments, documentFolders };
}

/**
 * Get folder ancestry chain from leaf to root.
 */
export function getFolderAncestry(
  folderId: string,
  folders: Map<string, GranolaFolder>
): string[] {
  const ancestry: string[] = [];
  const visited = new Set<string>();
  let currentId: string | null = folderId;
  while (currentId) {
    if (visited.has(currentId)) break; // cycle detected
    visited.add(currentId);
    ancestry.unshift(currentId);
    const folder = folders.get(currentId);
    currentId = folder?.parentId ?? null;
  }
  return ancestry;
}

function readCachedNote(noteId: string, updatedAt: string): GranolaNote | null {
  const filePath = path.join(CACHE_DIR, `${noteId}.json`);
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const note = JSON.parse(raw) as GranolaNote;
    if (note.updated_at === updatedAt) return note;
  } catch {
    // Cache miss — file doesn't exist or is corrupted
  }
  return null;
}

function writeCachedNote(noteId: string, note: GranolaNote): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(CACHE_DIR, `${noteId}.json`),
      JSON.stringify(note, null, 2)
    );
  } catch {
    // Non-fatal — caching is best-effort
  }
}

async function fetchAllNotes(apiKey: string): Promise<Map<string, GranolaNote>> {
  const notes = new Map<string, GranolaNote>();
  let cursor: string | undefined;

  while (true) {
    const url = new URL(`${GRANOLA_API_BASE}/v1/notes`);
    url.searchParams.set("page_size", "30"); // max allowed
    if (cursor) url.searchParams.set("cursor", cursor);

    await apiDelay();
    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (response.status === 401) {
      console.error(
        "Error: Invalid Granola API key.\n" +
          "Generate a key in the Granola desktop app: Settings → API → Create new key"
      );
      process.exit(1);
    }

    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get("retry-after") || "2");
      console.warn(`  Rate limited, waiting ${retryAfter}s...`);
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      continue;
    }

    if (!response.ok) {
      throw new Error(`Granola API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as GranolaNotesListResponse;
    for (const note of data.notes) {
      notes.set(note.id, note);
    }

    if (!data.next_cursor) break;
    cursor = data.next_cursor;
  }

  return notes;
}

async function fetchNoteDetail(
  apiKey: string,
  noteId: string
): Promise<GranolaNote | null> {
  const url = `${GRANOLA_API_BASE}/v1/notes/${noteId}`;

  await apiDelay();
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (response.status === 404) return null;
  if (response.status === 429) {
    const retryAfter = parseInt(response.headers.get("retry-after") || "2");
    await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
    return fetchNoteDetail(apiKey, noteId);
  }

  if (!response.ok) {
    console.warn(`  Warning: Could not fetch note ${noteId}: ${response.status}`);
    return null;
  }

  return (await response.json()) as GranolaNote;
}
