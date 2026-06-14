# Autoloop ↔ Issue Tracker Sync — Design

**Date:** 2026-06-14
**Status:** Approved (design); pending implementation plan
**Repo:** `jsamuel1/autoloop` (fork)

## Problem

Autoloop's task queue is a local append-only JSONL file (`.autoloop/tasks.jsonl`),
injected into every iteration's prompt by the harness. There is no integration with
any external issue tracker. We want autoloop runs to be **driven by tracker issues**
(Linear today; GitHub as a second reference) and to **report progress back** — so a
loop can pull its work from a tracker, mark issues as work proceeds, and file new
issues that roles like autoqa/autoreview discover.

This must work **headless** (invoked from a hook during a run), with no always-on
daemon.

## Goals

- Pull tracker issues → seed `.autoloop/tasks.jsonl` before/while a loop runs.
- Push completion → transition the matching issue and post implementation notes.
- Create new tracker issues for locally-originated tasks (autoqa/autoreview findings).
- Be tracker-agnostic at the core; ship two adapters (Linear via MCP, GitHub via `gh`).
- Add a **generic, reusable hook mechanism** to autoloop — not a Linear-specific bolt-on.

## Non-goals

- No always-on daemon / webhook listener (explicitly out of scope; manual CLI + hooks only).
- No auto-detection of releases from CHANGELOG/tags — release promotion is an explicit command.
- No plugin-registry/discovery system in autoloop.

## Architecture

Three components — two generic, one per tracker:

```
autoloop (fork)
  harness loop ──fires──▶ [hooks]  (NEW, generic feature)
                            pre_run · pre_iteration · post_iteration · post_run
                            each hook = a configured shell command + env context
                                 │ invokes
                ┌────────────────┴───────────────┐
                ▼                                 ▼
   packages/linear-sync                packages/gh-sync   (reference impl, built first)
   (MCP client → mcp.linear.app)       (wraps `gh` CLI)
                └──────────── share ──────────────┘
                  packages/issue-sync-core
                  · task ↔ issue mapping + state file
                  · pull / push / release semantics
                  · source-tag convention
```

- **`issue-sync-core`** — tracker-agnostic. Reads/writes `.autoloop/tasks.jsonl` via
  autoloop's task API, owns the task↔issue map and the pull/push/release behavior.
  Knows nothing about Linear or GitHub.
- **Adapters** implement one small interface — `listIssues()`, `createIssue()`,
  `transitionIssue()`, `commentIssue()`. `linear-sync` over MCP; `gh-sync` over `gh`.
  Each exposes `pull` / `push` / `release` subcommands (thin wrappers over the core).
- **autoloop `[hooks]`** — a new generic capability: configurable shell commands fired
  at four lifecycle points with run context as env vars. Reusable beyond issue sync.

Components are isolated: the hook feature has zero tracker knowledge; the core has zero
tracker knowledge; adapters are thin and swappable. Almost all behavior lives in the core.

## Hook contract (autoloop)

New `[hooks]` config block. Each slot holds a shell command (or list of commands):

```toml
[hooks]
pre_run        = "linear-sync pull"
post_iteration = "linear-sync push --incremental"
post_run       = "linear-sync push --final"
# pre_iteration = "linear-sync pull"   # opt-in, off by default
```

Lifecycle points (symmetric, complete surface): `pre_run`, `pre_iteration`,
`post_iteration`, `post_run`.

Context passed as env vars to every hook:

- `AUTOLOOP_PROJECT_DIR`, `AUTOLOOP_RUN_ID`, `AUTOLOOP_PRESET`, `AUTOLOOP_TASKS_FILE`
- `AUTOLOOP_ITERATION` (iteration hooks)
- `AUTOLOOP_GIT_SHA_BEFORE` / `AUTOLOOP_GIT_SHA_AFTER` (iteration hooks — lets push
  attribute the commit range for that iteration)

**Failure policy:** hooks are **non-fatal by default** (log to the run journal + continue,
so a tracker outage never kills a loop). `hooks.strict = true` makes a `pre_run` failure
abort the run. Hook stdout/stderr is captured into the run journal.

## Status model

Maps to the existing Linear team workflow states (no new states required):
`Backlog → Todo → In Progress → In Review → Done`, plus `Canceled` / `Duplicate`.

Two completion signals, because *committed ≠ released*:

| Signal | Linear transition | GitHub (labels; no workflow states) |
|---|---|---|
| Pulled into queue | Todo (Backlog excluded by default) | open + `autoloop:queued` |
| Task picked up *(optional)* | → In Progress | `status:in-progress` |
| Task complete = **committed/merged** | → **In Review** (started-type, deliberately NOT Done) | stays open + `status:merged` |
| **Release cut** (`*-sync release <ver>`) | In Review → **Done** + version comment | add `status:released`, comment version, **close** issue |

