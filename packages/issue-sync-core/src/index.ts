export type { CreateIssueInput, Issue, TrackerAdapter } from "./adapter.js";
export type { IssueSyncConfig } from "./config.js";
export { defaultConfig } from "./config.js";
export type { NoteContext, TaskLike, TasksApi } from "./operations.js";
export {
  closedExternalIds,
  createJsonlTasksApi,
  pull,
  push,
  release,
} from "./operations.js";
export type { SyncEntry, SyncState } from "./state.js";
export {
  findByExternalId,
  findByTaskId,
  loadState,
  recordRunStart,
  saveState,
  takeRunStart,
  upsertEntry,
  withStateLock,
} from "./state.js";
