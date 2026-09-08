# Using `am`: the guide

`am` does two things. It keeps several Claude Code and Codex subscriptions apart on one
machine, each in its own profile. And it runs a team of coding agents on those profiles for
each project you work in: a General Manager you talk to, a task manager that keeps the board
and answers the team, and task agents that do the work.

This guide takes you from a clean machine to a working team, then covers everything you
will meet day to day.

1. [Install](#1-install)
2. [Profiles: one per subscription](#2-profiles-one-per-subscription)
3. [Start your first team](#3-start-your-first-team)
4. [Talking to the General Manager](#4-talking-to-the-general-manager)
5. [The board](#5-the-board)
6. [Questions, reviews and stopping work](#6-questions-reviews-and-stopping-work)
7. [The team](#7-the-team)
8. [Models](#8-models)
9. [Settings](#9-settings)
10. [Coming back, stopping, several projects](#10-coming-back-stopping-several-projects)
11. [Costs and quota](#11-costs-and-quota)
12. [Where things live](#12-where-things-live)
13. [Updating `am`](#13-updating-am)
14. [Troubleshooting](#14-troubleshooting)

---

## 1. Install

You need Node.js 18 or newer, git, and the Claude Code CLI (`claude`). Codex (`codex`) is
optional and only needed for Codex profiles.

```sh
git clone https://github.com/royliu/agent-manager.git
cd agent-manager
npm install
npm run build
npm install -g .          # puts `am` on your PATH (or `npm link` while developing)
am --version              # 0.6.0
```

Then add the shell hook once, so `am use` can change the profile of your current shell:

```sh
am shell-init >> ~/.zshrc && exec zsh      # bash and fish work too: am shell-init bash
```

## 2. Profiles: one per subscription

A profile is an isolated config directory for one tool and one account. Claude Code is
pointed at it with `CLAUDE_CONFIG_DIR`, Codex with `CODEX_HOME`. Nothing in your existing
setup is moved or rewritten.

**Adopt what you already have.** If you are signed into Claude Code or Codex today, register
that login as a profile:

```sh
am init
```

It names adopted profiles after their tool (`claude`, `codex`, `desktop`). You can rename by
removing and re-adding, but the names only matter to you.

**Add a second account.** For a personal Max plan next to a work Pro plan, say:

```sh
am add personal            # pick the tool, then sign in when it opens
```

`am add` creates the directory, then launches the tool inside it so you can sign in with
`/login` (Claude Code) or `codex login`. When you come back it confirms the account and plan.

**Check everything:**

```sh
am status                  # plan, quota, 24h consumption per profile
am status --live           # also poll Claude for authoritative quota percentages
am doctor                  # installs, logins, isolation, and billing-override variables
```

**The billing trap.** `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in your shell silently
overrides subscription login and bills you per token. `am run` and `am start` strip both by
default, and `am doctor` warns when one is set. Pass `--keep-api-keys` when you really want
API billing.

**Running a tool under a profile:**

```sh
am run personal                    # Claude Code on the personal profile
am run work -- --resume            # everything after the name goes to the tool
am use work                        # make work the active profile for this shell
```

## 3. Start your first team

Go to a project folder and start a General Manager on a profile. The name is yours; it
becomes the GM's name and the prefix of its agents.

```sh
cd ~/Projects/genie
am start personal gm friday
```

What happens:

- A **task manager** service starts for this folder. It keeps the board and answers the
  team's questions. It is also the only writer to the task files, so nothing gets corrupted.
- **Four task agents** are created: `friday-1` to `friday-4`, on the `personal` profile.
  They are persistent sessions that stay idle until given a task, work on one task at a
  time, and remember the project between tasks in a one-paragraph memory.
- The **workspace** is captured: the folder, the git branch, your Node and git versions, and
  your shell environment with API keys stripped. Agents inherit it.
- Your terminal becomes **Friday**: Claude Code (or Codex, if the profile is Codex) running
  as the General Manager, with the team tools loaded and a status line under the input.

Friday opens with a short hello and asks what you want done. The board is in another
terminal:

```sh
am tasks
```

That is the whole surface: you talk to Friday, you watch the board. The task manager and the
agents are Friday's business.

Options on `am start`:

| Flag | Meaning |
|---|---|
| `--agents N` | create N task agents instead of the default 4 (`swarm.agents`) |
| `--gm-model`, `--tm-model`, `--agent-model <model>` | models for this GM only, remembered (see [Models](#8-models)) |
| `--dir <path>` | use another folder as the workspace |
| `--dry-run` | set everything up and print the command instead of starting the session |
| `--keep-api-keys` | do not strip `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` |

If you leave out the name, the folder's name is used. One folder has one GM; running
`am start` again in the same folder resumes it.

## 4. Talking to the General Manager

Talk to Friday the way you would brief a lead engineer. Plain language, whatever detail you
have. Friday discusses first and formalises second: it asks when the ask is ambiguous,
proposes trade-offs rather than guessing, and only then turns the work into tasks.

**Proposing before dispatching.** By default Friday shows you the tasks it would create,
each with a title, an owner and a rough size, and waits for your go. Say "go" and it
creates and dispatches them. If you prefer Friday to just start on clear single tasks, set
`am config swarm.dispatch auto`.

**Tasks have ids.** Every task is `#12`-style. Use the id in conversation: "how is #12
going", "cancel #14", "make #15 depend on #12". Sub-tasks get their own ids and point at
their parent.

**Every task has an ETA.** Friday gives its honest estimate when it creates a task; the
agent refines it as it works. The board shows the ETA and a countdown.

**Parallel work.** When an ask has independent parts, Friday makes one task per part and
dispatches them to different agents at once, so a five-part job takes as long as its
longest part. Tasks that touch the same files can be given their own git worktree so the
agents do not step on each other.

**The project brief.** Friday keeps a brief: your goals, the design so far, what matters to
you and what does not. The task manager reasons from it when it answers the team, so the
more you tell Friday about intent, the fewer questions come back to you. You can ask Friday
to record decisions and acceptance criteria as notes on a task.

**Plan first.** For anything large or risky, tell Friday "plan first": the agent writes a
plan, the task waits for approval on the board, and code only starts after you or Friday
approve it.

Useful things to say:

- "What is everyone doing?" (Friday reads the board and the team.)
- "Show me the inbox." (Questions it answered on your behalf, finished work, warnings.)
- "Stop #11, I changed my mind." / "Send #11 back: the tests do not cover the empty case."
- "Put the task agents on Opus." (Friday changes the model; see [Models](#8-models).)
- "Tell the team we are on branch release/2.1 now." (Friday updates the workspace; agents
  adapt at their next task.)

Friday's status line under the input shows the GM name, profile and plan, Friday's own
context use, and how many items on the board need you. If the profile has
[claude-hud](https://github.com/jarrodwatts/claude-hud) installed, its line shows above.

## 5. The board

```sh
am tasks                    # the GM for this folder
am tasks friday             # a GM by name, from anywhere
am tasks -g agent           # group by agent (or eta) instead of status
am tasks --json             # the whole board as JSON, for scripts
```

**Two layouts.** In a wide terminal it is a kanban: one column per status, a detail pane on
the right. In a narrow one it is a list grouped into foldable sections with the detail pane
below. Every status section is shown even when empty, so the shape of the board is stable.

**Moving around.** Arrow keys move between tasks and columns. In the list layout the section
headers are on the cursor path: `←` `→` jump between them and `⏎` or space folds and unfolds.
Folds are remembered per grouping. The mouse works too: wheel to scroll, click to select,
double-click to open, click a header to fold. Hold Shift to select text as usual.

**The detail pane** shows the selected task: title and status, a couple of lines of
description (`⏎` for all of it), a live zone with what the agent is doing right now, a
timeline of notes, questions and answers with times in your timezone, and a bottom HUD with
progress percentage, ETA, tokens, list-price cost and the agent's context use. Drag the
border between the list and the pane to resize it, or press `+` and `-`. The size is
remembered in `~/.agent-manager/board.json`.

**Progress.** Every task shows a progress bar (a circle glyph when there is no room) fed by
the agent's own estimates as it reports each step.

**Keys.** Each key is shown next to its function on screen; here is the full set.

| Key | Does |
|---|---|
| `↑` `↓` `←` `→` | move; in the detail view `↑` `↓` scroll |
| `⏎` | open the selected task; on a section header fold or unfold |
| `esc` | back to the board, clear the filter |
| `g` | group by status, agent or ETA |
| `s` | sort by priority, ETA, last update or id |
| `d` | show or hide done tasks |
| `/` | filter by text |
| `r` | reply to the open question on the selected task |
| `a` | approve: accept finished work, or approve a plan |
| `x` | on running or blocked work: stop it (type feedback first to redirect instead); on a report or plan: send it back with feedback |
| `n` | add a note to the task |
| `p` | change priority |
| `m` | reassign to another agent |
| `c` | cancel the task |
| `t` | open the agent's run log |
| `o` | open the task's worktree |
| `+` `-` | resize the detail pane |
| `K` | pause every agent (press again to resume) |
| `q` | quit; the team keeps working |

**Terminal size.** If a terminal host reports its size wrong and the board looks cut off,
force it: `am tasks --size 160x48`, or set `AM_BOARD_SIZE=160x48`.

## 6. Questions, reviews and stopping work

**Who answers an agent's question.** Agents ask the task manager first. It is an agent
underneath: it runs its own session on the GM's profile with read access to the code, and
reasons from the project brief, your asks, the notes and decisions on every task, the
workspace conventions and the code itself. If it can settle the question it answers, the
agent resumes in the same session, and Friday gets an awareness-only note. Only the rare
judgment call goes further: a choice that changes scope or cost when your intent is
unknown, anything hard to undo (secrets, money, deleting data, pushing or merging), or
notes that contradict each other. Friday then answers from the ask or its design, or puts
the question to you with a recommendation. That is when a task shows "needs you" on the
board.

**Every question carries its context.** An agent must say what the task is for, what it
already knows, the exact question, the options with their trade-offs, and what it will do if
nobody answers. The task manager refuses a question without those parts, so you never
answer a one-liner out of nowhere.

**Answering.** Three ways, all equivalent: press `r` on the task in the board, tell Friday in
chat, or from a shell:

```sh
am task answer 12 "Use the scorecard's average entry; ignore the swap feed."
```

The answer becomes a note on the task and the agent resumes with it.

**Reviews.** When an agent reports done (what changed, how it verified, what is left, what
to watch), the task goes to review. Friday looks at the work first; if it passes, the task
waits for your acceptance. `a` accepts; `x` with feedback sends it back and the agent
resumes on your feedback in the same session.

**Stopping work.** `x` on a running task ends the agent's process and puts the task on hold.
Type feedback before pressing `x` and the agent is restarted on it instead. Dispatch a task
on hold again from Friday or with `am task dispatch 12`.

**Dependencies.** If `#20` needs `#17` first, say so; the task manager holds `#20` until
`#17` is done and then starts it on the first idle agent.

**Context limits.** Each agent watches its own context. At 90% (`swarm.compactAt`) it writes
a checkpoint note on its task (done, left, next step, decisions and why), refreshes its
project memory, and is continued in a fresh session from the note. You see it on the board
as "compacting"; nothing is lost because the board is the memory.

**From the shell.** Everything the board does is also a command, useful in scripts:

```sh
am task ls                                  # every open task
am task show 12                             # one task in full
am task add "Title" --description "…" --eta 2h [--agent friday-2] [--dispatch]
am task note 12 "Acceptance: the empty case is covered by a test."
am task eta 12 4h
am task approve 12 ["what you checked"]
am task reject 12 "what to change and why"  # or: am task stop 12
am task cancel 12 · am task retry 12 · am task dispatch 12 · am task reassign 12 friday-3
```

Add `--swarm <name>` when you are not in the GM's folder, `--json` for machine output.

## 7. The team

```sh
am agent ls                          # who runs on what, state, task, context use
am agent add                         # one more agent on the GM's profile (friday-5)
am agent add --profile work          # an agent on another profile (another subscription)
am agent add fast --model sonnet     # a named agent pinned to a model
am agent rm friday-5
am agent move friday-2 --profile work
```

Agents on another profile are the way to spread work across two subscriptions: the GM and
the task manager stay on one, some agents run on the other. Codex profiles work too; Codex
agents use the same task tools, and have their own model setting because Codex has its own
model names. Note that Codex has been exercised less than Claude Code here.

The number of agents a new GM starts with is `swarm.agents` (default 4), or `--agents N`.

## 8. Models

Three groups, each yours to set:

| Group | Setting for every GM | For one GM only |
|---|---|---|
| General manager | `am config swarm.gmModel opus` | `am start personal gm friday --gm-model opus` |
| Task manager | `am config swarm.tmModel opus` | `--tm-model opus` |
| Task agents | `am config swarm.agentModel opus` | `--agent-model opus` |
| Task agents on Codex | `am config swarm.codexAgentModel <name>` | `--codex-agent-model <name>` |

By default every group runs on the profile's own model: the `model` in that profile's
Claude Code `settings.json`, or Codex `config.toml`, or the tool's built-in default when
neither is set. A setting for one GM beats the global one. `default` puts a group back on
the profile's model: `am config swarm.tmModel default`, or `--tm-model default`.

Model names are whatever the tool accepts: `opus`, `sonnet`, a full id such as
`claude-fable-5-1[1m]`. The `[1m]` suffix also tells `am` the model has a 1M context window,
so the 90% line is measured against the right size.

You can also just ask Friday: "run the task agents on Opus". Friday has a tool for it and
only changes models when you ask.

When a change applies: the GM's model the next time you open the conversation with `am gm`;
the task manager's at its next answer; the agents' at their next run. Running work finishes
on the model it started with.

`am start`, `am agent ls`, the board's task detail and Friday's team list all show which
model each group runs on and where the choice came from: set for this GM, set with
`am config`, or the profile default.

## 9. Settings

`am config` with no arguments lists every setting with its value. `am config swarm.<key>
<value>` sets one for every GM and reloads running task managers; `am config swarm.<key>
default` clears it.

| Key | Default | Meaning |
|---|---|---|
| `agents` | 4 | task agents a new GM starts with |
| `dispatch` | `propose` | `propose`: Friday shows tasks and waits for your go · `auto`: single clear tasks start at once |
| `triage` | `most` | who answers agents' questions: `most`: the task manager reasons and answers, escalating rarely · `notes`: it answers only what a note settles · `off`: everything goes to Friday |
| `gmModel`, `tmModel`, `agentModel`, `codexAgentModel` | unset | models per group; unset means the profile's own model |
| `notify` | true | desktop notification when something needs you |
| `stallAfterMin` | 15 | minutes without activity before an agent is marked stalled |
| `compactAt` | 90 | context percentage at which an agent checkpoints and gets a fresh session |
| `contextWindow` | 200000 | assumed window for models without a `[1m]` marker |
| `permissionMode` | `acceptEdits` | Claude Code permission mode for agents |
| `allow` | Read, Edit, Write, Glob, Grep, Bash, WebFetch, WebSearch, the task tools | tools agents may use without asking |
| `budgetUsd` | unset | list-price budget per agent per day; work pauses when it is reached |
| `quotaWarnAt`, `quotaHoldAt` | 80, 95 | subscription quota percentages at which you are warned, and at which new work is held |
| `hud` | true | show the profile's own status line (claude-hud if installed) above the swarm line in the GM session |
| `compactEnv` | `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | environment variable used to ask the tool to compact at `compactAt` too |

## 10. Coming back, stopping, several projects

```sh
am gm                 # reopen Friday's conversation in this folder, where you left it
am gm friday          # by name, from anywhere
am gm ls              # every GM, its profile, whether its team is running, its folder
am stop               # stop the team and the task manager here; the board is kept
am stop friday
```

You can close Friday's terminal at any time; the team keeps working in the background and
the board stays live. `am gm` resumes the same conversation. `am stop` ends the agents'
processes and the task manager; tasks, notes, questions, runs and the agents' memories all
stay, and the next `am start` or `am gm` picks them up.

**Several projects.** One folder, one GM. Each project folder gets its own GM with its own
team, task manager and board, on whichever profile you choose. A git worktree is its own
folder and can have its own GM. `am gm ls` lists them; `am tasks <name>` and
`am task … --swarm <name>` address one from anywhere.

## 11. Costs and quota

The board's bottom HUD shows each task's tokens and list-price cost, and each agent's
context use. The board header shows the profile's quota window. `am status` shows every
profile's plan, quota and 24-hour consumption. The dollar figures are the list price of the
same work, not what you are charged: on a subscription it is the value your plan absorbed.

Guard rails: `swarm.budgetUsd` pauses an agent for the day when its list-price usage passes
the budget; `swarm.quotaHoldAt` holds new work when the subscription's quota window is
nearly used, and `quotaWarnAt` warns you before that. `K` on the board pauses everyone at
once.

## 12. Where things live

```
~/.agent-manager/
  profiles.json                registry of profiles
  state.json                   active profile per tool
  swarm-config.json            settings from `am config`
  swarms.json                  GM names, folders, profiles, per-GM models
  board.json                   board preferences (pane size, folds)
  cache/                       live-quota cache (no secrets)
  profiles/<tool>/<name>/      the isolated config directories
  swarms/<name>/
    tasks/                     one file per task: notes, questions, runs, report
    events.jsonl               the timeline
    inbox.jsonl                what the task manager left for the GM
    team.json                  agents: profile, model, session, memory
    workspace.json             folder, branch, environment, the project brief
    runs/                      agents' run logs
    wt/                        worktrees created for tasks
```

Credentials are never copied or logged. The only network calls `am` itself makes are the
optional `--live` quota polls; everything else is read from local files.

## 13. Updating `am`

```sh
cd agent-manager && git pull && npm install && npm run build && npm install -g .
```

Then, for each running GM, restart the task manager so it runs the new code, and reopen the
GM so its session loads any new tools:

```sh
am stop friday
am tasks              # starts the new task manager
am gm                 # reopens Friday with the new instructions
```

Friday's conversation and the agents' state survive this.

## 14. Troubleshooting

**The board says it cannot connect, or `am tasks` errors with a socket path.** The task
manager died or a stale pid file is left over. `am stop <gm>` then `am tasks` starts a clean
one. Sockets live in `/tmp/am-<uid>/`.

**Friday does not know about a new feature after an update.** Friday's session was started
before the update. `am stop`, `am tasks`, then `am gm`.

**The board is cut off or the wrong size.** The terminal host reported a wrong size.
`am tasks --size <cols>x<rows>` or `AM_BOARD_SIZE`.

**An agent asks something Friday could have answered.** Make sure Friday's project brief is
current: tell Friday what you care about and ask it to update the brief. The task manager
answers from what is written down.

**A Codex agent refused the model name.** Codex has its own names. Set them with
`swarm.codexAgentModel` (or `--codex-agent-model`), not `agentModel`.

**A profile shows "not signed in".** Run `am run <profile>` and sign in with `/login`
(Claude Code) or let `codex login` run (Codex).

**Everything bills per token.** `am doctor`; an API key variable is set in your shell.

**The claude-hud line does not show under Friday.** Install claude-hud into the profile you
started Friday on (or into your default `~/.claude`); `am` looks in both. `swarm.hud` must
be true.

**An agent seems stuck.** After `stallAfterMin` minutes without activity the board marks it
stalled and tells Friday. You can `x` to stop it, `m` to reassign, or let Friday nudge it.