- **In Review = "done in code, awaiting release."** Done = released. Keeps Linear
  progress/cycle stats honest and aligns with the projects' "done means proven/released" goal.
- Release promotion is an **explicit command**, scoped per repo (the two repos release on
  independent cadences): `linear-sync release --repo library v4.4.0` promotes only
  In-Review issues labelled `repo:library`. Work never formally released stays in In Review.
- New issues created by autoqa/autoreview land in **Todo**, labelled `repo:*` +
  `source:autoqa`, so they re-enter the pull cycle.

## Implementation notes write-back (on completing push)

Before transitioning state, the adapter posts a comment containing:

- run id + role (which loop/role did it),
- the branch name and the commit SHA range for that iteration,
- a one-line summary (task text; richer if the role emitted one to the journal).

Adapter specifics:

- **Linear:** every issue has a suggested `gitBranchName` (e.g. `jsamuel/sau-5-…`). `pull`
  surfaces it into the task; if autoloop branches with it, Linear **auto-links** commits/PRs.
  Comments via the MCP `save_comment`.
- **GitHub:** `gh issue comment <n> --body …`.

Notes are configurable (on by default).

## Sync state model

- **`.autoloop/issue-sync-state.json`** — the task↔issue map:
  `{ taskId, tracker, externalId, lastSyncedStatus, branchName }`. Kept **separate** from
  `tasks.jsonl` so we never mutate autoloop's append-only log. Drives pull dedup and tells
  push which issues to transition vs. create.
- **`source` tag convention:** tracker-seeded tasks get `source = "linear:SAU-5"` /
  `"github:42"`. Locally-created tasks keep their role source; once push creates an issue,
  the new mapping is recorded in the state file (not by rewriting the task).
- **pull:** list issues in the configured "ready" states for the mapped project/repo →
  `autoloop task add` any not already in the state file.
- **push:** for each newly-completed task → if mapped, transition the issue (→ In Review) +
  post notes; if unmapped (autoqa/autoreview origin) → create issue in Todo, record mapping,
  post notes.
- **release:** promote mapped issues currently in In Review → Done for the given repo scope.

Every operation is keyed on the state file, so re-running `pull`/`push`/`release` is
idempotent (no dupes, no double-transition).

## Config file (per source project → tracker)

`.autoloop/issue-sync.toml` in each source project:

```toml
tracker = "linear"            # or "github"

[linear]
project = "HTML → PPTX (library + skill)"
team    = "Sauhsoj"
repo_label = "repo:library"   # which issues this source project owns
pull_states   = ["Todo"]
review_state  = "In Review"
done_state    = "Done"

[github]                      # used when tracker = "github"
repo = "jsamuel1/PptxGenJS"
queued_label = "autoloop:queued"
```

## Authentication

- **GitHub (`gh-sync`)** — no auth code; `gh` owns auth. **Built first as the proving
  adapter.**
- **Linear (`linear-sync`)** — acts as an **MCP client to `mcp.linear.app`**, reusing the
  OAuth token Claude Code already cached.
  - **Feasibility spike (first task):** locate Claude Code's cached Linear token; confirm
    `mcp.linear.app` accepts it headlessly. **Risk:** the token is scoped to
    `resource=mcp.linear.app` and may need refresh; an interactively-obtained token reused
    headlessly is the single biggest risk in this design.
  - **Fallback:** documented `LINEAR_API_KEY` (personal API key) if token reuse proves
    unworkable. The adapter interface is identical either way; only the transport changes.

## Testing

- `issue-sync-core` unit-tested against a **fake in-memory adapter** (issues, transitions,
  comments) — covers pull dedup, push transition-vs-create, release promotion, idempotency.
- `gh-sync` contract test against a scratch GitHub repo.
- `linear-sync` contract test against the live MCP, behind an opt-in env flag.
- Hook firing tested in the harness with a script that writes a sentinel file per slot;
  assert order (`pre_run`, `pre_iteration`, `post_iteration`, `post_run`), env var presence,
  and non-fatal-vs-strict failure behavior.

## Build order

1. autoloop `[hooks]` feature (generic; independently useful).
2. `issue-sync-core` + fake adapter + unit tests.
3. `gh-sync` (proving adapter; no auth risk).
4. `linear-sync` auth spike → adapter.
5. Wire the two source projects' `issue-sync.toml` + autoloop `[hooks]` config.
