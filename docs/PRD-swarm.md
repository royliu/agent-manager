# PRD — `am gm start <profile> gm`

**Draft v0.3 · 2026-09-06 · Roy Liu with Claude.** Extends `am` from a profile and quota manager into a control plane for one swarm of coding agents per project. Detail that is not needed to understand the product lives in `PRD-swarm-appendix.md`. Interactive mockup: `docs/mockup-swarm.html`.

## What it is

```sh
cd ~/Projects/agent-manager
am gm start personal friday
```

Friday is a General Manager running on your `personal` profile in this folder. It brings up its own **task manager** (the board) and **four task agents** (`friday-1` … `friday-4`). You describe what you want; Friday discusses, breaks it into tasks with short ids (`#12`), assigns them, and reviews the results. The board shows every task and every agent, what it costs, and what needs you.

**You see two things: Friday and the board.** Everything else is Friday's business.

| You see | Reach it |
|---|---|
| **Friday** — interprets, discusses, decomposes, assigns, reviews. Owns the workspace and the team. Speaks plain English. | `am gm start <profile> [name]` · `am gm` to come back |
| **The board** — every task with status, owner, ETA, cost; a team strip with each agent's state and context use; how many things need you. | `am board` |

| Runs underneath | Does |
|---|---|
| Task manager | A board on the surface, an agent underneath. The board part is bookkeeping: tasks, notes, questions, runs, the project brief; it assigns work to idle agents and watches for stalls and context limits. The agent part answers the team's questions on Friday's behalf, reasoning from your intent as written down and reading the code when needed, so Friday stays in the conversation with you. |
| `friday-1` … `friday-4` | Persistent agents on the same profile, one task at a time, idle between tasks. Report with evidence, ask with context, checkpoint to the board and compact at 90%. |

## Starting

1. `cd` into the project.
2. `am gm start personal friday` — any `am` profile; the name is optional.
3. Friday creates its task manager and four agents, captures the **workspace** (this folder, its branch, your shell environment with API keys stripped), then hands the terminal to Claude Code (or Codex) running as Friday, with its tools, instructions and a status line attached (`friday · personal Max 20x · ctx 44% · 3 need you`). Friday says hello in one paragraph. From here on it is a normal Claude Code session.
4. Talk to Friday here; this terminal is now Claude Code (or Codex). `am gm start` does nothing else.
5. In another terminal, `am board` shows the board. Wide terminal: kanban columns. Narrow terminal: a list. It re-lays out when you resize. You never need the board to work with Friday: it tells you in chat when something needs you, and the status line shows the count.

**One folder, one GM.** `am gm start` in a folder that already has a GM resumes it; a different name is refused until you `am gm stop`. A git worktree is its own folder, so each worktree can have its own GM with its own board and team; the per-task worktrees Friday makes for its agents are not places to start one.

Start from the shell, not from inside Claude Code: the profile, credentials, tools and status line are chosen when Claude Code launches and cannot be swapped into a running session. Once started, Friday *is* the Claude Code session you are in.

`am gm` reattaches. `am gm stop` stops the team; board state is kept. Change the workspace by telling Friday ("we're on feat/board now"); it updates the brief and every agent adapts at its next task.

## The three rules

**1. Who talks to whom.** You ↔ Friday in chat. Friday → task manager with tools. Task manager → agents with a brief. Agents ask the **task manager**, which answers as an agent: it reasons from your intent as written down (the project brief Friday keeps, your asks, the notes and decisions, the workspace conventions, the code it can read), decides the way Friday would, and replies so the agent can act. It keeps one conversation of its own so answers stay consistent. Only the rare judgment call reaches **Friday**: a choice that changes scope, cost or what done means when your intent is unknown, anything hard to undo, or contradicting notes. Friday answers or asks **you**, and otherwise stays in the conversation with you; the task manager tells it afterwards, for awareness only. Whoever answers, the answer becomes a note and the agent resumes. Agents report to the task manager, which tells Friday. You can also answer or approve straight from the board; the result is a note either way.

**2. Plain English, and every question carries its context.** No jargon or internal names; the only shorthand is task ids, file paths and commands. A question must give: what the task is for (`about`), what is known so far (`known`), the exact `question`, `options` with trade-offs, and the `default` if no one answers, by when. The task manager refuses a question missing any of these. A report must say what changed, how it was verified, what is left. Friday holds itself to the same rule with you.

