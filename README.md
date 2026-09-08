# agent-manager

Run multiple Claude Code, Codex, and other agent subscriptions on one machine —
with isolated profiles, guided setup, and one place to see which subscription is
active and what it is costing you.

```
  PROFILE  TOOL     PLAN     ACCOUNT              QUOTA                               24H     LAST USE
  personal claude   Max 20x  you@gmail.com        5h █░░░░░░░   8%  7d ██████░░  75%   42.2M   just now
           ↳ $25.15 of list-price usage absorbed by this subscription in 24h
● work     claude   Pro      you@company.com      5h ███░░░░░  34%  7d ██░░░░░░  22%   8.1M    2h ago
  codex    codex    Pro      you@company.com      1w ░░░░░░░░   1%                     4.5M    14h ago
```

## Install

```sh
npm install -g agent-manager     # provides `am`
# or run without installing:
npx agent-manager status
```

## Quick start

```sh
am init      # register the accounts you're already signed into (nothing is moved)
am add       # create a second, isolated profile and sign in
am status    # plan, quota, consumption for everything
am run work  # launch a tool under a profile
```

Profile names are unique across every tool, so a name always identifies exactly
one profile: `am init` names the accounts it adopts after their tool (`claude`,
`codex`, `desktop`), and `am run <name>` never needs a `--provider` to know what
you meant.

Add the shell hook once so `am use` can change your current shell:

```sh
am shell-init >> ~/.zshrc && exec zsh
```

## How isolation works

Each profile is a separate config directory. Nothing is copied, symlinked, or
swapped in place — the tool is simply pointed at a different directory, so your
existing install keeps working exactly as it did.

| Tool | Mechanism | Isolates |
|---|---|---|
| Claude Code | `CLAUDE_CONFIG_DIR` | credentials, settings, history, projects, MCP, plugins |
| Codex CLI | `CODEX_HOME` | `auth.json`, config, sessions, history |
| Claude Desktop | `--user-data-dir` | full Electron profile |
| Gemini / Cursor | `HOME` redirection | whole dotfile directory (coarser — no config-dir variable exists) |

**Credentials really are isolated.** On macOS, Claude Code stores its OAuth
token in the Keychain, which makes it look like profiles would collide. They
don't: a fresh `CLAUDE_CONFIG_DIR` reports "Not logged in" even with a Keychain
entry present, so each profile holds its own login.

## The billing trap

`ANTHROPIC_API_KEY` and `OPENAI_API_KEY` silently override subscription auth.
If either is exported, your "subscription" profile quietly bills per token and
never touches the plan you're paying for.

`am run` strips those variables by default, and the shell hook unsets them when
you switch profiles. `am doctor` tells you when your shell has one set. If you
actually want API-key billing for a run, opt back in explicitly:

```sh
am run --keep-api-keys work -- -p "hello"
```

## Where usage numbers come from

Local-first, so the dashboard works offline and can't be rate-limited:

- **Codex** caches authoritative quota (`used_percent`, window, reset time) into
  every session log, so percentages are read straight off disk — no API call.
- **Claude Code** doesn't cache quota locally, so percentages need `--live`,
  which polls the OAuth usage endpoint. That endpoint rate-limits aggressively,
  so results are cached for 5 minutes and back off up to an hour on a 429.
- **Token counts and cost** are always parsed from local transcripts, deduped
  per billed request.

The dollar figure is the **list price of the same work**, not what you were
charged — on a subscription it's the value your plan absorbed.


## A team of agents per project: `am start`

`am` can also run a swarm on your profiles. In a project folder:

```sh
am start personal gm friday     # personal = any Claude Code or Codex profile; the name is yours
```

That sets up a **task manager** and **four task agents** (`friday-1` … `friday-4`) on the
`personal` profile, captures the workspace you are standing in (folder, branch, your shell
environment with API keys stripped), and hands the terminal to Claude Code running as
**Friday**, the General Manager. You talk to Friday in plain language; it discusses, breaks
work into tasks with short ids (`#12`), assigns them, and reviews what comes back.

In another terminal:

```sh
am tasks                        # the board: kanban when wide, a list when narrow
```

You see two things: Friday and the board. Everything else is Friday's business.

