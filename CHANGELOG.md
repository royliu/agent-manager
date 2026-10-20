# Changelog

## Unreleased

- `am memory tidy <folder>` keeps the shared index short enough to read. The index is loaded whole into every session, so its length is paid for on every turn: merged across three profiles genie's came to 768 lines. Tidy folds it under topic pages — a topic page is an ordinary note, same folder and same front matter, whose body lists the notes it covers, and MEMORY.md carries one line for the page instead of one line per note. Genie's went from 768 lines to 180. Nothing is ever deleted or renamed: it only adds pages and rewrites MEMORY.md, it copies the whole folder to `~/.agent-manager/backups/memory-tidy-<when>/` first, and afterwards it reads the folder back and proves every note is still there word for word and still reachable from the index within one hop. Pages somebody wrote by hand are found and left exactly as they are. What is left is grouped by the words the note names share, biggest group first, until the index fits; a note that shares no word with five others keeps its own line. `--dry-run` says what it would do and changes nothing, and `~/.agent-manager/shared/projects/<project>/memory-topics.json` steers the grouping by hand (name a topic, give it matching words or notes, or tell a note to keep its own line). Check: `node --import tsx checks/memory-tidy.ts` (`BREAK=drop_line` must fail).
- Codex profiles get the shared memory too. Codex keeps none of its own, so there is no folder to link; instead an agent started on a codex profile is told, in five lines of its start instructions, where the folder is, to read MEMORY.md first, and how to add a note — the same front matter, plus one index line. A project with no shared memory adds nothing to the prompt, and Claude Code profiles are told nothing extra, because for them that folder already is their memory. `am memory status` says which profiles are told rather than linked. Proved with a real Codex run on a throwaway project (`node --import tsx checks/memory-codex-live.ts`, run by hand: it needs a logged-in codex profile and costs a little of its usage): told only where the folder was, it read the index first, opened the note that bore on its task, did the work, and left a new note behind with one line added to the index pointing at it.
- A run that reported but never exited no longer blocks its agent. On 20 Oct friday-6 reported #2783, but its process stayed alive; every start for friday-6 then returned without a word, and a task pinned to it sat open for 25 minutes while the board showed it idle. Now a run whose task has left it (reported, asked, sent back or closed) and whose process is still alive 90 seconds later is ended, together with everything under it (SIGTERM, then SIGKILL 10 seconds on), and the task's events say so. A start that finds the agent's old process still alive waits, says why on the task, and goes ahead once it has gone. A message sent while the old process was ending (a send-back, an answer) is no longer lost. A task pinned to an agent the board shows as idle that has not started after 5 minutes reaches the GM's inbox as stalled, naming why it waits. Check: `node --import tsx checks/linger.ts` (`BREAK=no_reap` must fail).

## 0.13.0 · 2026-10-20

- One memory per project, shared by every profile. Each tool kept what it learned about a folder per profile, so the same project was learned several times over and the copies drifted: on one project `work` held 690 notes, `personal` 342 and `superclaude` 110, 370 of them the same note written twice and 56 the same name with different words. `am memory share <folder>` merges them into `~/.agent-manager/shared/projects/<project>/memory` and makes every profile's own folder a link to it; the tool follows the link for reading and for writing. Nothing is lost: every folder is copied to `~/.agent-manager/backups/memory-<when>/` first, two files with the same words become one, and when they differ the one changed most recently keeps the plain name — so a `[[link]]` inside another note still points somewhere — while the other is kept beside it as `<name>.from-<profile>.md`. The indexes are merged as a union, one line per file.
- `am memory share --dry-run` says what it would do and changes nothing: how many notes each profile has, how many are the same, every note that differs with its sizes and dates, how long the merged index would be, and any profile that is already linked.
- `am memory status` lists every project with one shared memory: how many notes, how long the index is, which profiles are linked and which still keep their own — with a warning when the index passes 200 lines, which is more than a session can comfortably hold.
- `am memory unshare <folder>` gives each profile its own folder back, by default a full copy of the shared one so nothing written while sharing is lost; `--from-backup` puts back what it had just before the share. The shared folder itself is never deleted.
- A profile that joins a project whose memory is shared is linked automatically — when a GM starts or is opened, and when a task agent is added or moved — and whatever that profile learned on its own is folded in first.


## 0.12.0 · 2026-09-28