**3. Checkpoint at 90%, then compact.** Every agent, Friday included, watches its context. At 90% it writes a checkpoint note on its task (done, left, next, decisions), then compacts, then continues from the note. The board is the memory; nothing important lives only in a window. Each agent also keeps a one-paragraph memory note for the project, refreshed at each checkpoint.

## Tasks

- **Id:** `#N`, never reused. Sub-tasks get their own ids; the root task stores your original ask verbatim.
- **Status:** `open → plan → in progress → review → done`, plus `blocked` and `cancelled`. Blocked always carries a reason (`question → you`, `waiting on #17`, `quota resets 14:00`, `budget`, `stalled`) and returns to the status it left. Review has two stages: Friday, then you. Plan-first tasks wait as *plan (awaiting you)*.
- **Notes** are typed and authored, and travel with the task into every agent brief. **Runs** record each stretch of work with tokens, cost and context use.

## The board

Header: Friday's name and workspace; the profile's quota bar; the **team strip** (`friday-1 ▶ #12 ctx 62%` · `friday-2 ▶ #21 ctx 91% ↻ compacting` · `friday-3 ⏸ #11 waiting on you` · `friday-4 · idle`); and `3 need you`. Below it, columns for the current grouping with two-line cards and a preview of the highlighted task.

| Key | Does |
|---|---|
| `↑↓` `←→` | move between cards and columns |
| `⏎` / `esc` | open a task (description, dispatch tree, runs, notes, the question in full, timeline) / back |
| `g` `s` `d` | group by status → agent → eta · sort · hide done |
| `/` | filter by text or `#id` |
| `r` | reply to the open question |
| `a` `x` | approve (review → done, plan → start) · send back with feedback |
| `n` `p` `c` | note · priority · cancel |
| `m` `e` `t` `o` | in detail: reassign · ETA · transcript · open worktree |
| `K` `q` | pause every agent · quit (the team keeps working) |
| mouse | wheel or trackpad scrolls the column or detail under the pointer · click selects · double-click opens · hold Shift to select text |

Layout follows the terminal: columns like a kanban at 110 characters or wider, a sectioned list below that, re-laid out on every resize. Friday never opens or reads the board; it uses the same data through its tools. The board is for you.

## Decisions

1. **The task manager is a board on the surface and an agent underneath.** Bookkeeping, assignment and watching are deterministic. Answering the team is an agent: a persistent conversation on the same profile with read-only access to the workspace, reasoning from the project brief and everything recorded, so Friday can stay with you. Friday creates it; the board is its face.
2. **Agents are persistent team members.** Four named agents with project memory, not a process per task. This is what makes the 90% rule necessary and visible.
3. **You set the workspace; Friday carries it,** and may give a task its own worktree when two agents would otherwise edit the same checkout. It says so on the task.
4. **All agents on Friday's profile by default.** Five sessions on one Pro plan will hit the 5-hour window; Friday warns at 80% and offers to move an agent to another profile (`am agent move`).
5. **Plain English is enforced by tool schema,** not prompts alone.

## Milestones

| | Ships | Demo |
|---|---|---|
| **M1 Start** | `am gm start`, four agents, board in both layouts, read-only, report | Friday says hello; one ask becomes a task an agent finishes |
| **M2 Conversation** | structured ask with pause and resume, escalation, board keys, notes in briefs | an agent's question reaches you on the board, you answer, it finishes |
| **M3 Team** | team strip, checkpoint and compact at 90%, memory notes, workspace propagation, watchdog, cost per task | `friday-2` hits 90%, checkpoints, compacts, finishes; you change branch in chat and the next task uses it |
| **M4 Polish** | quota guard and agent move, triage, notifications, `--json` | daily-driver quality |

## Open questions

1. **The 90% knob.** Confirm the exact compaction setting in current Claude Code and Codex; if neither exposes one, the task manager's checkpoint-and-compact request is the mechanism.
2. **Friday's inbox latency.** Events arrive at Friday's next turn. Acceptable, or inject when idle?
3. **Team size on Pro.** Keep four and warn, or default to two on Pro plans?
