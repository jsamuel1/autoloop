#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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

function runStartFile(projectDir: string): string {
  return join(projectDir, ".autoloop", "issue-sync-runstart.json");
}

// Record HEAD at run start (pre_run/pull), keyed by run id, so push --final can scan
// the commits this run produced.
function recordRunStart(projectDir: string, runId: string): void {
  if (!runId) return;
  const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" });
  if (head.status !== 0 || !head.stdout) return;
  const file = runStartFile(projectDir);
  let map: Record<string, string> = {};
  if (existsSync(file)) {
    try {
      map = JSON.parse(readFileSync(file, "utf-8")) as Record<string, string>;
    } catch {
      map = {};
    }
  }
  map[runId] = head.stdout.trim();
  // Cap growth: keep the most recent 50 run entries.
  const keys = Object.keys(map);
  if (keys.length > 50) {
    for (const k of keys.slice(0, keys.length - 50)) delete map[k];
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(map, null, 2)}\n`, "utf-8");
}

// Drop a run's start SHA once push --final has consumed it, so the file stays small.
function pruneRunStart(projectDir: string, runId: string): void {
  if (!runId) return;
  const file = runStartFile(projectDir);
  if (!existsSync(file)) return;
  let map: Record<string, string> = {};
  try {
    map = JSON.parse(readFileSync(file, "utf-8")) as Record<string, string>;
  } catch {
    return;
  }
  if (!(runId in map)) return;
  delete map[runId];
  writeFileSync(file, `${JSON.stringify(map, null, 2)}\n`, "utf-8");
}

// Commit messages produced since this run started (runStartSha..HEAD).
function commitTextsForRun(projectDir: string, runId: string): string[] {
  if (!runId) return [];
  const file = runStartFile(projectDir);
  if (!existsSync(file)) return [];
  let start: string | undefined;
  try {
    start = (JSON.parse(readFileSync(file, "utf-8")) as Record<string, string>)[
      runId
    ];
  } catch {
    return [];
  }
  if (!start) return [];
  const r = spawnSync("git", ["log", `${start}..HEAD`, "--format=%B%x1e"], {
    encoding: "utf-8",
  });
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout
    .split("\x1e")
    .map((s) => s.trim())
    .filter(Boolean);
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
    console.log("Usage: autoloop-gh-sync <pull|push|release> [options]");
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
    recordRunStart(projectDir, process.env.AUTOLOOP_RUN_ID ?? "");
    console.log(`autoloop-gh-sync pull: added ${result.added} issue(s)`);
    for (const it of result.addedIssues) {
      console.log(`  + ${it.identifier ?? it.externalId}  ${it.title}`);
    }
  } else if (subcommand === "push") {
    const final = cliArgs.includes("--final");
    // Reference-based transition: run end (--final) + run completed + commits landed.
    const stopReason = process.env.AUTOLOOP_STOP_REASON;
    const runCompleted = !stopReason || stopReason === "completed";
    const enable = final && runCompleted;
    const commitTexts = enable
      ? commitTextsForRun(projectDir, process.env.AUTOLOOP_RUN_ID ?? "")
      : [];
    const result = await push(adapter, config, tasksApi, stateFile, noteCtx, {
      currentBranch: noteCtx.branch,
      branchBased: enable && commitTexts.length > 0,
      commitTexts,
    });
    console.log(
      `autoloop-gh-sync push: transitioned ${result.transitioned}, created ${result.created}`,
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
    if (final) pruneRunStart(projectDir, process.env.AUTOLOOP_RUN_ID ?? "");
  } else if (subcommand === "release") {
    const version = cliArgs[1];
    if (!version) {
      console.error("Usage: autoloop-gh-sync release <version>");
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
      `autoloop-gh-sync release: promoted ${result.promoted} issue(s) to Done`,
    );
    for (const it of result.promotedIssues) {
      console.log(`  ✓ ${it.identifier ?? it.externalId} → Done`);
      // Delete the merged per-issue branch (local, safe: -d only removes if merged).
      if (it.branchName) {
        const del = spawnSync("git", ["branch", "-d", it.branchName], {
          encoding: "utf-8",
        });
        if (del.status === 0) {
          console.log(`    deleted merged branch ${it.branchName}`);
        }
      }
    }
  } else {
    console.error(`Unknown subcommand: ${subcommand}`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`autoloop-gh-sync error: ${msg}`);
  process.exit(1);
});
