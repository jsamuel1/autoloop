import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  CreateIssueInput,
  Issue,
  TrackerAdapter,
} from "../src/adapter.js";
import type { IssueSyncConfig } from "../src/config.js";
import type { TaskLike, TasksApi } from "../src/operations.js";
import { pull, push, release } from "../src/operations.js";
import { loadState } from "../src/state.js";

class FakeAdapter implements TrackerAdapter {
  issues: Map<string, Issue> = new Map();
  transitions: Array<{ id: string; state: string }> = [];
  comments: Array<{ id: string; body: string }> = [];
  nextId = 1;

  async listIssues(states: string[]): Promise<Issue[]> {
    return [...this.issues.values()].filter((i) => states.includes(i.status));
  }

  async createIssue(input: CreateIssueInput): Promise<Issue> {
    const id = `issue-${this.nextId++}`;
    const issue: Issue = { id, title: input.title, status: "Todo" };
    this.issues.set(id, issue);
    return issue;
  }

  async transitionIssue(id: string, targetState: string): Promise<void> {
    this.transitions.push({ id, state: targetState });
    const issue = this.issues.get(id);
    if (issue) issue.status = targetState;
  }

  async commentIssue(id: string, body: string): Promise<void> {
    this.comments.push({ id, body });
  }

  seed(id: string, title: string, status: string): void {
    this.issues.set(id, { id, title, status });
  }
}

class FakeTasksApi implements TasksApi {
  private tasks: TaskLike[] = [];
  private nextId = 1;

  listOpen(): TaskLike[] {
    return this.tasks.filter((t) => t.status === "open");
  }

  listDone(): TaskLike[] {
    return this.tasks.filter((t) => t.status === "done");
  }

  addTask(text: string, source: string): string {
    const id = `task-${this.nextId++}`;
    this.tasks.push({ id, text, status: "open", source });
    return id;
  }

  markDone(id: string): void {
    const t = this.tasks.find((t) => t.id === id);
    if (t) t.status = "done";
  }
}

function makeStateFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "issue-sync-test-"));
  mkdirSync(join(dir, ".autoloop"), { recursive: true });
  return join(dir, ".autoloop", "issue-sync-state.json");
}

const linearConfig: IssueSyncConfig = {
  tracker: "linear",
  linear: { pullStates: ["Todo"], reviewState: "In Review", doneState: "Done" },
};

describe("pull", () => {
  let adapter: FakeAdapter;
  let tasksApi: FakeTasksApi;
  let stateFile: string;

  beforeEach(() => {
    adapter = new FakeAdapter();
    tasksApi = new FakeTasksApi();
    stateFile = makeStateFile();
  });

  it("adds new issues as tasks", async () => {
    adapter.seed("i1", "Fix bug A", "Todo");
    const result = await pull(adapter, linearConfig, tasksApi, stateFile);
    expect(result.added).toBe(1);
    expect(tasksApi.listOpen()).toHaveLength(1);
    expect(tasksApi.listOpen()[0].text).toBe("Fix bug A");
  });

  it("sets source tag on pulled tasks", async () => {
    adapter.seed("i1", "Fix bug A", "Todo");
    await pull(adapter, linearConfig, tasksApi, stateFile);
    expect(tasksApi.listOpen()[0].source).toBe("linear:i1");
  });

  it("deduplicates: same issue not pulled twice", async () => {
    adapter.seed("i1", "Fix bug A", "Todo");
    await pull(adapter, linearConfig, tasksApi, stateFile);
    await pull(adapter, linearConfig, tasksApi, stateFile);
    expect(tasksApi.listOpen()).toHaveLength(1);
  });

  it("persists mapping to state file", async () => {
    adapter.seed("i1", "Fix bug A", "Todo");
    await pull(adapter, linearConfig, tasksApi, stateFile);
    const state = loadState(stateFile);
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0].externalId).toBe("i1");
    expect(state.entries[0].tracker).toBe("linear");
  });

  it("skips issues not in pull states", async () => {
    adapter.seed("i1", "Done issue", "Done");
    const result = await pull(adapter, linearConfig, tasksApi, stateFile);
    expect(result.added).toBe(0);
  });
});

