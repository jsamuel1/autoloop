#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { IssueSyncConfig } from "@mobrienv/autoloop-issue-sync-core";
import {
  pull,
  push,
  release,
  type TaskLike,
  type TasksApi,
} from "@mobrienv/autoloop-issue-sync-core";
import type { LinearSyncConfig } from "./adapter.js";
import { LinearAdapter } from "./adapter.js";

function loadIssueSyncConfig(projectDir: string): {
  syncConfig: IssueSyncConfig;
  linearConfig: LinearSyncConfig;
} {
  const tomlPath = join(projectDir, ".autoloop", "issue-sync.toml");
  if (!existsSync(tomlPath)) {
    throw new Error(`No .autoloop/issue-sync.toml found in ${projectDir}`);
  }
  const raw = readFileSync(tomlPath, "utf-8");
  return parseIssueSyncToml(raw);
}

function parseIssueSyncToml(raw: string): {
  syncConfig: IssueSyncConfig;
  linearConfig: LinearSyncConfig;
} {
  const projectMatch = raw.match(/^\s*project\s*=\s*"([^"]+)"/m);
  const teamMatch = raw.match(/^\s*team\s*=\s*"([^"]+)"/m);
  const repoLabelMatch = raw.match(/^\s*repo_label\s*=\s*"([^"]+)"/m);
  const pullStatesMatch = raw.match(/^\s*pull_states\s*=\s*\[([^\]]+)\]/m);
  const reviewStateMatch = raw.match(/^\s*review_state\s*=\s*"([^"]+)"/m);
  const doneStateMatch = raw.match(/^\s*done_state\s*=\s*"([^"]+)"/m);

  const pullStates = pullStatesMatch
    ? pullStatesMatch[1]
        .split(",")
        .map((s) => s.trim().replace(/^"|"$/g, ""))
        .filter(Boolean)
    : ["Todo"];

  return {
    syncConfig: {
      tracker: "linear",
      linear: {
        project: projectMatch?.[1],
        team: teamMatch?.[1],
        repoLabel: repoLabelMatch?.[1],
        pullStates,
        reviewState: reviewStateMatch?.[1] ?? "In Review",
        doneState: doneStateMatch?.[1] ?? "Done",
      },
    },
    linearConfig: {
      apiKey: process.env.LINEAR_API_KEY ?? "",
      teamKey: teamMatch?.[1],
      projectName: projectMatch?.[1],
      repoLabel: repoLabelMatch?.[1],
    },
  };
}

function getCurrentBranch(): string | undefined {
  const result = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    encoding: "utf-8",
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function makeTasksFile(projectDir: string): string {
  return (
    process.env.AUTOLOOP_TASKS_FILE ??
    join(projectDir, ".autoloop", "tasks.jsonl")
  );
}

function makeJsonlTasksApi(tasksFile: string): TasksApi {
  function readEntries(): TaskLike[] {
    if (!existsSync(tasksFile)) return [];
    const lines = readFileSync(tasksFile, "utf-8").split("\n").filter(Boolean);
    const byId = new Map<string, TaskLike>();
    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as {
          id: string;
          type: string;
          text?: string;
          status?: string;
          source?: string;
          target_id?: string;
        };
        if (obj.type === "task") {
          byId.set(obj.id, {
            id: obj.id,
            text: obj.text ?? "",
            status: obj.status === "done" ? "done" : "open",
            source: obj.source ?? "manual",
          });
        } else if (obj.type === "task-tombstone" && obj.target_id) {
          byId.delete(obj.target_id);
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
    addTask: (text: string, source: string): string => {
      const entries = readEntries();
      // Use max(existing N)+1, not count+1 — the latter collides with reused/non-sequential ids.
      const maxN = entries.reduce((m, t) => {
        const match = /^task-(\d+)$/.exec(t.id);
        return match ? Math.max(m, Number(match[1])) : m;
      }, 0);
      const id = `task-${maxN + 1}`;
      const line = JSON.stringify({
        id,
        type: "task",
        text,
        status: "open",
        source,
        created: new Date().toISOString(),
      });
      mkdirSync(dirname(tasksFile), { recursive: true });
      appendFileSync(tasksFile, `${line}\n`, "utf-8");
      return id;
    },
  };
}

async function main() {
  const cliArgs = process.argv.slice(2);
  const subcommand = cliArgs[0];
  const projectDir = process.env.AUTOLOOP_PROJECT_DIR ?? process.cwd();
  const stateFile = join(projectDir, ".autoloop", "issue-sync-state.json");
  const tasksFile = makeTasksFile(projectDir);

  if (!subcommand || subcommand === "--help" || subcommand === "help") {
    console.log(
      "Usage: autoloop-linear-sync <pull|push|release> [options]\n" +
        "  pull                  Pull Linear issues into task queue\n" +
        "  push                  Push completed tasks to Linear\n" +
        "  release <version>     Promote In-Review issues to Done\n" +
        "\nRequires: LINEAR_API_KEY env var",
    );
    process.exit(0);
  }

  const { syncConfig, linearConfig } = loadIssueSyncConfig(projectDir);
  const adapter = new LinearAdapter(linearConfig);
  const tasksApi = makeJsonlTasksApi(tasksFile);
  const noteCtx = {
    runId: process.env.AUTOLOOP_RUN_ID,
    branch: getCurrentBranch(),
  };

  if (subcommand === "pull") {
    const result = await pull(adapter, syncConfig, tasksApi, stateFile);
    console.log(`autoloop-linear-sync pull: added ${result.added} issue(s)`);
    for (const it of result.addedIssues) {
      console.log(`  + ${it.identifier ?? it.externalId}  ${it.title}`);
    }
  } else if (subcommand === "push") {
    const result = await push(
      adapter,
      syncConfig,
      tasksApi,
      stateFile,
      noteCtx,
    );
    console.log(
      `autoloop-linear-sync push: transitioned ${result.transitioned}, created ${result.created}`,
    );
    for (const it of result.transitionedIssues) {
      console.log(
        `  → ${it.identifier ?? it.externalId} → ${it.to}  ${it.title}`,
      );
    }
    for (const it of result.createdIssues) {
      console.log(
        `  + ${it.identifier ?? it.externalId} (created)  ${it.title}`,
      );
    }
  } else if (subcommand === "release") {
    const version = cliArgs[1];
    if (!version) {
      console.error("Usage: autoloop-linear-sync release <version>");
      process.exit(1);
    }
    const result = await release(
      adapter,
      syncConfig,
      stateFile,
      version,
      syncConfig.linear?.repoLabel,
      noteCtx,
    );
    console.log(
      `autoloop-linear-sync release: promoted ${result.promoted} issue(s) to Done`,
    );
    for (const it of result.promotedIssues) {
      console.log(`  ✓ ${it.identifier ?? it.externalId} → Done`);
    }
  } else {
    console.error(`Unknown subcommand: ${subcommand}`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`autoloop-linear-sync error: ${msg}`);
  process.exit(1);
});
