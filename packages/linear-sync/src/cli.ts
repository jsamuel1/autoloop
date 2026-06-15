#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { IssueSyncConfig } from "@mobrienv/autoloop-issue-sync-core";
import {
  createJsonlTasksApi,
  pull,
  push,
  recordRunStart,
  release,
  takeRunStart,
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
  return parseIssueSyncToml(readFileSync(tomlPath, "utf-8"));
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

function git(args: string[]): string | undefined {
  const r = spawnSync("git", args, { encoding: "utf-8" });
  return r.status === 0 && r.stdout ? r.stdout.trim() : undefined;
}

function gitCommitTexts(startSha: string): string[] {
  const r = spawnSync("git", ["log", `${startSha}..HEAD`, "--format=%B%x1e"], {
    encoding: "utf-8",
  });
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout
    .split("\x1e")
    .map((s) => s.trim())
    .filter(Boolean);
}

function tasksFileFor(projectDir: string): string {
  return (
    process.env.AUTOLOOP_TASKS_FILE ??
    join(projectDir, ".autoloop", "tasks.jsonl")
  );
}

async function main() {
  const cliArgs = process.argv.slice(2);
  const subcommand = cliArgs[0];
  const projectDir = process.env.AUTOLOOP_PROJECT_DIR ?? process.cwd();
  const runId = process.env.AUTOLOOP_RUN_ID ?? "";
  const stateFile = join(projectDir, ".autoloop", "issue-sync-state.json");

  if (!subcommand || subcommand === "--help" || subcommand === "help") {
    console.log(
      "Usage: autoloop-linear-sync <pull|push|release> [options]\n" +
        "  pull                       Pull Linear issues into the task queue\n" +
        "  push [--final]             Push completed work to Linear (--final = run end)\n" +
        "  release <version> [--no-archive]   Promote In-Review issues to Done\n" +
        "\nRequires: LINEAR_API_KEY env var",
    );
    process.exit(0);
  }

  const { syncConfig, linearConfig } = loadIssueSyncConfig(projectDir);
  const adapter = new LinearAdapter(linearConfig);
  const tasksApi = createJsonlTasksApi(tasksFileFor(projectDir));
  const noteCtx = {
    runId: runId || undefined,
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
  };

  if (subcommand === "pull") {
    const result = await pull(adapter, syncConfig, tasksApi, stateFile);
    const head = git(["rev-parse", "HEAD"]);
    if (head) await recordRunStart(stateFile, runId, head);
    console.log(`autoloop-linear-sync pull: added ${result.added} issue(s)`);
    for (const it of result.addedIssues) {
      console.log(`  + ${it.identifier ?? it.externalId}  ${it.title}`);
    }
  } else if (subcommand === "push") {
    const final = cliArgs.includes("--final");
    const stopReason = process.env.AUTOLOOP_STOP_REASON;
    const runCompleted = !stopReason || stopReason === "completed";
    const enable = final && runCompleted;
    // Consume this run's start SHA (also prunes it) and scan the commit range.
    const startSha = enable ? await takeRunStart(stateFile, runId) : undefined;
    const commitTexts = startSha ? gitCommitTexts(startSha) : [];
    const result = await push(
      adapter,
      syncConfig,
      tasksApi,
      stateFile,
      noteCtx,
      {
        currentBranch: noteCtx.branch,
        // Hook runs (have a run id) require commits to have landed; a manual
        // `push --final` is explicit operator intent, so branch-match without that gate.
        branchBased: enable && (commitTexts.length > 0 || !runId),
        commitTexts,
      },
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
    const version = cliArgs.slice(1).find((a) => !a.startsWith("--"));
    if (!version) {
      console.error(
        "Usage: autoloop-linear-sync release <version> [--no-archive]",
      );
      process.exit(1);
    }
    const result = await release(
      adapter,
      syncConfig,
      stateFile,
      version,
      syncConfig.linear?.repoLabel,
      noteCtx,
      { archive: !cliArgs.includes("--no-archive") },
    );
    console.log(
      `autoloop-linear-sync release: promoted ${result.promoted} issue(s) to Done`,
    );
    const currentBranch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
    for (const it of result.promotedIssues) {
      console.log(`  ✓ ${it.identifier ?? it.externalId} → Done`);
      // Delete the merged per-issue branch (local, safe: -d only removes if merged;
      // never the current branch).
      if (it.branchName && it.branchName !== currentBranch) {
        const del = spawnSync("git", ["branch", "-d", it.branchName], {
          encoding: "utf-8",
        });
        console.log(
          del.status === 0
            ? `    deleted merged branch ${it.branchName}`
            : `    kept ${it.branchName} (unmerged or absent)`,
        );
      }
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
