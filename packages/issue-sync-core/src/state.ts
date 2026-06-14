import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface SyncEntry {
  taskId: string;
  tracker: string;
  externalId: string;
  lastSyncedStatus: string;
  branchName?: string;
}

export interface SyncState {
  entries: SyncEntry[];
}

export function loadState(stateFile: string): SyncState {
  if (!existsSync(stateFile)) return { entries: [] };
  try {
    const raw = readFileSync(stateFile, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "entries" in parsed &&
      Array.isArray((parsed as { entries: unknown }).entries)
    ) {
      return parsed as SyncState;
    }
  } catch {
    /* corrupt or empty state — start fresh */
  }
  return { entries: [] };
}

export function saveState(stateFile: string, state: SyncState): void {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

export function findByExternalId(
  state: SyncState,
  tracker: string,
  externalId: string,
): SyncEntry | undefined {
  return state.entries.find(
    (e) => e.tracker === tracker && e.externalId === externalId,
  );
}

export function findByTaskId(
  state: SyncState,
  taskId: string,
): SyncEntry | undefined {
  return state.entries.find((e) => e.taskId === taskId);
}

export function upsertEntry(state: SyncState, entry: SyncEntry): SyncState {
  const idx = state.entries.findIndex((e) => e.taskId === entry.taskId);
  if (idx >= 0) {
    return {
      entries: [
        ...state.entries.slice(0, idx),
        entry,
        ...state.entries.slice(idx + 1),
      ],
    };
  }
  return { entries: [...state.entries, entry] };
}
