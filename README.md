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

Full instructions, from install to day-to-day use of the team: **[docs/GUIDE.md](docs/GUIDE.md)**.

## Install

Node.js 18+, git, and the Claude Code CLI (`claude`); Codex (`codex`) only for Codex profiles.

```sh
git clone https://github.com/royliu/agent-manager.git
cd agent-manager && npm install && npm run build
npm install -g .                 # provides `am` (or `npm link` while developing)
am --version
```

## Quick start

```sh
am init              # register the accounts you're already signed into, install the shell hook
am profile add       # create a second, isolated profile and sign in
am status            # home screen: plan, quota and consumption per profile; every GM
am run work          # open a tool on a profile (short for am profile run)
```

Profile names are unique across every tool, so a name always identifies exactly
one profile: `am init` names the accounts it adopts after their tool (`claude`,
`codex`, `desktop`), and `am run <name>` never needs a `--provider` to know what
you meant.

`am init` offers to install the shell hook, which lets `am profile use` switch the profile
of your current shell. By hand:

```sh
am shell hook >> ~/.zshrc && exec zsh
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


## A team of agents per project: `am gm start`

`am` can also run a team of agents on your profiles. Step by step:

**1. Start a General Manager in a project folder.**

```sh
cd ~/Projects/genie
am gm start personal friday     # personal = any Claude Code or Codex profile; the name is yours
```

That sets up a **task manager** and **four task agents** (`friday-1` … `friday-4`) on the
`personal` profile, captures the workspace you are standing in (folder, branch, your shell
environment with API keys stripped), and hands the terminal to Claude Code running as
**Friday**, the General Manager.

**2. Talk to Friday.** Plain language, as you would brief a lead engineer. Friday discusses
first, then proposes the tasks it would create and waits for your "go". Tasks get short ids
(`#12`), an owner and an ETA; independent parts go to different agents at the same time.

**3. Watch the board in another terminal.**

```sh
am board                        # kanban when wide, a list when narrow; keys shown on screen
```

**4. Answer and approve as things come up.** Agents' questions go to the task manager, which
answers most of them itself. What reaches you shows as "needs you" on the board: `r` to
reply, `a` to accept finished work, `x` to send it back or stop it. Or just tell Friday.

**5. Come and go.** Close the terminal any time; the team keeps working. `am gm` reopens
Friday's conversation, `am gm stop` ends the team, and the board is kept either way.

You see two things: Friday and the board. Everything else is Friday's business.

| Command | Does |
|---|---|
| `am gm start <profile> [name] [--agents N] [--gm-model\|--tm-model\|--agent-model <m>] [--no-open]` | start a GM here and open the conversation; model flags are remembered for this GM |
| `am gm [name]` · `am gm open [name]` | open Friday's conversation where you left it |
| `am gm stop [name]` | stop the team and task manager; the board is kept |
| `am gm ls` · `am gm show [name]` · `am gm rm <name>` | every GM · one GM in full (models, team, what needs you) · forget a stopped GM |
| `am board [name] [-g status\|agent\|eta] [--json]` | the board, live |
| `am task ls\|show\|add\|note\|eta\|answer\|approve\|reject\|stop\|start\|assign\|cancel\|retry #id …` | act on a task from the shell (`--gm <name>` from elsewhere) |
| `am agent ls\|add\|rm\|move` | the task agents (add one on another profile: `am agent add --profile work`) |
| `am config [group.key] [value]` | for every GM: `model.gm` `model.tm` `model.agents` `team.size` `gm.propose` `tm.answers` `agent.compact-at` `limits.budget-usd` … (`default` clears) |

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

One folder, one GM. Running `am gm start` again in a folder that has one resumes it. A git
worktree is its own folder and can have its own GM.

Where things live: `~/.agent-manager/swarms/<name>/` holds the tasks, notes, events, the
team, the workspace brief and the agents' run logs; `swarms.json` maps names to folders.

Models: three groups, each yours to set: the GM, the task manager, and the task agents.
By default all three run on the profile's own model (the `model` in that profile's Claude
Code settings, or Codex config). Change one for every GM with `am config model.gm`,
`model.tm` or `model.agents`; for one GM with `am gm start … --gm-model`, `--tm-model`
or `--agent-model` (remembered for that GM); or just ask Friday, who has a tool for it and
changes models only when you ask. `default` puts a group back on the profile's model.
`am agent ls` and Friday's team list show what everyone runs on. A new GM model applies when
you next open the conversation; the task manager's at its next answer; the agents' at their
next run. Agents on Codex profiles have their own key, `model.codex-agents`, since Codex has its
own model names. Compaction: `am` asks the tool to compact
at `agent.compact-at` where it exposes a setting (`agent.compact-env`), and independently
watches each agent's context and drives the checkpoint-and-fresh-session step itself.

## Commands

| Command | Does |
|---|---|
| `am` · `am status [--watch] [--live] [--json]` | home screen: every profile's plan, quota and consumption; every GM |
| `am init` | first-run setup: register existing logins, install the shell hook |
| `am doctor` | installs, logins, isolation, the shell hook, billing-override checks |
| `am profile ls` | list profiles; the active one is marked |
| `am profile add [name]` | guided setup for a new isolated profile |
| `am profile rm <name> [--purge]` | unregister (and optionally delete) a profile |
| `am profile use <name>` | switch this shell to a profile (with the hook) |
| `am run <name> [-- args]` · `am profile run` | open a tool on a profile, in the foreground |
| `am shell hook [zsh\|bash\|fish]` · `am shell env <name>` | print the shell hook · print a profile's exports |

Options come **before** the profile name so everything after it passes through
untouched: `am run --provider codex work -- --resume`.

**How commands are named.** A noun, then a verb. The nouns are the things in the story:
`profile`, `gm`, `board`, `task`, `agent`, and `shell` for plumbing. Each verb means one thing
everywhere: `start` and `stop` for work in the background (a GM, a task), `open` for a
conversation, `run` for a tool in the foreground, `use` for a switch that stays, and `ls`,
`add`, `rm`, `show`, `assign`, `move` on the collections. Four shortcuts drop the noun: `am`
(status), `am run`, `am gm` (open) and `am board`. Names from before 0.7.0 (`am tasks`, `am start`, `am add`, …) still work and print the new name.

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
