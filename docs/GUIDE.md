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

**How commands are named.** A noun, then a verb: `am profile add`, `am gm start`, `am task stop`.
The nouns are the things in the story: `profile` (one account of one tool), `gm` (the General
Manager; its name stands for its whole team), `board`, `task`, `agent`, and `shell` for
plumbing. Each verb means one thing everywhere: `start` and `stop` for work that runs in the
background, whether a GM or a task; `open` for a conversation; `run` for a tool in the
foreground; `use` for a switch that stays in effect; `ls`, `add`, `rm`, `show`, `assign` and
`move` on the collections. Four shortcuts drop the noun: `am` (status), `am run`, `am gm`
(open) and `am board`. Names from before 0.7.0, such as `am tasks` or `am start`, still work
and print the new name.

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
am --version              # 0.8.2
```

`am init` (next section) offers to install the shell hook, which lets `am profile use` switch
the profile of your current shell. To add it by hand:

```sh
am shell hook >> ~/.zshrc && exec zsh      # bash and fish work too: am shell hook bash
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
am profile add personal            # pick the tool, then sign in when it opens
```

`am profile add` creates the directory, then launches the tool inside it so you can sign in with
`/login` (Claude Code) or `codex login`. When you come back it confirms the account and plan.

**Check everything:**

```sh
am status                  # plan, quota, 24h consumption per profile
am status --live           # also poll Claude for authoritative quota percentages
am doctor                  # installs, logins, isolation, and billing-override variables
```

**The billing trap.** `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in your shell silently
overrides subscription login and bills you per token. `am run` and `am gm start` strip both by
default, and `am doctor` warns when one is set. Pass `--keep-api-keys` when you really want
API billing.

**Running a tool under a profile:**

```sh
am run personal                    # Claude Code on the personal profile
am run work -- --resume            # everything after the name goes to the tool
am profile use work                # make work the active profile for this shell
```

## 3. Start your first team

Go to a project folder and start a General Manager on a profile. The name is yours; it
becomes the GM's name and the prefix of its agents.

```sh
cd ~/Projects/genie
am gm start personal friday
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
am board
```

That is the whole surface: you talk to Friday, you watch the board. The task manager and the
agents are Friday's business.

Options on `am gm start`:

