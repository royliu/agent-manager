#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { ProviderIdSchema, type ProviderId } from './core/config.js';
import { migrateProfileNames } from './core/migrate.js';
import { addCommand } from './commands/add.js';
import { doctorCommand } from './commands/doctor.js';
import { initCommand } from './commands/init.js';
import { listCommand } from './commands/list.js';
import { removeCommand } from './commands/remove.js';
import { runCommand } from './commands/run.js';
import { shellHookCommand } from './commands/shell.js';
import { statusCommand } from './commands/status.js';
import { envCommand, useCommand, whichCommand } from './commands/use.js';
import { startCommand } from './commands/start.js';
import { gmCommand, gmListCommand, gmRemoveCommand, gmShowCommand } from './commands/gm.js';
import { stopCommand } from './commands/stop.js';
import { tasksCommand } from './commands/tasks.js';
import { taskCommand } from './commands/task.js';
import { agentCommand } from './commands/agent.js';
import { configCommand } from './commands/swarmconfig.js';
import { serveCommand } from './commands/serve.js';
import { runMcpBridge } from './swarm/mcp.js';
import { hookCommand } from './swarm/hooks.js';
import { closePrompts } from './ui/prompt.js';
import { getProvider } from './providers/index.js';
import { bold, dim, red, yellow } from './ui/format.js';

const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

function parseProvider(value: string | undefined): ProviderId | undefined {
  if (!value) return undefined;
  const parsed = ProviderIdSchema.safeParse(value);
  if (!parsed.success) {
    console.error(`${red('✗')} Unknown provider "${value}".`);
    process.exit(1);
  }
  return parsed.data;
}

/** Old names keep working for a release; say once, on stderr, what the new name is. */
function renamed(oldName: string, newName: string): void {
  if (process.stderr.isTTY) console.error(dim(`  (${oldName} is now ${newName})`));
}

const program = new Command();

program
  .name('am')
  .description(
    'agent-manager: several Claude Code / Codex subscriptions on one machine, and a team of agents per project.\n\n' +
      '  Words: a profile is one account of one tool. A GM is the General Manager you talk to in a project\n' +
      '  folder; its name stands for its whole team. The board is where you watch tasks and agents.\n' +
      '  Verbs: start/stop for work that runs in the background (a GM, a task) · open for a conversation ·\n' +
      '  run for a tool in the foreground · use for a switch that stays · ls/add/rm/show on any collection.\n' +
      '  Shortcuts: am (= am status) · am run (= am profile run) · am gm (= am gm open) · am board.',
  )
  .version(VERSION)
  .enablePositionalOptions()
  .addHelpText('after', '\nFull guide: docs/GUIDE.md in the repository.');

// ------------------------------------------------------------ home and setup
program
  .command('status', { isDefault: true })
  .alias('st')
  .description('home screen: every profile with plan, quota and 24h use; every GM and what needs you')
  .option('-w, --watch', 'live dashboard')
  .option('-i, --interval <seconds>', 'refresh interval for --watch', '10')
  .option('-p, --provider <provider>', 'limit to one tool')
  .option('--live', 'also poll the provider for authoritative quota % (cached, backs off on 429)')
  .option('--json', 'machine-readable output')
  .action(async (opts) => {
    await statusCommand({
      watch: opts.watch,
      json: opts.json,
      live: opts.live,
      interval: Number.parseInt(opts.interval, 10) || 10,
      provider: parseProvider(opts.provider),
    });
  });

program
  .command('init')
  .description('first-run setup: register the accounts you are already signed into, install the shell hook')
  .option('-y, --yes', 'accept the defaults, never prompt')
  .action(async (opts) => {
    await initCommand(opts);
  });

program
  .command('doctor')
  .description('check installs, logins, isolation, the shell hook, and billing-override variables')
  .action(async () => {
    await doctorCommand();
  });

// ------------------------------------------------------------------ profiles
const profile = program
  .command('profile')
  .description('your accounts: am profile ls | add [name] | rm <name> | use <name> | run <name> [-- args]')
  .action(() => {
    listCommand({});
  });

profile
  .command('ls')
  .alias('list')
  .description('list profiles; the active one is marked')
  .option('--json', 'machine-readable output')
  .action((opts) => {
    listCommand(opts);
  });

