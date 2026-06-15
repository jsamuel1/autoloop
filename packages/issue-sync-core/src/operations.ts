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

export interface SyncedIssue {
  externalId: string;
  identifier?: string;
  title: string;
}
export interface TransitionedIssue extends SyncedIssue {
  to: string;
}
export interface PullResult {
  added: number;
  addedIssues: SyncedIssue[];
}
export interface PushResult {
  transitioned: number;
  created: number;
  transitionedIssues: TransitionedIssue[];
  createdIssues: SyncedIssue[];
}
export interface ReleaseResult {
  promoted: number;
  promotedIssues: Array<{ externalId: string; identifier?: string }>;
}

export async function pull(
  adapter: TrackerAdapter,
  config: IssueSyncConfig,
  tasksApi: TasksApi,
  stateFile: string,
): Promise<PullResult> {
  const tracker = config.tracker;
  const pullStates =
    config.linear?.pullStates ?? (config.github ? ["open"] : ["Todo"]);
  const state = loadState(stateFile);

  const issues = await adapter.listIssues(pullStates);
  const addedIssues: SyncedIssue[] = [];

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
      identifier: issue.identifier,
    });
    Object.assign(state, newState);
    addedIssues.push({
      externalId: issue.id,
      identifier: issue.identifier,
      title: issue.title,
    });
  }

  saveState(stateFile, state);
  return { added: addedIssues.length, addedIssues };
}

export async function push(
  adapter: TrackerAdapter,
  config: IssueSyncConfig,
  tasksApi: TasksApi,
  stateFile: string,
  noteCtx?: NoteContext,
): Promise<PushResult> {
  const tracker = config.tracker;
  const reviewState = config.linear?.reviewState ?? "merged";
  const state = loadState(stateFile);

  const doneTasks = tasksApi.listDone();
  const transitionedIssues: TransitionedIssue[] = [];
  const createdIssues: SyncedIssue[] = [];

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
      transitionedIssues.push({
        externalId: mapped.externalId,
        identifier: mapped.identifier,
        title: task.text,
        to: reviewState,
      });
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
        identifier: issue.identifier,
      });
      Object.assign(state, newState);
      createdIssues.push({
        externalId: issue.id,
        identifier: issue.identifier,
        title: task.text,
      });
    }
  }

  saveState(stateFile, state);
  return {
    transitioned: transitionedIssues.length,
    created: createdIssues.length,
    transitionedIssues,
    createdIssues,
  };
}

export async function release(
  adapter: TrackerAdapter,
  config: IssueSyncConfig,
  stateFile: string,
  version: string,
  repoLabel?: string,
  noteCtx?: NoteContext,
): Promise<ReleaseResult> {
  const reviewState = config.linear?.reviewState ?? "merged";
  const doneState = config.linear?.doneState ?? "Done";
  const state = loadState(stateFile);

  const promotedIssues: Array<{ externalId: string; identifier?: string }> = [];

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
    promotedIssues.push({
      externalId: entry.externalId,
      identifier: entry.identifier,
    });
  }

  saveState(stateFile, state);
  return { promoted: promotedIssues.length, promotedIssues };
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