| Command | Does |
|---|---|
| `am start <profile> gm [name] [--agents N]` | create or resume a General Manager in this folder |
| `am gm` · `am gm ls` | come back to Friday's conversation · list every GM |
| `am tasks [name] [--group status\|agent\|eta] [--json]` | the board, live |
| `am task show\|add\|note\|answer\|approve\|reject\|cancel\|retry\|reassign\|dispatch #id …` | act on a task from the shell |
| `am agent ls\|add\|rm\|move` | the team (add an agent on another profile: `am agent add --profile work`) |
| `am stop [name]` | stop the team and task manager; the board is kept |
| `am config swarm.<key> [value]` | `agents` `dispatch` `triage` `triageModel` `notify` `stallAfterMin` `compactAt` `agentModel` `codexAgentModel` `budgetUsd` |

**Board keys.** `↑↓←→` move · `⏎` open a task · `g` group by status, agent or ETA · `s` sort ·
`d` hide done · `/` filter · `r` reply to a question · `a` approve · `x` send back with
feedback · `n` note · `p` priority · `c` cancel · `K` pause every agent · `q` quit. The mouse
works too: wheel to scroll, click to select, double-click to open (hold Shift to select text).

**Three rules the team follows.**

1. *Who talks to whom.* Agents ask the task manager, which is a board on the surface and
   an agent underneath: it reasons from your intent as written down (the project brief Friday
   keeps, your asks, notes and decisions, the workspace conventions, the code it can read),
   decides the way Friday would, and answers so the agent can act. Only the rare judgment
   call reaches Friday: scope or cost changes when your intent is unknown, anything hard to
   undo, contradicting notes. Friday answers or asks you, and otherwise stays in the
   conversation with you. Whoever answers, the answer becomes a note and the agent resumes.
2. *Plain English, with context.* Every question an agent asks must say what the task is
   for, what is known, the exact question, the options, and what it will do if nobody
   answers. The task manager refuses a question without those parts.
3. *Checkpoint at 90%, then a fresh context.* When an agent's context passes the line, it
   writes a checkpoint note on its task, refreshes its one-paragraph project memory, and is
   continued in a fresh session from the note. The board is the memory.

One folder, one GM. Running `am start` again in a folder that has one resumes it. A git
worktree is its own folder and can have its own GM.

Where things live: `~/.agent-manager/swarms/<name>/` holds the tasks, notes, events, the
team, the workspace brief and the agents' run logs; `swarms.json` maps names to folders.

Models: the GM runs on the profile's default model; every other agent, the four task agents
and the task manager, runs on Opus by default (`swarm.agentModel`, `swarm.triageModel`).
Codex agents work through the same tools; give them a model with `swarm.codexAgentModel`
or leave the tool's default. Compaction: `am` asks the tool to compact
at `swarm.compactAt` where it exposes a setting (`swarm.compactEnv`), and independently
watches each agent's context and drives the checkpoint-and-fresh-session step itself.

## Commands

| Command | Does |
|---|---|
| `am init` | detect installed tools, register existing logins |
| `am add [name]` | guided setup for a new isolated profile |
| `am status [--watch] [--live] [--json]` | plan, quota, consumption |
| `am ls` | list profiles |
| `am use <name>` | make a profile active (shell-wide with the hook) |
| `am run [name] [-- args]` | launch a tool under a profile |
| `am which` | what's active right now |
| `am doctor` | installs, logins, isolation, billing-override checks |
| `am rm <name> [--purge]` | unregister (and optionally delete) a profile |
| `am shell-init [zsh\|bash\|fish]` | print the shell hook |

Options come **before** the profile name so everything after it passes through
untouched: `am run --provider codex work -- --resume`.

## Where things live

```
~/.agent-manager/
  profiles.json          registry
  state.json             active profile per tool
  cache/                 live-quota cache (no secrets)
  profiles/<tool>/<name>/  isolated config dirs
```

Claude Desktop profiles live in `~/Library/Application Support/Claude-<name>`
because the app requires them there.

## Safety

- Existing installs are registered **by reference** and never moved or rewritten.
- `--purge` refuses to delete a directory agent-manager didn't create.
- Credentials are never logged, copied, or written to the cache. The OAuth token
  is read only to call the usage endpoint with it.

## License

MIT
