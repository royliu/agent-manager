# Changelog

## 0.8.0 · 2026-09-09

- A profile per group: the task agents can run on a different profile, that is a different subscription or tool, from the GM. `am config profile.agents <profile>` for every GM; `am gm start … --agent-profile <profile>` for one GM, remembered, which on an existing GM moves the idle agents there now and names any agent mid-task; Friday's `team_profile_set` does the same, only when you ask. New agents are created on that profile. The task manager always shares the GM's profile. `am gm show` lists the agents' profile.
- Official model ids in every example and help text: `claude-fable-5-1`, `claude-opus-5`, `claude-sonnet-5`, and `gpt-5.6-sol` for Codex. Short aliases such as `opus` still work, and `am` reminds you of the official id when you use one, since aliases float to whichever version the tool currently ships.
- The models line leaves out the Claude Code agents when every agent is on Codex.

## 0.7.0 · 2026-09-08

- Commands are a noun and a verb, and each verb keeps one meaning everywhere: `am profile ls|add|rm|use|run`, `am gm start|open|stop|ls|show|rm`, `am board`, `am task …`, `am agent …`, `am shell hook|env`. `start` and `stop` are for work in the background (a GM, a task), `open` for a conversation, `run` for a tool in the foreground, `use` for a switch that stays. Shortcuts drop the noun: `am` (status), `am run`, `am gm` (open), `am board`.
- Renamed: `am add|ls|rm|use` → `am profile …` · `am start <profile> gm [name]` → `am gm start <profile> [name]` · `am stop` → `am gm stop` · `am tasks` → `am board` · `am shell-init` → `am shell hook` · `am env` → `am shell env` · `--swarm` → `--gm` · `am task dispatch` → `am task start` · `am task reassign` → `am task assign` · the GM's `task_dispatch` and `task_reassign` tools → `task_start` and `task_assign`. `am which` is folded into `am status`. Every old name still works and prints the new one; old GM sessions and task managers keep working across the update.
- New: `am gm show [name]` (models, team, workspace and what needs you, running or not) · `am gm rm <name>` (forget a stopped GM's records) · `am gm start --no-open` · `am status` is the home screen and lists every GM with what needs you · `am init` offers to install the shell hook · `am doctor` notices a hook from an older version.
- Settings are grouped by the thing they describe and read as sentences: `model.gm|tm|agents|codex-agents`, `team.size|notify`, `gm.propose|hud`, `tm.answers`, `agent.permissions|allow|compact-at|stall-after|context-window|compact-env`, `limits.budget-usd|quota-warn|quota-hold`. `am config` lists every setting with its meaning; the old `swarm.<key>` names are accepted and mapped.
- The shell hook handles `am profile use` as well as `am use`; reinstall it with `am init` or `am shell hook`. `am agent ls` shows only the agents; the GM's and task manager's models moved to `am gm show`.
- Docs, output and the GM's instructions use the same words: the board, start, assign. "Dispatch" and "swarm" no longer appear anywhere the owner reads.

## 0.6.0 · 2026-09-08

- Models are yours to set for each of the three groups: the General Manager (`swarm.gmModel`), the task manager (`swarm.tmModel`, formerly `triageModel`, which still works) and the task agents (`swarm.agentModel`; `codexAgentModel` for agents on Codex profiles). By default every group runs on the profile's own model; the Opus defaults from 0.5.3 are gone. `am config swarm.<key> default` clears a setting.
- Per-GM models: `am start <profile> gm <name> --gm-model | --tm-model | --agent-model <model>` sets them for that GM only and remembers them; they beat the global settings. Friday has a `models_set` tool for the same thing, used only when you ask.
- A full user guide, `docs/GUIDE.md`: install from source, profiles, starting a team, talking to the GM, the board and every key, questions and reviews, the team, models, every setting, several projects, costs, updating, troubleshooting. The README opens with a step-by-step and links to it.
- `am start`, `am agent ls`, the board's task detail and Friday's team list show which model each group runs on and where the choice came from (set for this GM, set with `am config`, or the profile default). `am config` with no arguments lists every setting, unset ones included.

## 0.5.5 · 2026-09-07

- `x` on a running or blocked task stops the work: the agent's process is ended and the task goes on hold; type feedback first and the agent is restarted on it instead. Same for `am task stop #id [feedback]` and Friday's `task_reject`. On a report or a plan `x` still sends it back with feedback.
- A stopped or reassigned agent's old process can no longer disturb the run that replaced it.

## 0.5.4 · 2026-09-07

- Context use is measured against the agent's real window: 1M-context models (`[1m]`) no longer read as full at 18%, which had been forcing repeated checkpoints and fresh sessions. The GM's and the task manager's windows follow their models too.
- `am agent ls` and Friday's team list show the model each agent actually runs on; Friday's instructions explain that models are set by the owner through `am config`, not by Friday.

## 0.5.3 · 2026-09-07

- Every agent other than the GM runs on Opus by default: task agents (`swarm.agentModel = opus`) and the task manager (`swarm.triageModel = opus`). The GM keeps the profile's default model.

## 0.5.2 · 2026-09-07

- List view: every section is shown, empty or not, and sections fold. Section headers are on the cursor path: `←` `→` jump between them, `⏎` or space folds and unfolds, a click does the same; a folded header lists its task ids. Folds are remembered per grouping.

## 0.5.1 · 2026-09-07

- Board pane redesigned: title, two lines of description (`full [⏎]`), a *live* zone with the agent's latest actions and its own progress text, a *timeline* zone with notes newest first, and a one-line HUD pinned at the bottom of the pane with progress, ETA, agent, context, cost and the action keys.
- Times show the timezone (`09:35 PDT`); ETAs read `Tue 8 Sep 18:00 PDT (in 1d 8h)`.
- Cards and list rows use a circle glyph (○ ◔ ◑ ◕ ●) for progress when the column is too narrow for a bar.
- The GM is told to decompose for parallel work: independent parts become separate tasks dispatched to different agents at once, sized to a couple of hours; task creation nudges it when an estimate runs past six hours while agents are idle.

## 0.5.0 · 2026-09-07

- Every task needs an ETA: creation refuses without one (`task_create` and `am task add --eta`), agents confirm or refine it early and are reminded if it is missing, and the board flags a missing one. `am task eta #id 2h` from the shell.
- Progress: agents report a percent with each progress update; the board shows a progress bar on cards, in the list, in the description pane and in detail, with a marked `~` estimate from time against the ETA when the agent has not reported one.
- Activity feed: what the agent is doing right now, read from its own session (files it reads and edits, commands it runs, notes it writes), shown live in the description pane and as a list in detail.
- Friday's status line now shows the profile's own HUD first (claude-hud wherever it is installed) and the swarm line beneath it (`swarm.hud`).
- Board: at narrow widths the list keeps at least half the height; the terminal size is read fresh from the tty so hosts that never send a resize signal still get a full-height board; `--size <cols>x<rows>` (or `AM_BOARD_SIZE`) overrides it.
- Board: fixed the frame ending far above the bottom of the terminal. Blank rows were empty text, which the renderer gives no height, so the whole board collapsed to its content; every blank row now holds its line.
- Only one task manager per swarm: a startup lock stops two starting in the same instant, and a stopping task manager removes only its own files.

## 0.4.1 · 2026-09-06

- Board: the description pane is resizable. Drag its divider with the mouse, or press `+` / `-`; the height is remembered in `~/.agent-manager/board.json`. A taller pane shows more of the description and the latest notes.
- Board: every function shows its key next to it, `sort [s]` style, in the header, the preview hints and the footer, at both widths.

## 0.4.0 · 2026-09-06

- The task manager answers the team as an agent, not a lookup: a persistent conversation on the GM's profile (`swarm.triageModel`, default Sonnet) with read-only access to the workspace, reasoning from the project brief, the owner's asks, notes, decisions and conventions, deciding the way the GM would. Escalation is the rare exception (scope or cost changes with unknown intent, anything hard to undo, contradicting notes). Verified: reasoned answers from the brief, one conversation kept across questions, a destructive choice escalated with its reason.
- Project brief: the GM keeps the owner's intent and the design so far with `workspace_update({brief})`; the task manager reasons from it. The GM's instructions ask it to keep the brief current and to stay in the conversation with the owner.

## 0.3.1 · 2026-09-06

- `am tasks` and every other client recover when the task manager's pid file is stale: the liveness check now confirms the process really is this swarm's task manager (a reused or zombie pid is treated as gone) and a fresh service is started.
- `am stop` removes the socket and the pid file independently, so one failure no longer leaves the other behind.
- The socket lives in a fixed per-user directory (`/tmp/am-<uid>/`) so every shell, hook and tool bridge agrees on its address.
- The GM's tool bridge and the board reconnect and restart the task manager when it goes away, so `am stop` followed by `am start` no longer breaks a running Friday.
- The socket client drops a closed connection so calls fail fast instead of hanging.

## 0.3.0 · 2026-09-06

- The task manager answers most agent questions itself by default (`swarm.triage = most`): from the task's notes, the ask, the workspace and recorded decisions, and by approving sensible defaults for small reversible choices. Only judgment calls reach the GM, and answered questions arrive as awareness items.
- The GM's instructions put the conversation with the owner first; only "needs you" items interrupt it.
- Board: fixed the wrap bug that left a stale frame behind at narrow widths; new minimal glyph layout under 110 columns; screen clears on resize.
- Plan-first tasks now pause for approval once the plan note is written; approving or sending back continues the same agent.
- Task manager reads live quota for Claude Code profiles so the quota bar and guard work.
- Agent model setting is per tool (`agentModel` for Claude Code, `codexAgentModel` for Codex); a failed run starts the next one in a fresh session.
- `am start --dry-run`; a saved GM session that no longer exists falls back to a fresh one.
- `am --version` reads from package.json.

## 0.2.0 · 2026-09-06

- `am start <profile> gm [name]`: a General Manager per project with its own task manager and four persistent task agents.
- `am tasks`: the live board, kanban or list by width, keyboard and mouse.
- Structured questions with required context, escalation ladder, pause and resume, checkpoints at 90% context, dependencies, workspace brief, watchdog, budgets, `am task`, `am agent`, `am stop`, `am config swarm.*`.

## 0.1.0

- Profiles, isolation, usage dashboard.
