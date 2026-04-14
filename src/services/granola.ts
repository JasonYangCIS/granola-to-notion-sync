import type {
  GranolaData,
  GranolaNote,
  GranolaNotesListResponse,
  GranolaFolder,
} from "../types.js";

const GRANOLA_API_BASE = "https://public-api.granola.ai";
const API_DELAY_MS = 220; // ~5 req/s

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

  // 2. Fetch full details (summary + transcript) for each
  console.log("  Fetching details + transcripts...");
  const notes = new Map<string, GranolaNote>();
  let fetched = 0;

  for (const [id, listNote] of noteList) {
    const detail = await fetchNoteDetail(apiKey, id);
    notes.set(id, detail ?? listNote);
    fetched++;
    if (fetched % 5 === 0 || fetched === noteList.size) {
      process.stdout.write(`\r  ${fetched}/${noteList.size}`);
    }
  }
  console.log(""); // newline after progress

  // 3. Build folder structures from folder_membership in API responses
  const folders = new Map<string, GranolaFolder>();
  const folderDocuments = new Map<string, string[]>();
  const documentFolders = new Map<string, string>();

  for (const [noteId, note] of notes) {
    if (!note.folder_membership?.length) continue;

    // Use the first folder membership as the note's folder
    const fm = note.folder_membership[0];
    folders.set(fm.id, { id: fm.id, name: fm.name });

    if (!folderDocuments.has(fm.id)) {
      folderDocuments.set(fm.id, []);
    }
    folderDocuments.get(fm.id)!.push(noteId);
    documentFolders.set(noteId, fm.id);
  }

  return { notes, folders, folderDocuments, documentFolders };
}

async function fetchAllNotes(apiKey: string): Promise<Map<string, GranolaNote>> {
  const notes = new Map<string, GranolaNote>();
  let cursor: string | undefined;

  while (true) {
    const url = new URL(`${GRANOLA_API_BASE}/v1/notes`);
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