profile
  .command('add')
  .description('create a new isolated profile and walk you through signing in')
  .argument('[name]', 'profile name, e.g. work')
  .option('-p, --provider <provider>', 'claude-code | codex | claude-desktop | gemini | cursor')
  .option('-l, --label <label>', 'human note, e.g. "Work — Max 20x"')
  .option('--home <dir>', 'use a specific config directory instead of the managed one')
  .option('-y, --yes', 'accept defaults, never prompt')
  .action(async (name, opts) => {
    await addCommand(name, opts);
  });

profile
  .command('rm')
  .alias('remove')
  .description('unregister a profile (its data is kept unless you pass --purge)')
  .argument('<name>')
  .option('-p, --provider <provider>')
  .option('--purge', 'also delete the profile directory and its login')
  .option('-y, --yes', 'skip confirmation')
  .action(async (name, opts) => {
    await removeCommand(name, { ...opts, provider: parseProvider(opts.provider) });
  });

profile
  .command('use')
  .description('switch this shell to a profile (needs the shell hook: am init, or am shell hook)')
  .argument('<name>')
  .option('-p, --provider <provider>')
  .action(async (name, opts) => {
    await useCommand(name, { provider: parseProvider(opts.provider) });
  });

profile
  .command('run')
  .description('open the tool on a profile, in the foreground; everything after the name is passed through')
  .argument('[name]', 'profile name (defaults to the active profile)')
  .argument('[args...]', 'arguments forwarded to the tool')
  .option('-p, --provider <provider>')
  .option('--keep-api-keys', 'do not strip ANTHROPIC_API_KEY / OPENAI_API_KEY')
  .passThroughOptions()
  .allowUnknownOption()
  .action(async (name, args: string[], opts) => {
    await runCommand(name, args ?? [], { provider: parseProvider(opts.provider), keepApiKeys: opts.keepApiKeys });
  });

program
  .command('run')
  .description('open the tool on a profile (short for am profile run): am run work [-- args]')
  .argument('[name]', 'profile name (defaults to the active profile)')
  .argument('[args...]', 'arguments forwarded to the tool')
  .option('-p, --provider <provider>')
  .option('--keep-api-keys', 'do not strip ANTHROPIC_API_KEY / OPENAI_API_KEY')
  .passThroughOptions()
  .allowUnknownOption()
  .action(async (name, args: string[], opts) => {
    await runCommand(name, args ?? [], { provider: parseProvider(opts.provider), keepApiKeys: opts.keepApiKeys });
  });

// ------------------------------------------------------------------------ gm
const gm = program
  .command('gm')
  .description('the General Manager of this folder: am gm [name] opens the conversation · start | stop | ls | show | rm')
  .argument('[name]', 'GM name (defaults to the one for this folder)')
  .action(async (name) => {
    await gmCommand(name);
  });

gm
  .command('start')
  .description('start a GM here on a profile and open the conversation: am gm start <profile> [name]')
  .argument('<profile>', 'a Claude Code or Codex profile, e.g. personal')
  .argument('[name]', 'a name for the GM, e.g. friday (defaults to the folder name)')
  .option('--agents <n>', 'task agents to create (default: team.size)')
  .option('--gm-model <model>', "the GM's model for this GM only, an official id such as claude-fable-5-1 (default: the profile's model; \"default\" clears)")
  .option('--tm-model <model>', "the task manager's model for this GM only")
  .option('--agent-model <model>', "the task agents' model for this GM only")
  .option('--codex-agent-model <model>', 'the model for task agents on Codex profiles')
  .option('--agent-profile <profile>', "the profile task agents run on, for this GM only: any Claude Code or Codex profile (default: the GM's)")
  .option('--dir <path>', 'workspace folder (default: current folder)')
  .option('--no-open', 'start the team in the background without opening the conversation')
  .option('--keep-api-keys', 'do not strip ANTHROPIC_API_KEY / OPENAI_API_KEY')
  .option('--dry-run', 'set everything up and print the command instead of opening the session')
  .action(async (profileName, name, opts) => {
    await startCommand(profileName, name, opts);
  });

gm
  .command('open')
  .description("open the GM's conversation where you left it")
  .argument('[name]')
  .action(async (name) => {
    await gmCommand(name);
  });

gm
  .command('stop')
  .description("stop the GM's team and task manager; the board is kept")
  .argument('[name]')
  .action(async (name) => {
    await stopCommand(name);
  });

gm
  .command('ls')
  .alias('list')
  .description('every GM: profile, running or stopped, folder')
  .option('--json', 'machine-readable output')
  .action((opts) => {
    gmListCommand(opts);
  });

gm
  .command('show')
  .description('one GM in full: models, team, workspace, what needs you')
  .argument('[name]')
  .option('--json', 'machine-readable output')
  .action(async (name, opts) => {
    await gmShowCommand(name, opts);
  });

