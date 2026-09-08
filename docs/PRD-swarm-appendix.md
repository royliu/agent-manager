# Appendix — `am gm start … gm` detail

Supporting material for `PRD-swarm.md`. Nothing here is needed to understand the product; it is here for when we build it.

---

## A. User stories

1. *As Roy,* I `cd` into a project and run `am gm start personal friday`; within seconds Friday says hello, tells me the team is ready and the board is `am board`, and asks what I want done.
2. *As Roy,* I describe a feature; Friday asks two clarifying questions in plain words, proposes three tasks with owners and ETAs, and dispatches on my "go".
3. *As Roy,* I open the board and see the four agents in one strip: two working, one waiting on me, one idle with its next task named. The header says three things need me.
4. *As Roy,* I press `→` to the blocked column, read `friday-3`'s question with its context in the preview, press `r`, answer in one line, and watch the card move back to in progress.
5. *As Roy,* I press Enter on `#9` and see its three sub-tasks, who holds each, and what each has cost so far.
6. *As Roy,* I see `friday-2` at 91% context with "compacting" next to it, open `#21`, and read the checkpoint note it wrote first.
7. *As Roy,* I switch branch and tell Friday "we're on feat/board now"; the workspace brief updates and the next task any agent starts uses the new branch.
8. *As Friday,* when an agent reports done I get a plain summary with verification in my inbox, look at the diff, and approve or send it back with feedback.
9. *As friday-3,* I have the task, its acceptance notes and the workspace before I start; when I hit an ambiguity I ask with context and get resumed with the answer.
10. *As Roy,* I run `am gm start work gm monday` in a second project and the two teams never touch each other's profile, board or workspace.

## B. Functional requirements

### 10.1 `am gm start <profile> [name]` and the GM session

- Flags: `--agents N` (default 4), `--board` (tmux split with the board), `--dir <path>` (workspace other than cwd), `--keep-api-keys`.
- The GM session runs under the profile with the swarm tools attached and the GM prompt, which encodes: talk first, formalise second; propose before dispatching unless policy is `auto`; write briefs for the agent, not for Roy; record decisions as notes; refer to tasks by id; ask Roy only when notes and the ask do not settle a question; plain English always; checkpoint and compact at 90%.
- Dispatch policy: `propose` (default) or `auto` (`am config gm.propose`). In `auto`, single-task asks dispatch immediately; decompositions of two or more tasks are still proposed.
- Inbox delivery: task-manager events are injected at the GM's next turn, and an end-of-turn hook keeps the GM working while unread items remain. The board shows `friday inbox N`.
- The GM's first message states: workspace, profile and plan, team size and names, how to open the board. Nothing about daemons, sockets or tools.

### 10.2 Task manager service

- One per GM, started by `am gm start`, stopped by `am gm stop`. Single writer of `~/.agent-manager/swarms/<name>/`.
- **Assignment:** a task goes to the agent the GM named, else to the first idle agent. If none is idle the task stays `open` with "queued · next free agent" on the card.
- **Workspace propagation:** every assignment and resume carries the current workspace brief; when the GM changes the brief, agents currently working get a plain note at their next turn and adapt or ask.
- **Mailbox and escalation:** structured questions (section 6); optional triage that answers only when it can cite a note (`tm.answers: off|notes`, off by default in v1).
- **Watchdog:** heartbeat from transcript modification time and process id; `stallAfter` (default 15 min) → `blocked (stalled)` and an inbox event. Context watch per agent; at 90% without a checkpoint within one turn, sends the checkpoint-and-compact request.
- **Budget guard:** per-task caps from the swarm config; crossing one pauses the run → `blocked (budget)`.
- **Quota guard:** the profile's window from `takeSnapshot()`; at 80% the GM is told and proposes to slow down or move agents; at 95% new assignments wait as `blocked (quota, resets 14:00)`.

### 10.3 The board (`am board`)

**Header.** Line one: GM name, workspace path and branch; on the right the profile's quota bar, session count, and the GM's own context use. Line two, the **team strip**: one cell per agent with state and context: `friday-1 ▶ #12 ctx 62%`, `friday-2 ▶ #21 ctx 91% ↻ compacting`, `friday-3 ⏸ #11 waiting on you`, `friday-4 · idle, #10 when you approve`. Line three: grouping tabs, sort, filter, and on the right `N need you · friday inbox N · tasks · cost`.

**Board.** At 110 columns or wider, kanban columns for the current grouping with two-line cards (`#id title` / `agent · eta`, markers `?` question, `!` overdue, `✓` in review, `◇` plan awaiting you). Under it a preview pane: title, status with reason, meta line, three lines of description, and the action line (the question text and `r reply`; the report summary and `a approve · x reject`; the plan summary and `a approve plan`). Narrower terminals get a sectioned list with the same keys.

