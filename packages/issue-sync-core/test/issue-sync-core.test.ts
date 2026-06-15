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
import { closedExternalIds, pull, push, release } from "../src/operations.js";
import { loadState, recordRunStart, takeRunStart } from "../src/state.js";

class FakeAdapter implements TrackerAdapter {
  issues: Map<string, Issue> = new Map();
  transitions: Array<{ id: string; state: string }> = [];
  comments: Array<{ id: string; body: string }> = [];
  archived: string[] = [];
  failTransitions: Set<string> = new Set();
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
    if (this.failTransitions.has(id)) throw new Error(`boom: ${id}`);
    this.transitions.push({ id, state: targetState });
    const issue = this.issues.get(id);
    if (issue) issue.status = targetState;
  }

  async commentIssue(id: string, body: string): Promise<void> {
    this.comments.push({ id, body });
  }

  async archiveIssue(id: string): Promise<void> {
    this.archived.push(id);
  }

  seed(
    id: string,
    title: string,
    status: string,
    branchName?: string,
    identifier?: string,
  ): void {
    this.issues.set(id, { id, title, status, branchName, identifier });
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

  it("branch-based --final: transitions the issue on the run's branch", async () => {
    adapter.seed("i1", "Fix bug A", "Todo", "feat/bug-a");
    await pull(adapter, linearConfig, tasksApi, stateFile);
    // No task marked done — completion comes from the run's branch + --final.
    await push(adapter, linearConfig, tasksApi, stateFile, undefined, {
      currentBranch: "feat/bug-a",
      branchBased: true,
    });
    expect(adapter.transitions).toContainEqual({
      id: "i1",
      state: "In Review",
    });
  });

  it("branch-based: no transition without --final (branchBased false)", async () => {
    adapter.seed("i1", "Fix bug A", "Todo", "feat/bug-a");
    await pull(adapter, linearConfig, tasksApi, stateFile);
    await push(adapter, linearConfig, tasksApi, stateFile, undefined, {
      currentBranch: "feat/bug-a",
      branchBased: false,
    });
    expect(adapter.transitions).toHaveLength(0);
  });

  it("branch-based: does not transition issues on a different branch", async () => {
    adapter.seed("i1", "Fix bug A", "Todo", "feat/bug-a");
    await pull(adapter, linearConfig, tasksApi, stateFile);
    await push(adapter, linearConfig, tasksApi, stateFile, undefined, {
      currentBranch: "some-other-branch",
      branchBased: true,
    });
    expect(adapter.transitions).toHaveLength(0);
  });

  it("commit-reference --final: transitions an issue a run commit references", async () => {
    adapter.seed("i1", "Counter fix", "Todo", undefined, "SAU-22");
    await pull(adapter, linearConfig, tasksApi, stateFile);
    await push(adapter, linearConfig, tasksApi, stateFile, undefined, {
      commitTexts: ["fix(counter): static export overlap (SAU-22)"],
    });
    expect(adapter.transitions).toContainEqual({
      id: "i1",
      state: "In Review",
    });
  });

  it("a failing transition doesn't block others; successes persist", async () => {
    adapter.seed("i1", "A", "Todo");
    adapter.seed("i2", "B", "Todo");
    await pull(adapter, linearConfig, tasksApi, stateFile);
    for (const t of tasksApi.listOpen()) tasksApi.markDone(t.id);
    adapter.failTransitions.add("i1");

    const result = await push(adapter, linearConfig, tasksApi, stateFile);
    expect(result.transitioned).toBe(1);
    expect(adapter.transitions).toContainEqual({
      id: "i2",
      state: "In Review",
    });

    const state = loadState(stateFile);
    expect(
      state.entries.find((e) => e.externalId === "i2")?.lastSyncedStatus,
    ).toBe("In Review");
    expect(
      state.entries.find((e) => e.externalId === "i1")?.lastSyncedStatus,
    ).toBe("Todo");
  });
});

describe("run-start tracking", () => {
  it("records then consumes a run-start sha", async () => {
    const stateFile = makeStateFile();
    await recordRunStart(stateFile, "run-1", "abc123");
    expect(await takeRunStart(stateFile, "run-1")).toBe("abc123");
    expect(await takeRunStart(stateFile, "run-1")).toBeUndefined();
  });

  it("ignores an empty run id", async () => {
    const stateFile = makeStateFile();
    await recordRunStart(stateFile, "", "abc");
    expect(await takeRunStart(stateFile, "")).toBeUndefined();
  });
});

describe("closedExternalIds", () => {
  const entries = [
    {
      taskId: "t1",
      tracker: "linear",
      externalId: "i1",
      lastSyncedStatus: "Todo",
      identifier: "SAU-22",
    },
    {
      taskId: "t2",
      tracker: "linear",
      externalId: "i2",
      lastSyncedStatus: "Todo",
      identifier: "SAU-2",
    },
    {
      taskId: "t3",
      tracker: "github",
      externalId: "42",
      lastSyncedStatus: "open",
      identifier: "#42",
    },
  ];

  it("matches a tagged identifier (conventional-commit trailer)", () => {
    expect(closedExternalIds(entries, ["fix: static export (SAU-22)"])).toEqual(
      ["i1"],
    );
  });

  it("matches a closing keyword", () => {
    const out = closedExternalIds(entries, ["Fixes SAU-2 finally"]);
    expect(out).toContain("i2");
    expect(out).not.toContain("i1");
  });

  it("does NOT match a bare mention (no keyword, no brackets)", () => {
    expect(closedExternalIds(entries, ["see SAU-22; unlike SAU-2"])).toEqual(
      [],
    );
  });

  it("respects boundaries: closes #42 matches, #421 does not", () => {
    expect(closedExternalIds(entries, ["closes #42"])).toContain("42");
    expect(closedExternalIds(entries, ["closes #421"])).not.toContain("42");
  });

  it("returns [] when there are no commits", () => {
    expect(closedExternalIds(entries, [])).toEqual([]);
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

  it("archives promoted issues and returns their branch", async () => {
    adapter.seed("i1", "Fix bug A", "Todo", "feat/bug-a");
    await pull(adapter, linearConfig, tasksApi, stateFile);
    tasksApi.markDone(tasksApi.listOpen()[0].id);
    await push(adapter, linearConfig, tasksApi, stateFile);

    const result = await release(adapter, linearConfig, stateFile, "v1.0.0");
    expect(adapter.archived).toContain("i1");
    expect(result.promotedIssues[0].branchName).toBe("feat/bug-a");
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
