# @mobrienv/autoloop-linear-sync

Sync Linear issues ↔ an autoloop task queue, wired as **run hooks** so a loop pulls
ready work at the start and pushes completion back to Linear at the end.

Ships two bins:

- **`autoloop-linear-sync`** — the `pull` / `push` / `release` CLI used by the hooks.
- **`autoloop-linear-open`** — a launcher for Linear's "open in coding tool" feature
  (wires the hooks for you; see that script for a reference invocation).

Requires **`LINEAR_API_KEY`** in the environment. autoloop does not manage secrets — if a
GUI-triggered launch doesn't inherit your login shell, export it yourself (e.g.
`launchctl setenv`) or wrap the launcher.

## CLI

```
autoloop-linear-sync <pull|push|release> [options]
  pull                                Pull Linear issues into the task queue
  push [--final]                      Push completed work to Linear (--final = run end)
  release <version> [--no-archive]    Promote In-Review issues to Done
```

## Hook wiring (the important part)

Wire the bins as autoloop hooks. The minimal correct set is **`pre_run` pull** +
**`post_run` push `--final`**:

```bash
autoloop run -b claude-sdk autocode \
  --set hooks.pre_run="autoloop-linear-sync pull" \
  --set hooks.post_run="autoloop-linear-sync push --final" \
  "Work the Linear-pulled tasks; one commit per logical change (put the issue id in each message)."
```

| Hook | Command | Effect |
|---|---|---|
| `pre_run` | `autoloop-linear-sync pull` | Pull `Todo` issues into the queue **and record the run's start SHA** (the baseline the final push diffs against). |
| `post_run` | `autoloop-linear-sync push --final` | At a **cleanly-finished** run, scan commits since the start SHA and move matched issues to **In Review**. |
| `post_iteration` | `autoloop-linear-sync push` | Optional. A bare `push` (no `--final`) is a **no-op** in the current implementation — it transitions nothing. Harmless to wire; the real transition happens at `post_run`. |

Promotion to **Done** is a deliberate, separate step (not done by `push`):

```bash
autoloop-linear-sync release <version>   # In Review → Done (and deletes merged per-issue branches)
```

## Gotchas (these are the ways it silently does nothing)

- **`push` without `--final` transitions nothing.** The handler gates on
  `enable = final && runCompleted`; a bare `push` reads no commit range and moves no
  issues. Wiring `post_run="autoloop-linear-sync push"` (no `--final`) is the classic
  "the board never updated" mistake — it must be `push --final`.
- **The final push only fires on a clean finish.** It checks `AUTOLOOP_STOP_REASON`
  (empty or `"completed"`). If the run is **killed or times out**, `post_run` is skipped —
  run `autoloop-linear-sync push --final` by hand afterward to catch up.
- **`push` only reaches "In Review", never "Done".** Done is the separate `release` step.
- **Issue attribution is by commit content**, so reference the issue id (e.g. `SAU-123`)
  in each commit message. Per-issue branches (`<user>/<id>-…`) help auto-linking but the
  loop committing to a shared working branch still works as long as the id is in the message.
- Config lives in the consuming project's `.autoloop/issue-sync.toml`
  (`project`, `team`, `repo_label`, `pull_states`, `review_state`, `done_state`).

## See also

- `bin/autoloop-linear-open` — reference launcher (wires the hooks; GUI-triggered).
- `docs/superpowers/specs/2026-06-14-autoloop-issue-sync-design.md` — design/lifecycle
  (note: its `post_iteration = push --incremental` is **not** implemented; the shipped CLI
  is `push [--final]` only).