**Grouping** (`g`): `status` (open · plan · in progress · blocked · review · done), `agent` (`friday-1` … `friday-4` · queued), `eta` (past · today · tomorrow · this week · later · no eta; overdue is a red marker on active cards). **Sorting** (`s`): priority → eta → updated → id. `d` hides done.

**Keys — board:** `↑↓` task, `←→` column (skips empty), `⏎` detail, `g` `s` `d` `v`, `/` filter by text or `#id`, `r` reply, `a` approve, `x` reject with feedback, `n` note, `p` priority, `c` cancel (confirms), `K` pause every agent (confirms), `q` quit.

**Detail view (⏎):** header with status and reason; ETA with countdown; who created it and the original ask; agent line with profile, model, run, elapsed, tokens, cost, context use; branch and worktree if the task has its own; **Description**; **Dispatch** (sub-task tree with owner and status, `waits for` / `unblocks`, run history with exit and transcript path); **Notes**; **Question** in its structured shape with the escalation path and `r reply`; **Timeline**. Keys add `m` reassign, `e` ETA, `t` transcript, `o` open worktree, `esc` back.

Live: the board subscribes to the task manager, so cards move without a refresh. `--json` prints the board.

### 10.4 Team management (advanced)

`am agent ls` shows the team with state, context use, tasks today and cost. `am agent add [name] [--profile <p>] [--role <text>]`, `am agent rm <name>`, `am agent move <name> --profile <p>`. Defaults come from the GM: same profile, same model, generalist role. None of this is needed to start.

### 10.5 Agent protocol

1. **Assign.** The task manager sends the brief: description, acceptance notes, all notes, the root ask, sibling ids, the workspace brief, the agent's memory note, and the rules (report with evidence; ask with context; note findings; checkpoint at 90%). Records the run.
2. **Work.** `progress`, `note`, `eta` as it learns.
3. **Ask.** `ask({about, known, question, options, default})` → task `blocked (question → task manager)`; the agent pauses (its session is kept).
4. **Answer.** Task manager → GM → you as needed. Whoever answers, the answer becomes a note and the agent is resumed with it.
5. **Checkpoint.** At 90% context: `checkpoint(note)`, then compact; the run is split at that point.
6. **Report.** `report({changed, verified, left, watch})` → `review (friday)`; GM inbox.
7. **Review.** GM approves → `review (you)`, or rejects with feedback → note and resume.
8. **Accept.** You press `a` or tell the GM. The agent is idle and takes the next queued task.

### 10.6 ETA, priority, cost, notifications

- The GM sets an initial ETA at assignment; the agent refines it after planning. Overdue tasks sort first in the ETA grouping and get a red marker.
- Priority `P0–P3`, default `P2`.
- Cost per task from the profile's transcripts filtered by session and run; shown in preview, detail, and as column totals.
- Terminal bell and macOS notification when a task enters `question → you`, `plan (awaiting you)` or `review (you)`. `team.notify false` turns it off.

## C. Additions beyond the brief, with reasons

| Addition | Why |
|---|---|
| **Team strip with context use** | The 90% rule is only trustworthy if you can see it. One glance shows who is working, waiting, idle or compacting. |
| **Needs-you count** in the header | The one number the board exists to show: questions to you, plan approvals, reviews waiting on you. |
| **Answer and approve from the board** | "Yes, option A" should not need a chat round-trip. The answer is a note, so the GM sees it. |
| **Structured questions enforced by the tool** | Plain English with context cannot be left to a prompt alone; the task manager refuses an ask without its fields. |
| **Checkpoint notes and per-agent memory notes** | Compaction loses detail. The board is the memory; agents write to it before they compact. |
| **Workspace brief** | Your environment, written down once, carried to every agent, updated when you change it. |
| **Blocked reasons and return-to status** | `question → you`, `waiting on #17`, `quota resets 14:00` is actionable; "blocked" alone is not. |
| **Dependencies** | Decompositions have order; `#20` is not assigned before `#17` is done. |
| **Stall detection, kill switch, budget caps** | Headless agents die, loop, or overspend. |
| **Per-task worktree when two agents would collide** | Chosen by the GM, said in plain words on the task; review becomes a branch diff. |
| **Quota guard with a plain warning** | Five sessions on one Pro plan will hit the 5-hour window; the GM says so at 80% and proposes to move agents to another profile. |
| **Transcript and worktree shortcuts** | You see only the GM and the board, so the board must be able to show everything on demand. |

## D. Technical design

### 13.1 Components

