# Issue-sync push-back: completion linkage — scope

**Date:** 2026-06-15
**Status:** Scoping (for review — not yet implemented)
**Repo:** `jsamuel1/autoloop` · builds on `feat/issue-sync-bridge`

## Problem recap

A whole-queue run (`autocode` on `master`, working pulled Linear issues) finishes the
work but never moves the issues, because:

- **autocode has no per-queue-task completion.** `task.complete` is the **run-ending
  event** the finalizer emits — not `autoloop task complete <id>` per pulled issue.
  Pulled Linear tasks sit in `tasks.jsonl` as *context only*; they are never marked
  `done`. So `push`'s `listDone()` never returns them → `transitioned 0`.
- **Branch-based `push --final`** (already built) only matches a run that ran **on the
  issue's branch**. A whole-queue run on `master` matches no `branchName` → transitions
  nothing. (Verified: state has SAU‑13…22 mapped with `jsamuel/sau-NN-…` branches; run
  was on `master`.)

## Two flows to support

### A. Per-issue flow — BUILT (scope = harden + document)

`autoloop-linear-open` checks out `issue.branchName`; the run works that one issue; on
`post_run`, `push --final` transitions the mapped issue whose `branchName == ` the run's
current branch, **gated on `AUTOLOOP_STOP_REASON == "completed"`**.

Status: implemented + unit-tested. Remaining scope:
- **Hardening:** `autoloop-linear-open` should fail loudly if branch checkout fails or the
  tree is dirty; today it falls back to the current branch silently.
- **Optional tightening:** require ≥1 commit on the branch before transitioning (so a
  completed-but-no-op run doesn't move the issue). Today the gate is "run completed";
  this would make it "run completed **and** work landed." (Decision below.)
- **Docs:** the per-issue UX is only in the design doc; add a short README/runbook.

### B. Whole-queue flow — TO BUILD (recommended: commit-reference detection)

Because autocode commits per slice but never marks queue tasks done, the reliable signal
that an issue was worked is **a commit that references it**.

**Mechanism:** on `push --final` after a **completed** run, for each mapped, not-yet-In-
Review issue, transition it to In Review if a commit in the run's range references it.
"References it" = the commit subject/body contains the issue **identifier** (`SAU-22`) or
the commit is on the issue's `branchName`. (Linear's own magic words — "Fixes SAU-22" —
are a superset and keep Linear's native git-linking working too.)

**Run range (which commits count):** capture run-start `HEAD` in the `pre_run` hook
(store `runStartSha` keyed by run id in the sync state, or a small per-run file);
`push --final` scans `git log <runStartSha>..HEAD --format=%s%n%b`. Fallback when no
start sha: commits on the current branch not on the repo's default branch.

**Gating:** identical to branch-based — only when `AUTOLOOP_STOP_REASON == "completed"`
and `--final`. A timed-out/failed run transitions nothing.

**Requirement:** commits must reference the issue id. Enforced via the objective prompt
("reference the Linear identifier, e.g. `SAU-22`, in each commit") — already good practice
and what Linear's git integration expects. Documented as a precondition.

## Alternatives considered (and why not)

- **Per-task completion** (loop marks the pulled task `done`): rejected — autocode has no
  per-queue-task completion; its model is one objective per run, ended by the
  `task.complete` *event*. Forcing per-task completion fights the preset.
- **Loop self-reports** via an explicit `push --issue <id>` call when it finishes each
  issue: fragile for multi-issue runs (the loop has no reliable per-issue boundary).
  Fine only for the single-issue case — which is exactly the per-issue flow.

## Unified design

Both flows become one **"reference-based transition, gated on completion"** path:

- **per-issue:** reference = current branch `==` issue `branchName`.
- **whole-queue:** reference = a commit in the run range mentions the issue identifier
  (or its branch).

`push --final` collects matched issues from both signals, dedups by external id, and
transitions each once to In Review with a notes comment (run id, branch, the matching
commit SHAs).

## Acceptance criteria

- A completed whole-queue run whose commit `fix: … (SAU-22)` references SAU‑22 →
  SAU‑22 → In Review, with a comment citing the commit. Other pulled issues with no
  referencing commit stay in Todo.
- A failed/timed-out run → no transition (gate holds).
- The per-issue flow still transitions via branch match (unchanged).
- `release --repo <x> <ver>` still promotes In Review → Done (unchanged).

## Implementation sketch (one commit, small–medium)

1. **pre_run** (harness or the CLI's `pull`): record `runStartSha` for the run.
2. **CLI does the git** (keep core git-free): in `push --final`, gather commit
   subjects/bodies in the run range, compute `matchedExternalIds` (identifier substring
   or branch match against state entries).
3. **issue-sync-core `push`**: accept the precomputed `matchedExternalIds` (alongside the
   existing `currentBranch`/`branchBased`), transition those + branch-matched + task-done,
   dedup.
4. **Unit tests** (fake adapter, injected commit list): id-in-commit match, branch match,
   no-match, failed-run gate, dedup across signals.
5. **Docs:** update the design doc's status model + examples; note the "reference the id
   in commits" precondition.

## Open decisions (need your call)

- **D1 — per-issue gate:** keep "run completed" (current), or tighten to "completed **and**
  ≥1 commit on the branch"? (Recommend tighten — consistent with whole-queue, avoids no-op
  transitions.)
- **D2 — match strictness:** plain identifier substring (`SAU-22`) in commit text, or
  require a conventional marker (trailer `Linear: SAU-22` / "Fixes SAU-22")? (Recommend
  substring with word boundaries — lowest friction, matches Linear's own behaviour.)
- **D3 — run-range baseline:** `runStartSha` captured at pre_run (precise), vs.
  branch-ahead-of-default (no new state, but wrong if working on `master`). (Recommend
  `runStartSha` — precise and works on any branch.)