gm
  .command('rm')
  .alias('remove')
  .description("forget a stopped GM: its tasks, notes, runs and team are deleted; the project folder is untouched")
  .argument('<name>')
  .option('-y, --yes', 'skip confirmation')
  .action(async (name, opts) => {
    await gmRemoveCommand(name, opts);
  });

// ---------------------------------------------------------- board and tasks
program
  .command('board')
  .description('the board: every task and every agent, live (kanban when wide, a list when narrow)')
  .argument('[name]', 'GM name (defaults to the one for this folder)')
  .option('-g, --group <by>', 'status | agent | eta', 'status')
  .option('--json', 'print the board as JSON')
  .option('--size <cols>x<rows>', 'override the terminal size if your host reports it wrong (also AM_BOARD_SIZE)')
  .action(async (name, opts) => {
    await tasksCommand(name, opts);
  });

program
  .command('task')
  .description('one task, from the shell: ls | show | add | note | eta | answer | approve | reject | stop | start | hold | assign | cancel | retry  #id …')
  .argument('<action>')
  .argument('[args...]')
  .option('--gm <name>', 'GM name (defaults to the one for this folder)')
  .option('--agent <name>', 'agent for add / start / assign')
  .option('--description <text>', 'description for add')
  .option('--eta <when>', 'when it should be done, e.g. 2h, 1d, or a date and time (add)')
  .option('--start', 'start it right away (add)')
  .option('--json', 'machine-readable output')
  .option('--swarm <name>', 'old name of --gm')
  .option('--dispatch', 'old name of --start')
  .action(async (action, args: string[], opts) => {
    await taskCommand(action, args ?? [], { ...opts, gm: opts.gm ?? opts.swarm, start: opts.start ?? opts.dispatch });
  });

program
  .command('agent')
  .description('the task agents: ls | add [name] [--profile <p>] [--model <m>] | rm <name> | move <name> --profile <p>')
  .argument('<action>')
  .argument('[name]')
  .option('--gm <name>', 'GM name (defaults to the one for this folder)')
  .option('--profile <name>', 'profile for add / move')
  .option('--model <id>', 'model for add')
  .option('--json', 'machine-readable output')
  .option('--swarm <name>', 'old name of --gm')
  .action(async (action, name, opts) => {
    await agentCommand(action, name, { ...opts, gm: opts.gm ?? opts.swarm });
  });

program
  .command('config')
  .description('settings for every GM: am config lists them · am config <group.key> <value> sets one · "default" clears')
  .argument('[key]', 'e.g. model.tm, profile.agents, team.size, gm.propose, tm.answers, agent.compact-at, limits.budget-usd')
  .argument('[value]')
  .action(async (key, value) => {
    await configCommand(key, value);
  });

// -------------------------------------------------------------------- shell
const shell = program
  .command('shell')
  .description('shell integration: am shell hook [zsh|bash|fish] prints the hook · am shell env <profile> prints its exports')
  .action(() => {
    shell.help();
  });

shell
  .command('hook')
  .description('print the hook that lets "am profile use" change the current shell')
  .argument('[shell]', 'zsh | bash | fish (auto-detected by default)')
  .action((sh) => {
    shellHookCommand(sh);
  });

shell
  .command('env')
  .description('print the exports for a profile (what the hook evaluates)')
  .argument('<name>')
  .option('-p, --provider <provider>')
  .action((name, opts) => {
    envCommand(name, { provider: parseProvider(opts.provider) });
  });

// --------------------------------------------------------- hidden plumbing
program
  .command('_serve', { hidden: true })
  .option('--gm <name>')
  .option('--swarm <name>')
  .action((opts) => {
    serveCommand(opts.gm ?? opts.swarm);
  });

program
  .command('_bridge', { hidden: true })
  .option('--gm <name>')
  .option('--swarm <name>')
  .requiredOption('--role <role>')
  .option('--agent <name>')
  .option('--task <id>')
  .action(async (opts) => {
    await runMcpBridge({ swarm: opts.gm ?? opts.swarm, role: opts.role === 'gm' ? 'gm' : 'agent', agent: opts.agent, task: opts.task ? Number.parseInt(opts.task, 10) : undefined });
  });

program
  .command('_hook', { hidden: true })
  .argument('<kind>')
  .option('--gm <name>')
  .option('--swarm <name>')
  .action(async (kind, opts) => {
    await hookCommand(kind as 'inbox' | 'stop' | 'status', opts.gm ?? opts.swarm);
  });