- **`src/swarm/service.ts`** — the task manager service, one per swarm: store, assignment, mailbox, watchdog, context watch, workspace brief. Unix socket at `swarms/<name>/tm.sock`. Single writer; atomic JSON writes as in `core/config.ts`.
- **`src/swarm/mcp.ts`** — the stdio tool bridge each session gets (`--role gm|agent --gm friday [--agent friday-3]`); tool set scoped by role; schemas enforce the question and report shapes.
- **`src/commands/start.ts`** — `am gm start`: resolve profile, register swarm, start the service, create agents, capture workspace, launch the GM via `providers/*.launch()` with tools and hooks written into the profile's config dir for this swarm.
- **`src/commands/tasks.tsx`** — the board. Ink, `format.ts` helpers, `useInput`, socket subscription.
- **`src/swarm/agents/{claude-code,codex}.ts`** — session adapters: headless launch, session capture, resume, compaction threshold where the tool exposes one.
- **Reused:** `paths.ts` (+`SWARMS_DIR`), `config.ts`, `snapshot.ts` (quota), `providers/*` (env isolation, launch), `usage/pricing.ts` (cost), `doctor.ts` (verifies compaction settings and billing hazards).

### 13.2 Tools by role

| Role | Tools |
|---|---|
| gm | `task.create` `task.update` `task.dispatch` `task.reassign` `task.note` `task.answer` `task.approve` `task.reject` `task.cancel` `task.list` `task.get` `team.list` `workspace.update` `inbox.read` `inbox.ack` |
| agent | `task.get` (own, parent, siblings) `task.note` `task.progress` `task.eta` `task.ask` `task.checkpoint` `task.report` `memory.update` |
| you (shell) | `am task show|add|note|answer|approve|reject|cancel|retry|reassign #id …` |

### 13.3 Storage

```
~/.agent-manager/
  swarms.json                      name → { dir, profile, createdAt }
  swarms/<name>/
    workspace.json                 the workspace brief
    team.json                      agents: name, profile, model, session id, memory note
    tasks/<id>.json                task, notes, questions, runs
    events.jsonl                   append-only log; the timeline; the board tails it
    inbox/gm.jsonl                 GM-bound events, acked in place
    runs/<runId>.log               agent stdout and stderr
    wt/<id>/                       per-task worktrees, when the GM asks for one
    tm.sock · tm.pid
```

### 13.4 Data model (abridged)

```ts
type Status = 'open'|'plan'|'in_progress'|'blocked'|'review'|'done'|'cancelled';
type BlockedOn =
  | { kind: 'question'; questionId: string; to: 'tm'|'gm'|'user' }
  | { kind: 'dependency'; taskId: number }
  | { kind: 'quota'; profile: string; resetsAt: number }
  | { kind: 'approval' } | { kind: 'budget' } | { kind: 'stalled' };

interface Question {
  id: string; from: string; to: 'tm'|'gm'|'user';
  about: string; known: string; question: string; options?: string[]; default: string;
  path: Array<{ to: string; at: number; note?: string }>;
  answer?: string; answeredBy?: string; askedAt: number; answeredAt?: number;
}
interface Report { changed: string; verified: string; left: string; watch?: string }
interface Task {
  id: number; title: string; description: string; ask?: string;
  status: Status; blockedOn?: BlockedOn; resumeTo?: Status; reviewStage?: 'gm'|'user';
  priority: 0|1|2|3; eta?: number; parentId?: number; dependsOn: number[];
  agent?: string; worktree?: string;
  notes: Note[]; questions: Question[]; runs: Run[]; report?: Report;
  usage: { tokens: number; usd: number }; createdBy: 'gm'|'user'; createdAt: number; updatedAt: number;
}
interface Run { id: string; taskId: number; agent: string; startedAt: number; endedAt?: number;
  exit?: 'done'|'blocked'|'failed'|'cancelled'|'compacted'; transcript?: string; tokens: number; usd: number; contextPct?: number }
interface Agent { name: string; profile: string; provider: 'claude-code'|'codex'; model?: string;
  sessionId?: string; state: 'idle'|'working'|'waiting'|'compacting'|'stalled'; taskId?: number; contextPct: number; memory: string }
interface Workspace { dir: string; branch?: string; env: Record<string,string>; tools: Record<string,string>; notes: string; updatedAt: number }
```

## E. CLI surface

| Command | Does |
|---|---|
| `am gm start <profile> [name] [--agents N] [--board] [--dir <path>]` | create or resume a General Manager in this folder; opens the chat |
| `am gm [name]` · `am gm ls` | reattach to the GM chat · list GMs and their folders |
| `am board [name]` (`am board`) `[--group …] [--json]` | the board |
| `am gm stop [name]` | stop the agents and task manager; board state kept |
| `am task show|add|note|answer|approve|reject|cancel|retry|reassign #id …` | act on a task from the shell |
| `am agent ls|add|rm|move` | the team (advanced; not needed to start) |
| `am config swarm.<key>` | `agents` `dispatch` `triage` `notify` `stallAfter` `agent.compact-at` (default 90) |
| internal | `am mcp …`, the task manager service: never typed, never shown |