| Flag | Meaning |
|---|---|
| `--agents N` | create N task agents instead of the default 4 (`team.size`) |
| `--gm-model`, `--tm-model`, `--agent-model <model>` | models for this GM only, remembered (see [Models](#8-models)) |
| `--agent-profile <profile>` | the profile the task agents run on, any Claude Code or Codex profile; remembered (see [The team](#7-the-team)) |
| `--dir <path>` | use another folder as the workspace |
| `--no-open` | start the team in the background and return; `am gm` opens the conversation later |
| `--dry-run` | set everything up and print the command instead of starting the session |
| `--keep-api-keys` | do not strip `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` |

If you leave out the name, the folder's name is used. One folder has one GM; running
`am gm start` again in the same folder resumes it.

## 4. Talking to the General Manager

Talk to Friday the way you would brief a lead engineer. Plain language, whatever detail you
have. Friday discusses first and formalises second: it asks when the ask is ambiguous,
proposes trade-offs rather than guessing, and only then turns the work into tasks.

**Proposing before starting.** By default Friday shows you the tasks it would create,
each with a title, an owner and a rough size, and waits for your go. Say "go" and it
creates and starts them. If you prefer Friday to just start on clear single tasks, set
`am config gm.propose false`.

**Tasks have ids.** Every task is `#12`-style. Use the id in conversation: "how is #12
going", "cancel #14", "make #15 depend on #12". Sub-tasks get their own ids and point at
their parent.

**Every task has an ETA.** Friday gives its honest estimate when it creates a task; the
agent refines it as it works. The board shows the ETA and a countdown.

**Parallel work.** When an ask has independent parts, Friday makes one task per part and
starts them on different agents at once, so a five-part job takes as long as its
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
am board                    # the GM for this folder
am board friday             # a GM by name, from anywhere
am board -g agent           # group by agent (or eta) instead of status
am board --json             # the whole board as JSON, for scripts
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
| `x` | on running or blocked work: stop it, which puts the task on hold (type feedback first to redirect instead); on a report or plan: send it back with feedback |
| `n` | add a note to the task |
| `p` | change priority |
| `m` | assign to another agent |
| `c` | cancel the task |
| `t` | open the agent's run log |
| `o` | open the task's worktree |
| `+` `-` | resize the detail pane |
| `K` | pause every agent (press again to resume) |
| `q` | quit; the team keeps working |

**Terminal size.** If a terminal host reports its size wrong and the board looks cut off,
force it: `am board --size 160x48`, or set `AM_BOARD_SIZE=160x48`.

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
Type feedback before pressing `x` and the agent is restarted on it instead. Start a task
on hold again from Friday or with `am task start 12`.

**Dependencies.** If `#20` needs `#17` first, say so; the task manager holds `#20` until
`#17` is done and then starts it on the first idle agent.

**Nobody sits idle.** The moment an agent reports a task finished, the task manager hands it
the next open task by itself: most urgent first, by priority and then ETA, and preferring an
agent that already worked on that task's parent or siblings, since it knows that corner of the
code. Friday is told for awareness and you see the start on the board. Two kinds of task are
skipped: one waiting on another task, and one on hold. Stopping a task without feedback puts it
on hold; so does `am task hold 12` or asking Friday to hold it. `am task start 12` releases it.
Turn the behaviour off with `am config tm.autostart false`, and the task manager starts only
what Friday or you start.

**Context limits.** The 90% line (`agent.compact-at`) always holds. When an agent crosses it,
the task manager tells it on its very next action: the agent's next tool call is refused with
the notice, so it cannot miss it, and it writes a checkpoint note on its task (done, left, next
step, decisions and why), refreshes its project memory, and is continued in a fresh session
from the note. If it still has not checkpointed after a few minutes (`agent.compact-grace`,
default 3), or at 98% as a last resort, the task manager ends the run, writes the checkpoint itself from
what it saw (last progress, last words, recent actions) and continues the task in a fresh
session, telling Friday for awareness. You see it on the board as "compacting"; nothing is
lost because the board is the memory. One safeguard: if a fresh session is already over the
line before it has done anything, the task's brief itself is too big, and compacting again would
only spin. The task goes on hold with a note asking Friday to trim its notes or split it.

**From the shell.** Everything the board does is also a command, useful in scripts:

```sh
am task ls                                  # every open task
am task show 12                             # one task in full
am task add "Title" --description "…" --eta 2h [--agent friday-2] [--start]
am task note 12 "Acceptance: the empty case is covered by a test."
am task eta 12 4h
am task approve 12 ["what you checked"]
am task reject 12 "what to change and why"  # or: am task stop 12
am task hold 12                             # park it; the task manager will not start it on its own
am task cancel 12 · am task retry 12 · am task start 12 · am task assign 12 friday-3
```

Add `--gm <name>` when you are not in the GM's folder, `--json` for machine output.

## 7. The team

```sh
am agent ls                          # who runs on what, state, task, context use
am agent add                         # one more agent on the GM's profile (friday-5)
am agent add --profile work          # an agent on another profile (another subscription)
am agent add fast --model claude-sonnet-5   # a named agent pinned to a model
am agent rm friday-5
am agent move friday-2 --profile work
```

**A profile for the whole team.** Rather than moving agents one by one, set the profile the
task agents run on. For one GM, remembered: `am gm start personal friday --agent-profile codex`;
on a GM that already exists this moves the idle agents there now and names any agent that is
mid-task, which you move later with `am agent move`. For every GM: `am config profile.agents
codex`, which applies to agents created from then on. Or tell Friday, who changes it only when
you ask. The GM and the task manager stay on the GM's profile.

This is how you spread work across subscriptions or tools: Friday on your Claude Max plan, the
task agents on a Codex plan. Codex agents use the same task tools and have their own model
setting, `model.codex-agents`, because Codex has its own model names. Codex has been exercised
less than Claude Code here.

The number of agents a new GM starts with is `team.size` (default 4), or `--agents N`.

## 8. Models

Three groups, each yours to set:

| Group | Setting for every GM | For one GM only |
|---|---|---|
| General manager | `am config model.gm claude-fable-5-1` | `am gm start personal friday --gm-model claude-fable-5-1` |
| Task manager | `am config model.tm claude-opus-5` | `--tm-model claude-opus-5` |
| Task agents | `am config model.agents claude-opus-5` | `--agent-model claude-opus-5` |
| Task agents on Codex | `am config model.codex-agents gpt-5.6-sol` | `--codex-agent-model gpt-5.6-sol` |
| Task agents' profile | `am config profile.agents codex` | `--agent-profile codex` |

By default every group runs on the profile's own model: the `model` in that profile's
Claude Code `settings.json`, or Codex `config.toml`, or the tool's built-in default when
neither is set. A setting for one GM beats the global one. `default` puts a group back on
the profile's model: `am config model.tm default`, or `--tm-model default`.

Name models by their official ids: `claude-fable-5-1`, `claude-opus-5`, `claude-sonnet-5`,
`claude-haiku-4-5-20251001`; for Codex profiles the id Codex accepts, such as `gpt-5.6-sol`.
Short aliases like `opus` are accepted but float: the tool maps them to whichever version it
currently ships, so `am` reminds you of the official id when you use one. A `[1m]` suffix on a
Claude id, as in `claude-fable-5-1[1m]`, selects the 1M-context variant and tells `am` to
measure the 90% line against that window.

**Putting it together.** Friday on Fable, the task manager on Opus, the task agents on your
Codex subscription, each on its own plan:

```sh
am gm start personal friday --gm-model claude-fable-5-1 --tm-model claude-opus-5 --agent-profile codex --codex-agent-model gpt-5.6-sol
```

You can also just ask Friday: "run the task agents on Opus". Friday has a tool for it and
only changes models when you ask.

When a change applies: the GM's model the next time you open the conversation with `am gm`;
the task manager's at its next answer; the agents' at their next run. Running work finishes
on the model it started with.

`am gm start`, `am agent ls`, the board's task detail and Friday's team list all show which
model each group runs on and where the choice came from: set for this GM, set with
`am config`, or the profile default.

## 9. Settings

`am config` with no arguments lists every setting with its value and meaning. `am config
<group.key> <value>` sets one for every GM and reloads running task managers; `am config
<group.key> default` clears it. Keys are grouped by the thing they describe.

| Key | Default | Meaning |
|---|---|---|
| `model.gm`, `model.tm`, `model.agents` | unset | the model of each group; unset means the profile's own model |
| `model.codex-agents` | unset | the model for task agents on Codex profiles, which has its own names |
| `profile.agents` | unset | profile new task agents are created on, any Claude Code or Codex profile; unset means the GM's |
| `team.size` | 4 | task agents a new GM starts with |
| `team.notify` | true | desktop notification when something needs you |
| `gm.propose` | true | true: Friday shows the tasks it would create and waits for your go · false: clear single tasks start at once |
| `gm.hud` | true | show the profile's own status line (claude-hud if installed) above Friday's line |
| `tm.autostart` | true | when an agent frees up, the task manager gives it the next open task by itself; false: only tasks someone started |
| `tm.answers` | `most` | which questions the task manager answers itself: `most` (reasons and answers, escalates rarely) · `notes` (only what a note settles) · `off` (everything goes to Friday) |
| `agent.permissions` | `acceptEdits` | Claude Code permission mode for agents |
| `agent.allow` | Read, Edit, Write, Glob, Grep, Bash, WebFetch, WebSearch, the task tools | tools agents may use without asking |
| `agent.compact-at` | 90 | context percentage at which an agent checkpoints and gets a fresh session |
| `agent.compact-grace` | 3 | minutes an agent gets to write its own checkpoint past the line before the task manager checkpoints for it and restarts it fresh |
| `agent.stall-after` | 15 | minutes without activity before an agent counts as stalled |
| `agent.context-window` | 200000 | assumed window for models without a `[1m]` marker |
| `agent.compact-env` | `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | environment variable that asks the tool itself to compact at `agent.compact-at` |
| `limits.budget-usd` | unset | list-price budget per agent per day; work pauses when it is reached |
| `limits.quota-warn`, `limits.quota-hold` | 80, 95 | subscription quota percentages at which you are warned, and at which new work is held |

Names from before 0.7.0 (`swarm.agentModel`, `swarm.compactAt`, …) are accepted and mapped to
these.

## 10. Coming back, stopping, several projects

```sh
am gm                 # open Friday's conversation in this folder, where you left it
am gm friday          # by name, from anywhere (am gm open friday is the long form)
am gm ls              # every GM, its profile, whether its team is running, its folder
am gm show friday     # one GM in full: models, team, workspace, what needs you
am gm stop            # stop the team and the task manager here; the board is kept
am gm stop friday
am gm rm friday       # forget a stopped GM's records; the project folder is untouched
```

You can close Friday's terminal at any time; the team keeps working in the background and
the board stays live. `am gm` resumes the same conversation. `am gm stop` ends the agents'
processes and the task manager; tasks, notes, questions, runs and the agents' memories all
stay, and the next `am gm start` or `am gm` picks them up.

**Several projects.** One folder, one GM. Each project folder gets its own GM with its own
team, task manager and board, on whichever profile you choose. A git worktree is its own
folder and can have its own GM. `am gm ls` lists them; `am board <name>` and
`am task … --gm <name>` address one from anywhere.

## 11. Costs and quota

The board's bottom HUD shows each task's tokens and list-price cost, and each agent's
context use. The board header shows the profile's quota window. `am status` shows every
profile's plan, quota and 24-hour consumption. The dollar figures are the list price of the
same work, not what you are charged: on a subscription it is the value your plan absorbed.

Guard rails: `limits.budget-usd` pauses an agent for the day when its list-price usage passes
the budget; `limits.quota-hold` holds new work when the subscription's quota window is
nearly used, and `limits.quota-warn` warns you before that. `K` on the board pauses everyone at
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
am gm stop friday
am board              # starts the new task manager
am gm                 # reopens Friday with the new instructions
```

Friday's conversation and the agents' state survive this.

## 14. Troubleshooting

**The board says it cannot connect, or `am board` errors with a socket path.** The task
manager died or a stale pid file is left over. `am gm stop <gm>` then `am board` starts a clean
one. Sockets live in `/tmp/am-<uid>/`.

**Friday does not know about a new feature after an update.** Friday's session was started
before the update. `am gm stop`, `am board`, then `am gm`.

**The board is cut off or the wrong size.** The terminal host reported a wrong size.
`am board --size <cols>x<rows>` or `AM_BOARD_SIZE`.

**An agent asks something Friday could have answered.** Make sure Friday's project brief is
current: tell Friday what you care about and ask it to update the brief. The task manager
answers from what is written down.

**A Codex agent refused the model name.** Codex has its own names. Set them with
`model.codex-agents` (or `--codex-agent-model`), not `model.agents`.

**A profile shows "not signed in".** Run `am run <profile>` and sign in with `/login`
(Claude Code) or let `codex login` run (Codex).

**Everything bills per token.** `am doctor`; an API key variable is set in your shell.

**The claude-hud line does not show under Friday.** Install claude-hud into the profile you
started Friday on (or into your default `~/.claude`); `am` looks in both. `gm.hud` must
be true.

**An agent seems stuck.** After `agent.stall-after` minutes without activity the board marks it
stalled and tells Friday. You can `x` to stop it, `m` to assign it to another agent, or let Friday nudge it.