describe("push", () => {
  let adapter: FakeAdapter;
  let tasksApi: FakeTasksApi;
  let stateFile: string;

  beforeEach(() => {
    adapter = new FakeAdapter();
    tasksApi = new FakeTasksApi();
    stateFile = makeStateFile();
  });

  it("transitions mapped issue to In Review on task completion", async () => {
    adapter.seed("i1", "Fix bug A", "Todo");
    await pull(adapter, linearConfig, tasksApi, stateFile);
    const taskId = tasksApi.listOpen()[0].id;
    tasksApi.markDone(taskId);

    await push(adapter, linearConfig, tasksApi, stateFile);
    expect(adapter.transitions).toContainEqual({
      id: "i1",
      state: "In Review",
    });
  });

  it("creates a tracker issue for unmapped done tasks", async () => {
    tasksApi.addTask("autoqa finding: missing null check", "autoqa");
    tasksApi.markDone("task-1");

    const result = await push(adapter, linearConfig, tasksApi, stateFile);
    expect(result.created).toBe(1);
    expect(adapter.issues.size).toBe(1);
  });

  it("records new mapping for created issues", async () => {
    tasksApi.addTask("autoqa finding: missing null check", "autoqa");
    tasksApi.markDone("task-1");

    await push(adapter, linearConfig, tasksApi, stateFile);
    const state = loadState(stateFile);
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0].taskId).toBe("task-1");
  });

  it("idempotent: does not re-transition already-reviewed issues", async () => {
    adapter.seed("i1", "Fix bug A", "Todo");
    await pull(adapter, linearConfig, tasksApi, stateFile);
    const taskId = tasksApi.listOpen()[0].id;
    tasksApi.markDone(taskId);

    await push(adapter, linearConfig, tasksApi, stateFile);
    await push(adapter, linearConfig, tasksApi, stateFile);
    const reviewTransitions = adapter.transitions.filter(
      (t) => t.state === "In Review",
    );
    expect(reviewTransitions).toHaveLength(1);
  });

  it("posts a comment with note context when provided", async () => {
    adapter.seed("i1", "Fix bug A", "Todo");
    await pull(adapter, linearConfig, tasksApi, stateFile);
    tasksApi.markDone(tasksApi.listOpen()[0].id);

    await push(adapter, linearConfig, tasksApi, stateFile, {
      runId: "run-123",
      branch: "feat/bug-a",
    });
    expect(adapter.comments).toHaveLength(1);
    expect(adapter.comments[0].body).toContain("run-123");
  });
});

describe("release", () => {
  let adapter: FakeAdapter;
  let tasksApi: FakeTasksApi;
  let stateFile: string;

  beforeEach(() => {
    adapter = new FakeAdapter();
    tasksApi = new FakeTasksApi();
    stateFile = makeStateFile();
  });

  it("promotes In Review issues to Done", async () => {
    adapter.seed("i1", "Fix bug A", "Todo");
    await pull(adapter, linearConfig, tasksApi, stateFile);
    tasksApi.markDone(tasksApi.listOpen()[0].id);
    await push(adapter, linearConfig, tasksApi, stateFile);

    const result = await release(adapter, linearConfig, stateFile, "v1.0.0");
    expect(result.promoted).toBe(1);
    expect(adapter.transitions).toContainEqual({ id: "i1", state: "Done" });
  });

  it("posts a version comment on release", async () => {
    adapter.seed("i1", "Fix bug A", "Todo");
    await pull(adapter, linearConfig, tasksApi, stateFile);
    tasksApi.markDone(tasksApi.listOpen()[0].id);
    await push(adapter, linearConfig, tasksApi, stateFile);
    await release(adapter, linearConfig, stateFile, "v1.0.0");

    const releaseComment = adapter.comments.find((c) =>
      c.body.includes("v1.0.0"),
    );
    expect(releaseComment).toBeDefined();
  });

  it("idempotent: does not promote already-Done issues", async () => {
    adapter.seed("i1", "Fix bug A", "Todo");
    await pull(adapter, linearConfig, tasksApi, stateFile);
    tasksApi.markDone(tasksApi.listOpen()[0].id);
    await push(adapter, linearConfig, tasksApi, stateFile);
    await release(adapter, linearConfig, stateFile, "v1.0.0");
    await release(adapter, linearConfig, stateFile, "v1.0.0");

    const doneTransitions = adapter.transitions.filter(
      (t) => t.state === "Done",
    );
    expect(doneTransitions).toHaveLength(1);
  });

  it("skips issues not in review state", async () => {
    adapter.seed("i1", "Fix bug A", "Todo");
    await pull(adapter, linearConfig, tasksApi, stateFile);

    const result = await release(adapter, linearConfig, stateFile, "v1.0.0");
    expect(result.promoted).toBe(0);
  });
});
