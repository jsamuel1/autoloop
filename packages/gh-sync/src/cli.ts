#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  IssueSyncConfig,
  TaskLike,
  TasksApi,
} from "@mobrienv/autoloop-issue-sync-core";
import { pull, push, release } from "@mobrienv/autoloop-issue-sync-core";
import type { GhSyncConfig } from "./adapter.js";
import { GhAdapter } from "./adapter.js";

function loadIssueSyncConfig(projectDir: string): IssueSyncConfig {
  const tomlPath = join(projectDir, ".autoloop", "issue-sync.toml");
  if (!existsSync(tomlPath)) {
    throw new Error(`No .autoloop/issue-sync.toml found in ${projectDir}`);
  }
  const raw = readFileSync(tomlPath, "utf-8");
  return parseIssueSyncToml(raw);
}

function parseIssueSyncToml(raw: string): IssueSyncConfig {
  const repoMatch = raw.match(/^\s*repo\s*=\s*"([^"]+)"/m);
  const labelMatch = raw.match(/^\s*queued_label\s*=\s*"([^"]+)"/m);
  return {
    tracker: "github",
    github: {
      repo: repoMatch?.[1] ?? "",
      queuedLabel: labelMatch?.[1] ?? "autoloop:queued",
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
      const id = `task-${entries.length + 1}`;
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
    console.log("Usage: gh-sync <pull|push|release> [options]");
    console.log(
      "  pull                  Pull issues from GitHub into task queue",
    );
    console.log("  push                  Push completed tasks back to GitHub");
    console.log("  release <version>     Promote In-Review issues to Done");
    process.exit(0);
  }

  const config = loadIssueSyncConfig(projectDir);
  const ghConfig: GhSyncConfig = {
    repo: config.github?.repo ?? "",
    queuedLabel: config.github?.queuedLabel,
  };
  const adapter = new GhAdapter(ghConfig);
  const tasksApi = makeJsonlTasksApi(tasksFile);
  const noteCtx = {
    runId: process.env.AUTOLOOP_RUN_ID,
    branch: getCurrentBranch(),
  };

  if (subcommand === "pull") {
    const result = await pull(adapter, config, tasksApi, stateFile);
    console.log(`gh-sync pull: added ${result.added} issue(s)`);
  } else if (subcommand === "push") {
    const result = await push(adapter, config, tasksApi, stateFile, noteCtx);
    console.log(
      `gh-sync push: transitioned ${result.transitioned}, created ${result.created}`,
    );
  } else if (subcommand === "release") {
    const version = cliArgs[1];
    if (!version) {
      console.error("Usage: gh-sync release <version>");
      process.exit(1);
    }
    const result = await release(
      adapter,
      config,
      stateFile,
      version,
      undefined,
      noteCtx,
    );
    console.log(
      `gh-sync release: promoted ${result.promoted} issue(s) to Done`,
    );
  } else {
    console.error(`Unknown subcommand: ${subcommand}`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`gh-sync error: ${msg}`);
  process.exit(1);
});
