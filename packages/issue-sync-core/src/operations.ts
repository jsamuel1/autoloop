import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TrackerAdapter } from "./adapter.js";
import type { IssueSyncConfig } from "./config.js";
import {
  findByExternalId,
  findByTaskId,
  loadState,
  type SyncEntry,
  saveState,
  upsertEntry,
  withStateLock,
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

/**
 * External ids of mapped entries that a commit message marks as DONE — either via a
 * closing keyword (fixes/closes/resolves <id>) or a trailing tag form ((id) / [id]).
 * A bare mention ("see SAU-19", "unlike SAU-13") does NOT match, to avoid moving
 * issues a commit merely references. Word/bracket bounded so SAU-2 ≠ SAU-22.
 */
export function closedExternalIds(
  entries: SyncEntry[],
  commitTexts: string[],
): string[] {
  if (commitTexts.length === 0) return [];
  const blob = commitTexts.join("\n");
  const matched: string[] = [];
  for (const e of entries) {
    if (!e.identifier) continue;
    const id = e.identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const closing = new RegExp(
      `\\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\\b[\\s:#]*${id}(?![\\w-])`,
      "i",
    );
    const tagged = new RegExp(`[([]${id}[)\\]]`);
    if (closing.test(blob) || tagged.test(blob)) matched.push(e.externalId);
  }
  return matched;
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
  promotedIssues: Array<{
    externalId: string;
    identifier?: string;
    branchName?: string;
  }>;
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

  const issues = await adapter.listIssues(pullStates);

  return withStateLock(stateFile, () => {
    let state = loadState(stateFile);
    const addedIssues: SyncedIssue[] = [];
    for (const issue of issues) {
      if (findByExternalId(state, tracker, issue.id)) continue;
      const taskId = tasksApi.addTask(
        issue.title,
        sourceTag(tracker, issue.id),
      );
      state = upsertEntry(state, {
        taskId,
        tracker,
        externalId: issue.id,
        lastSyncedStatus: issue.status,
        branchName: issue.branchName,
        identifier: issue.identifier,
        title: issue.title,
      });
      addedIssues.push({
        externalId: issue.id,
        identifier: issue.identifier,
        title: issue.title,
      });
    }
    saveState(stateFile, state);
    return { added: addedIssues.length, addedIssues };
  });
}

export async function push(
  adapter: TrackerAdapter,
  config: IssueSyncConfig,
  tasksApi: TasksApi,
  stateFile: string,
  noteCtx?: NoteContext,
  opts?: {
    currentBranch?: string;
    branchBased?: boolean;
    commitTexts?: string[];
  },
): Promise<PushResult> {
  const tracker = config.tracker;
  const reviewState = config.linear?.reviewState ?? "merged";
  const doneState = config.linear?.doneState ?? "Done";

  return withStateLock(stateFile, async () => {
    let state = loadState(stateFile);
    const transitionedIssues: TransitionedIssue[] = [];
    const createdIssues: SyncedIssue[] = [];

    // 1. Completed tasks: transition the mapped issue, or create one for local-origin tasks.
    for (const task of tasksApi.listDone()) {
      const mapped = findByTaskId(state, task.id);
      try {
        if (mapped) {
          if (mapped.lastSyncedStatus === reviewState) continue;
          await adapter.transitionIssue(mapped.externalId, reviewState);
          if (noteCtx) {
            await adapter.commentIssue(
              mapped.externalId,
              buildNoteBody(noteCtx, task),
            );
          }
          state = upsertEntry(state, {
            ...mapped,
            lastSyncedStatus: reviewState,
          });
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
          state = upsertEntry(state, {
            taskId: task.id,
            tracker,
            externalId: issue.id,
            lastSyncedStatus: issue.status,
            identifier: issue.identifier,
            title: task.text,
            branchName: issue.branchName,
          });
          createdIssues.push({
            externalId: issue.id,
            identifier: issue.identifier,
            title: task.text,
          });
        }
      } catch {
        // Leave this issue un-synced; it retries next run. Persist the rest.
      }
    }

    // 2. Reference-based transition (push --final, caller-gated on a completed run):
    // the issue's branch is the run's branch, or a commit in the run closed its id.
    const refIds = new Set<string>();
    if (opts?.branchBased && opts.currentBranch) {
      for (const e of state.entries) {
        if (e.branchName === opts.currentBranch) refIds.add(e.externalId);
      }
    }
    for (const id of closedExternalIds(
      state.entries,
      opts?.commitTexts ?? [],
    )) {
      refIds.add(id);
    }
    const done = new Set(transitionedIssues.map((t) => t.externalId));
    for (const externalId of refIds) {
      if (done.has(externalId)) continue;
      const entry = state.entries.find((e) => e.externalId === externalId);
      if (!entry) continue;
      if (
        entry.lastSyncedStatus === reviewState ||
        entry.lastSyncedStatus === doneState
      )
        continue;
      try {
        await adapter.transitionIssue(externalId, reviewState);
        if (noteCtx) {
          await adapter.commentIssue(
            externalId,
            buildNoteBody(noteCtx, {
              id: entry.taskId,
              text: entry.title ?? entry.identifier ?? externalId,
              status: "done",
              source: sourceTag(tracker, externalId),
            }),
          );
        }
        state = upsertEntry(state, { ...entry, lastSyncedStatus: reviewState });
        done.add(externalId);
        transitionedIssues.push({
          externalId,
          identifier: entry.identifier,
          title: entry.title ?? "",
          to: reviewState,
        });
      } catch {
        // Skip; retried next run.
      }
    }

    saveState(stateFile, state);
    return {
      transitioned: transitionedIssues.length,
      created: createdIssues.length,
      transitionedIssues,
      createdIssues,
    };
  });
}

export async function release(
  adapter: TrackerAdapter,
  config: IssueSyncConfig,
  stateFile: string,
  version: string,
  repoLabel?: string,
  noteCtx?: NoteContext,
  opts?: { archive?: boolean },
): Promise<ReleaseResult> {
  const reviewState = config.linear?.reviewState ?? "merged";
  const doneState = config.linear?.doneState ?? "Done";
  const archive = opts?.archive !== false;

  return withStateLock(stateFile, async () => {
    let state = loadState(stateFile);
    const promotedIssues: ReleaseResult["promotedIssues"] = [];
    for (const entry of state.entries) {
      if (entry.lastSyncedStatus !== reviewState) continue;
      try {
        await adapter.transitionIssue(entry.externalId, doneState);
        await adapter.commentIssue(
          entry.externalId,
          buildReleaseComment(version, repoLabel, noteCtx),
        );
        if (archive && adapter.archiveIssue) {
          await adapter.archiveIssue(entry.externalId);
        }
        state = upsertEntry(state, { ...entry, lastSyncedStatus: doneState });
        promotedIssues.push({
          externalId: entry.externalId,
          identifier: entry.identifier,
          branchName: entry.branchName,
        });
      } catch {
        // Leave un-promoted; retried on the next release. Persist the rest.
      }
    }
    saveState(stateFile, state);
    return { promoted: promotedIssues.length, promotedIssues };
  });
}

/**
 * A TasksApi backed by autoloop's append-only `.autoloop/tasks.jsonl`. Shared by the
 * tracker CLIs so the format/ID logic lives in one place.
 */
export function createJsonlTasksApi(tasksFile: string): TasksApi {
  function readEntries(): TaskLike[] {
    if (!existsSync(tasksFile)) return [];
    const byId = new Map<string, TaskLike>();
    for (const line of readFileSync(tasksFile, "utf-8").split("\n")) {
      if (!line) continue;
      try {
        const o = JSON.parse(line) as {
          id: string;
          type: string;
          text?: string;
          status?: string;
          source?: string;
          target_id?: string;
        };
        if (o.type === "task") {
          byId.set(o.id, {
            id: o.id,
            text: o.text ?? "",
            status: o.status === "done" ? "done" : "open",
            source: o.source ?? "manual",
          });
        } else if (o.type === "task-tombstone" && o.target_id) {
          byId.delete(o.target_id);
        }
      } catch {
        /* skip malformed lines */
      }
    }
    return [...byId.values()];
  }

  return {
    listOpen: () => readEntries().filter((t) => t.status === "open"),
    listDone: () => readEntries().filter((t) => t.status === "done"),
    addTask: (text, source) => {
      const entries = readEntries();
      // max(existing N)+1, not count+1 — avoids colliding with reused ids.
      const maxN = entries.reduce((m, t) => {
        const match = /^task-(\d+)$/.exec(t.id);
        return match ? Math.max(m, Number(match[1])) : m;
      }, 0);
      const id = `task-${maxN + 1}`;
      mkdirSync(dirname(tasksFile), { recursive: true });
      appendFileSync(
        tasksFile,
        `${JSON.stringify({
          id,
          type: "task",
          text,
          status: "open",
          source,
          created: new Date().toISOString(),
        })}\n`,
        "utf-8",
      );
      return id;
    },
  };
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