- A memory guard in the task manager. At 05:49 on 28 Sep the Mac ran out of memory with 358 `node` and 331 `esbuild` processes alive (~280 GB resident): the agents' check scripts piling up, with nothing capping how many ran, a script's own timeout killing only its launcher and leaving the child running, and every agent restarting at the same moment after a limit reset and after a wake. It froze and was force-reset twice. Every five seconds the task manager now adds up what the agents' scripts hold — everything an agent's session started through its shell, with its children, and anything still in that shell's process group after its parent died. Above `limits.mem-hold-gb` (16) no new run starts; above `limits.mem-stop-gb` (24) the newest scripts are stopped, each as a whole process group or tree, until the total is under the hold line again. The task gets a note in plain words ("The memory guard stopped a check (node … proof/1182/check.mts, 1.1 GB, started 3 min ago) because agent scripts used 25 GB …"), and a task whose scripts are stopped twice in an hour goes to the GM. The agents' own sessions, their MCP servers, the task manager, the GM and anything the agents did not start are never stopped.
- `limits.max-working` (4): task agents working at once per GM. `limits.restart-gap-sec` (60): two runs never start closer together than this, so a board start, a limit reset or a wake starts agents one at a time. A continuation that has to wait (an answer, a nudge, feedback) keeps its message and goes first once runs may start.
- The board's top line shows agent-script memory against the stop line, and the Mac's own use when there is room: `mem 9.2/24 GB · mac 41/64 GB`, green under the hold line, yellow above it, red at the stop line or after a stop in the last ten minutes. `am status` shows it on each GM's row, with the limits underneath and why the next run waits, if it does.
- The task manager no longer reads the GM's whole transcript on every status request. The GM's context figure is now read from the end of the file, and agents' transcripts are read only from where the last read stopped. The GM transcript had reached 527 MB, and each request read it whole (2.4 s and ~2 GB per read), which kept the task manager at 2.6 GB and most of a core.
- The task manager saying the same thing again becomes one note with a count ("… (399 times since 17 Sept, 15:42)") instead of another note. The 17 Sep retry storm had left single tasks with hundreds of identical failed-run notes, all carried in agent briefs and board snapshots; existing ones are merged when the board loads.

## 0.11.1 · 2026-09-17

- A run killed by the account's own usage limit no longer starts again in half a second. The tool answers 429 with "You've hit your session limit · resets 4pm" and exits at once; the task went back to open, an idle agent picked it up, and it died again — on genie, 17 Sep, that loop wrote 6,226 run logs and 1,724 inbox notices in a day, twice. The last line of a failed run's log is now read: when it names a session, usage or rate limit, every task waits for the reset (blocked on quota, with the reset time on it), nothing is started until then, and the owner is told once per window instead of once per retry. Work resumes by itself when the window passes. A failure that is not a limit behaves exactly as before.

## 0.11.0 · 2026-09-17

- A task can say which files it will change, and two tasks that would change the same file never run at the same time. `task_create` and `task_update` take `paths` (repository paths; a trailing slash or `*` covers a folder), and when an agent frees up the task manager skips a task whose files a running task already holds, fills the agent with the next one instead, and writes on the skipped task which task it is waiting for. On genie, 17 Sep, this was the largest hidden cost of the day: four lanes landing into one branch made every other lane re-apply its work, and one task re-applied against twenty-one landings — more time than every suite run put together. A task that declares no paths behaves exactly as before, so the rule only ever helps a lane that said what it would touch.
- The task view shows a task's declared files beside its dependencies.

## 0.10.0 · 2026-09-17

- Agents verify what they changed, not the whole project. The brief asked every agent to verify before reporting and said nothing about how much, so each one reached for the broadest check it could find: on a four-agent team that meant four full suite runs, in four worktrees, for a one-line change (genie, 17 Sep: a one-block style fix took 27 minutes to build and 94 minutes to prove). The default is now `task.verify targeted` — the checks covering the files it touched, plus the project's own quick check, with the whole suite reserved for tasks whose notes or workspace conventions ask for it — and the report has to name exactly what was run. `am config task.verify full` restores the old behaviour; `conventions` leaves scope out of the brief for a project whose own rules already cover it.
- `am config task.tests-first on` puts the check first: for work that changes behaviour the agent writes the test, runs it once to see it fail, then makes it pass, and a check written that way needs no separate proof that it can fail. Off by default, and visual work is exempt in the wording, since a check written only to satisfy a rule becomes tomorrow's known failure.
- A workspace change now reaches agents that are already running. Conventions set with `workspace_update` only ever arrived with the next task brief, so a rule set at 07:20 did not reach an agent that started at 07:13 until its task ended, hours later. A live run is now told once, in its next tool result, that the conventions changed and that they win over anything older. Changing only the project brief no longer counts as a workspace change for agents.