// Old plumbing names, still spawned by task managers and GM sessions started before 0.7.0.
program.command('tm-serve', { hidden: true }).requiredOption('--swarm <name>').action((opts) => serveCommand(opts.swarm));
program
  .command('mcp', { hidden: true })
  .requiredOption('--swarm <name>')
  .requiredOption('--role <role>')
  .option('--agent <name>')
  .option('--task <id>')
  .action(async (opts) => {
    await runMcpBridge({ swarm: opts.swarm, role: opts.role === 'gm' ? 'gm' : 'agent', agent: opts.agent, task: opts.task ? Number.parseInt(opts.task, 10) : undefined });
  });
program
  .command('tm-hook', { hidden: true })
  .argument('<kind>')
  .requiredOption('--swarm <name>')
  .action(async (kind, opts) => {
    await hookCommand(kind as 'inbox' | 'stop' | 'status', opts.swarm);
  });

// ------------------------------------------- old names, kept for one release
program
  .command('ls', { hidden: true })
  .alias('list')
  .option('--json')
  .action((opts) => {
    renamed('am ls', 'am profile ls');
    listCommand(opts);
  });
program
  .command('add', { hidden: true })
  .argument('[name]')
  .option('-p, --provider <provider>')
  .option('-l, --label <label>')
  .option('--home <dir>')
  .option('-y, --yes')
  .action(async (name, opts) => {
    renamed('am add', 'am profile add');
    await addCommand(name, opts);
  });
program
  .command('rm', { hidden: true })
  .alias('remove')
  .argument('<name>')
  .option('-p, --provider <provider>')
  .option('--purge')
  .option('-y, --yes')
  .action(async (name, opts) => {
    renamed('am rm', 'am profile rm');
    await removeCommand(name, { ...opts, provider: parseProvider(opts.provider) });
  });
program
  .command('use', { hidden: true })
  .argument('<name>')
  .option('-p, --provider <provider>')
  .action(async (name, opts) => {
    renamed('am use', 'am profile use');
    await useCommand(name, { provider: parseProvider(opts.provider) });
  });
program
  .command('which', { hidden: true })
  .action(() => {
    renamed('am which', 'am status');
    whichCommand();
  });
program
  .command('env', { hidden: true })
  .argument('<name>')
  .option('-p, --provider <provider>')
  .action((name, opts) => {
    // No hint: the output is evaluated by the shell hook.
    envCommand(name, { provider: parseProvider(opts.provider) });
  });
program
  .command('shell-init', { hidden: true })
  .argument('[shell]')
  .action((sh) => {
    renamed('am shell-init', 'am shell hook');
    shellHookCommand(sh);
  });
program
  .command('start', { hidden: true })
  .argument('<profile>')
  .argument('[kind]')
  .argument('[name]')
  .option('--agents <n>')
  .option('--gm-model <model>')
  .option('--tm-model <model>')
  .option('--agent-model <model>')
  .option('--codex-agent-model <model>')
  .option('--agent-profile <profile>')
  .option('--dir <path>')
  .option('--keep-api-keys')
  .option('--dry-run')
  .action(async (profileName, kind, name, opts) => {
    renamed('am start', 'am gm start');
    await startCommand(profileName, kind === 'gm' ? name : kind, opts);
  });
program
  .command('stop', { hidden: true })
  .argument('[name]')
  .action(async (name) => {
    renamed('am stop', 'am gm stop');
    await stopCommand(name);
  });
program
  .command('tasks', { hidden: true })
  .alias('tm')
  .argument('[name]')
  .option('-g, --group <by>', '', 'status')
  .option('--json')
  .option('--size <cols>x<rows>')
  .action(async (name, opts) => {
    renamed('am tasks', 'am board');
    await tasksCommand(name, opts);
  });

/**
 * Announce a one-time rename on stderr, so JSON on stdout and the shell hook's
 * `am shell env` output stay clean.
 */
function reportMigration(): void {
  const renames = migrateProfileNames();
  if (renames.length === 0) return;
  console.error('');
  console.error(`  ${yellow('!')} Profile names are now unique across tools, so these were renamed:`);
  for (const r of renames) {
    console.error(
      `    ${dim(getProvider(r.provider).displayName.padEnd(16))} ${r.from} → ${bold(r.to)}`,
    );
  }
  console.error('');
}

async function main(): Promise<void> {
  try {
    reportMigration();
    await program.parseAsync(process.argv);
  } catch (error) {
    console.error(`${red('✗')} ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    closePrompts();
  }
}

void main();
