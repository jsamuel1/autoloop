import type { TrackerAdapter } from "./adapter.js";
import type { IssueSyncConfig } from "./config.js";
import {
  findByExternalId,
  findByTaskId,
  loadState,
  saveState,
  upsertEntry,
} from "./state.js";

export interface TaskLike {
  id: string;
  text: string;
  status: "open" | "done";
  source: string;
}

export interface TasksApi {
  listOpen(): TaskLike[];
  listDone(): TaskLike[];
  addTask(text: string, source: string): string;
}

export interface NoteContext {
  runId?: string;
  role?: string;
  branch?: string;
  commitRange?: string;
  summary?: string;
}

function sourceTag(tracker: string, externalId: string): string {
  return `${tracker}:${externalId}`;
}

export async function pull(
  adapter: TrackerAdapter,
  config: IssueSyncConfig,
  tasksApi: TasksApi,
  stateFile: string,
): Promise<{ added: number }> {
  const tracker = config.tracker;
  const pullStates =
    config.linear?.pullStates ?? (config.github ? ["open"] : ["Todo"]);
  const state = loadState(stateFile);

  const issues = await adapter.listIssues(pullStates);
  let added = 0;

  for (const issue of issues) {
    const existing = findByExternalId(state, tracker, issue.id);
    if (existing) continue;

    const source = sourceTag(tracker, issue.id);
    const taskId = tasksApi.addTask(issue.title, source);
    const newState = upsertEntry(state, {
      taskId,
      tracker,
      externalId: issue.id,
      lastSyncedStatus: issue.status,
      branchName: issue.branchName,
    });
    Object.assign(state, newState);
    added++;
  }

  saveState(stateFile, state);
  return { added };
}

export async function push(
  adapter: TrackerAdapter,
  config: IssueSyncConfig,
  tasksApi: TasksApi,
  stateFile: string,
  noteCtx?: NoteContext,
): Promise<{ transitioned: number; created: number }> {
  const tracker = config.tracker;
  const reviewState = config.linear?.reviewState ?? "merged";
  const state = loadState(stateFile);

  const doneTasks = tasksApi.listDone();
  let transitioned = 0;
  let created = 0;

  for (const task of doneTasks) {
    const mapped = findByTaskId(state, task.id);

    if (mapped) {
      if (mapped.lastSyncedStatus === reviewState) continue;
      await adapter.transitionIssue(mapped.externalId, reviewState);
      if (noteCtx) {
        const body = buildNoteBody(noteCtx, task);
        await adapter.commentIssue(mapped.externalId, body);
      }
      const updated = upsertEntry(state, {
        ...mapped,
        lastSyncedStatus: reviewState,
      });
      Object.assign(state, updated);
      transitioned++;
    } else {
      const issue = await adapter.createIssue({
        title: task.text,
        description: noteCtx ? buildNoteBody(noteCtx, task) : undefined,
        labels: resolveCreateLabels(config),
      });
      const newState = upsertEntry(state, {
        taskId: task.id,
        tracker,
        externalId: issue.id,
        lastSyncedStatus: issue.status,
      });
      Object.assign(state, newState);
      created++;
    }
  }

  saveState(stateFile, state);
  return { transitioned, created };
}

export async function release(
  adapter: TrackerAdapter,
  config: IssueSyncConfig,
  stateFile: string,
  version: string,
  repoLabel?: string,
  noteCtx?: NoteContext,
): Promise<{ promoted: number }> {
  const reviewState = config.linear?.reviewState ?? "merged";
  const doneState = config.linear?.doneState ?? "Done";
  const state = loadState(stateFile);

  let promoted = 0;

  for (const entry of state.entries) {
    if (entry.lastSyncedStatus !== reviewState) continue;
    await adapter.transitionIssue(entry.externalId, doneState);
    const comment = buildReleaseComment(version, repoLabel, noteCtx);
    await adapter.commentIssue(entry.externalId, comment);
    const updated = upsertEntry(state, {
      ...entry,
      lastSyncedStatus: doneState,
    });
    Object.assign(state, updated);
    promoted++;
  }

  saveState(stateFile, state);
  return { promoted };
}

function resolveCreateLabels(config: IssueSyncConfig): string[] {
  if (config.tracker === "github" && config.github?.queuedLabel) {
    return [config.github.queuedLabel, "source:autoloop"];
  }
  return [];
}

function buildNoteBody(ctx: NoteContext, task: TaskLike): string {
  const lines: string[] = [];
  if (ctx.runId) lines.push(`**Run:** ${ctx.runId}`);
  if (ctx.role) lines.push(`**Role:** ${ctx.role}`);
  if (ctx.branch) lines.push(`**Branch:** ${ctx.branch}`);
  if (ctx.commitRange) lines.push(`**Commits:** ${ctx.commitRange}`);
  lines.push(`**Task:** ${task.text}`);
  if (ctx.summary) lines.push(`**Summary:** ${ctx.summary}`);
  return lines.join("\n");
}

function buildReleaseComment(
  version: string,
  repoLabel?: string,
  ctx?: NoteContext,
): string {
  const parts = [`Released in **${version}**`];
  if (repoLabel) parts.push(`(${repoLabel})`);
  if (ctx?.runId) parts.push(`— autoloop run: ${ctx.runId}`);
  return parts.join(" ");
}
