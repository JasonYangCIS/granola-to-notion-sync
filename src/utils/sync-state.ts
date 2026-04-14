import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import type { SyncState } from "../types.js";

const DEFAULT_STATE_PATH = resolve(process.cwd(), ".sync-state.json");

function emptyState(): SyncState {
  return {
    version: 1,
    syncedDocuments: {},
    folderPages: {},
    lastSyncTimestamp: null,
  };
}

export function loadSyncState(path: string = DEFAULT_STATE_PATH): SyncState {
  if (!existsSync(path)) return emptyState();

  try {
    const content = readFileSync(path, "utf-8");
    return JSON.parse(content) as SyncState;
  } catch {
    console.warn("Warning: Could not parse .sync-state.json, starting fresh.");
    return emptyState();
  }
}

export function saveSyncState(
  state: SyncState,
  path: string = DEFAULT_STATE_PATH
): void {
  state.lastSyncTimestamp = new Date().toISOString();
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
}

export function isDocSynced(
  state: SyncState,
  docId: string,
  updatedAt: string
): boolean {
  const synced = state.syncedDocuments[docId];
  return !!synced && synced.granolaUpdatedAt === updatedAt;
}

export function isDocStale(
  state: SyncState,
  docId: string,
  updatedAt: string
): boolean {
  const synced = state.syncedDocuments[docId];
  return !!synced && synced.granolaUpdatedAt !== updatedAt;
}

export function markDocSynced(
  state: SyncState,
  docId: string,
  notionPageId: string,
  updatedAt: string
): void {
  state.syncedDocuments[docId] = {
    notionPageId,
    granolaUpdatedAt: updatedAt,
    syncedAt: new Date().toISOString(),
  };
}
