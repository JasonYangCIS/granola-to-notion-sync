// === Granola API response types ===

export interface GranolaNote {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  owner: { name: string; email: string };
  calendar_event?: {
    event_title: string;
    scheduled_start_time: string;
    scheduled_end_time: string;
    organiser?: string;
    invitees?: { email: string }[];
  } | null;
  attendees?: { name?: string; email: string }[];
  folder_membership?: { object: string; id: string; name: string }[];
  summary_text?: string | null;
  summary_markdown?: string | null;
  transcript?: {
    text: string;
    start_time: string;
    end_time: string;
    speaker?: { source: string; name?: string };
  }[];
}

export interface GranolaNotesListResponse {
  notes: GranolaNote[];
  next_cursor?: string;
}

// === Folder info (derived from API folder_membership) ===

export interface GranolaFolder {
  id: string;
  name: string;
}

export interface GranolaData {
  notes: Map<string, GranolaNote>;
  folders: Map<string, GranolaFolder>;       // folderId -> folder
  folderDocuments: Map<string, string[]>;     // folderId -> noteIds
  documentFolders: Map<string, string>;       // noteId -> folderId
}

// === Sync state ===

export interface SyncedDoc {
  notionPageId: string;
  granolaUpdatedAt: string;
  syncedAt: string;
}

export interface FolderEntry {
  notionId: string;
  type: "page" | "database";
}

export interface SyncState {
  version: 1;
  syncedDocuments: Record<string, SyncedDoc>;
  folderPages: Record<string, FolderEntry>;
  lastSyncTimestamp: string | null;
}

// === Config ===

export interface Config {
  granolaApiKey: string;
  notionToken: string;
  notionParentPageId: string;
  dryRun: boolean;
}

// === Sync result ===

export interface SyncResult {
  created: number;
  updated: number;
  skipped: number;
  foldersCreated: number;
  errors: string[];
}