## 0.9.1 · 2026-09-17

- Moving a GM to another profile now clears the models set for it. A model set for one GM beat the profile's own, so a GM moved from an OpenRouter profile to a subscription one kept asking for an OpenRouter id, and Claude Code answered "There's an issue with the selected model" on every turn (17 Sep). `am gm start <profile> <gm>` on a GM that ran elsewhere now drops the GM's and the task manager's models and says so; `--gm-model` or `--tm-model` on the same command still set one.

## 0.9.0 · 2026-09-17

- Profiles on OpenRouter. A Claude Code or Codex profile can reach its model through OpenRouter with an API key instead of a subscription login: `am profile add` now asks which tool, then how the profile reaches its model (its own login or OpenRouter), then the model; `--openrouter` and `-m <id>` do the same without prompts, with the key read from `OPENROUTER_API_KEY` and never from the command line. The key and the model are checked with OpenRouter before anything is written, and a typo is answered with the id you probably meant.
- The setup lives in the profile's own config, so `am run`, the GM, the task manager and the agents all follow it: Claude Code's `settings.json` gets OpenRouter's base URL, the key and the model, with every model alias the tool uses internally mapped to it; Codex's `config.toml` gets an `openrouter` model provider whose key it reads from `openrouter.key` beside it (mode 600).
- `am status` and `am doctor` show such a profile as signed in, on `OpenRouter`, with its model and the key's last four characters, and no quota window. A model set for every GM with `am config model.*` no longer reaches an OpenRouter profile, since those settings use the tool's own model ids; a model set for one GM still does.
- A native profile can pin its model at creation too: `am profile add work -p claude-code -m claude-opus-5`.

## 0.8.10 · 2026-09-17

- A task whose agent keeps working while its question is answered stays In progress. An agent that asks, names its default and carries on still has a live run; answering used to set the task to Open and try to start a second run, which the task manager skipped, so the board showed a working agent's task under Open until it reported (17 Sep, #448). Now the task stays In progress, and the answer reaches the running agent once, in the result of its next task tool call. With no live run, the agent is continued with the answer as before.

## 0.8.9 · 2026-09-17

- The task manager no longer runs out of memory on a large board. A board of a few hundred tasks is a 15 MB snapshot; the board asked for a new one on every change while the last was still arriving, and the unsent replies piled up until the process died (24 times on 17 Sep, each time cutting running agents off from the board). Now a connection that falls more than 64 MB behind is dropped and reconnects, a subscriber that is behind misses pushes until it catches up, and the board asks for one snapshot at a time, at most one a second.
- Reading a large reply is linear again: the client no longer searches its whole buffer on every chunk (a 15.7 MB snapshot took 11 s to read, now 0.2 s).
- A new `summary` request carries the counts without the task bodies. The status line, the hooks, the MCP bridge's start, `board_summary` and `am status` use it instead of the whole snapshot, and fall back to the snapshot on an older task manager. `task_list` asks for tasks without their notes.

## 0.8.2 · 2026-09-09

- The 90% context line holds. Until now the checkpoint notice reached an agent only through the result of a task tool, so an agent busy reading and editing files could run past 100% without seeing it. Two fixes: every Claude Code agent now carries a hook that refuses its next tool call with the notice once it is over the line, so it sees it on its very next action; and if an agent still has not checkpointed after `agent.compact-grace` minutes (default 3) or at 98% as a last resort, the task manager ends the run, writes the checkpoint itself from what it saw (last progress, last words, recent actions) and continues the task in a fresh session, telling the GM for awareness.
- An agent whose last session is already over the line starts its next task in a fresh session rather than inheriting a full window.
- Safeguards around that: a run that is already over the line before it has done anything, or a third short compaction in a row, means the brief itself is too big; the task goes on hold with a note asking the GM to trim its notes or split it, instead of compacting in a loop. The agent's brief now carries only the latest checkpoint note, since earlier ones are superseded.

## 0.8.1 · 2026-09-09

- Nobody sits idle: the moment an agent reports a task finished, the task manager gives it the next open task by itself, most urgent first (priority, then ETA), preferring an agent that already worked on that task's parent or siblings. Friday is told for awareness. Tasks waiting on another task are skipped, and so are tasks on hold. `tm.autostart false` restores the old behaviour, where only tasks someone started are picked up.
- On hold is now explicit: stopping a task without feedback parks it, `am task hold #id` and Friday's `task_update hold=true` do the same, and `am task start #id` releases it. The board labels such tasks "on hold".

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
