import { spawnSync } from "node:child_process";
import { appendEvent } from "@mobrienv/autoloop-core/journal";
import { log } from "./display.js";
import type { LoopContext } from "./types.js";

export interface HookEnv {
  AUTOLOOP_PROJECT_DIR: string;
  AUTOLOOP_RUN_ID: string;
  AUTOLOOP_PRESET: string;
  AUTOLOOP_TASKS_FILE: string;
  AUTOLOOP_ITERATION?: string;
  AUTOLOOP_GIT_SHA_BEFORE?: string;
  AUTOLOOP_GIT_SHA_AFTER?: string;
}

export function buildHookEnv(
  loop: LoopContext,
  extra?: { iteration?: number; gitShaBefore?: string; gitShaAfter?: string },
): HookEnv {
  const env: HookEnv = {
    AUTOLOOP_PROJECT_DIR: loop.paths.projectDir,
    AUTOLOOP_RUN_ID: loop.runtime.runId,
    AUTOLOOP_PRESET: loop.launch.preset,
    AUTOLOOP_TASKS_FILE: loop.paths.tasksFile,
  };
  if (extra?.iteration !== undefined) {
    env.AUTOLOOP_ITERATION = String(extra.iteration);
  }
  if (extra?.gitShaBefore !== undefined) {
    env.AUTOLOOP_GIT_SHA_BEFORE = extra.gitShaBefore;
  }
  if (extra?.gitShaAfter !== undefined) {
    env.AUTOLOOP_GIT_SHA_AFTER = extra.gitShaAfter;
  }
  return env;
}

export function captureGitSha(cwd: string): string {
  try {
    const result = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf-8",
    });
    if (result.status === 0 && result.stdout) {
      return result.stdout.trim();
    }
  } catch {
    /* not a git repo or git not available — return empty */
  }
  return "";
}

export function runHook(
  loop: LoopContext,
  name: string,
  cmd: string,
  hookEnv: HookEnv,
  iteration?: string,
): void {
  if (!cmd) return;

  log(loop, "debug", `hook ${name} start cmd=${JSON.stringify(cmd)}`);

  const env: Record<string, string | undefined> = { ...process.env };
  for (const [k, v] of Object.entries(hookEnv)) {
    if (v !== undefined) env[k] = v;
  }

  const result = spawnSync(cmd, {
    shell: true,
    cwd: loop.paths.workDir,
    encoding: "utf-8",
    env,
  });

  const combined =
    (result.stdout ?? "") +
    (result.stderr ? `\n[stderr]\n${result.stderr}` : "");

  appendEvent(
    loop.paths.journalFile,
    loop.runtime.runId,
    iteration ?? "",
    "hook.output",
    `"hook": ${JSON.stringify(name)}, "exit_code": ${result.status ?? -1}, "output": ${JSON.stringify(combined.trim())}`,
  );

  const failed = result.status !== 0 || result.error;
  if (failed) {
    const msg = `hook ${name} failed (exit ${result.status ?? -1}): ${result.error?.message ?? combined.trim().split("\n")[0] ?? ""}`;
    log(loop, "warn", msg);
    if (loop.hooks.strict && name === "pre_run") {
      throw new Error(`Aborting run: ${msg}`);
    }
  } else {
    log(loop, "debug", `hook ${name} ok`);
  }
}
