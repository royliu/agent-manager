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
import { shellInitCommand } from './commands/shell.js';
import { statusCommand } from './commands/status.js';
import { envCommand, useCommand, whichCommand } from './commands/use.js';
import { startCommand } from './commands/start.js';
import { gmCommand, gmListCommand } from './commands/gm.js';
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

const program = new Command();

program
  .name('am')
  .description(
    'Run multiple Claude Code / Codex / agent subscriptions on one machine.\n' +
      'Isolated profiles, guided setup, and live usage in one place.',
  )
  .version(VERSION)
  .enablePositionalOptions();

program
  .command('init')
  .description('detect installed tools and register accounts you are already signed into')
  .option('-y, --yes', 'skip confirmation')
  .action(async (opts) => {
    await initCommand(opts);
  });

program
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

program
  .command('status', { isDefault: true })
  .alias('st')
  .description('show plan, quota and consumption for every profile')
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
  .command('list')
  .alias('ls')
  .description('list registered profiles')
  .option('--json', 'machine-readable output')
  .action((opts) => {
    listCommand(opts);
  });

program
  .command('use')
  .description('make a profile the active one')
  .argument('<name>')
  .option('-p, --provider <provider>')
  .action(async (name, opts) => {
    await useCommand(name, { provider: parseProvider(opts.provider) });
  });

program
  .command('env')
  .description('print shell exports for a profile (used by the shell hook)')
  .argument('<name>')
  .option('-p, --provider <provider>')
  .action((name, opts) => {
    envCommand(name, { provider: parseProvider(opts.provider) });
  });

program
  .command('run')
  .description('launch a tool under a profile; everything after the name is passed through')
  .argument('[name]', 'profile name (defaults to the active profile)')
  .argument('[args...]', 'arguments forwarded to the tool')
  .option('-p, --provider <provider>')
  .option('--keep-api-keys', 'do not strip ANTHROPIC_API_KEY / OPENAI_API_KEY')
  .passThroughOptions()
  .allowUnknownOption()
  .action(async (name, args: string[], opts) => {
    await runCommand(name, args ?? [], {
      provider: parseProvider(opts.provider),
      keepApiKeys: opts.keepApiKeys,
    });
  });

program
  .command('which')
  .description('show which profile is active for each tool')
  .action(() => {
    whichCommand();
  });

program
  .command('doctor')
  .description('check installs, logins, isolation, and billing-override variables')
  .action(async () => {
    await doctorCommand();
  });

program
  .command('remove')
  .alias('rm')
  .description('unregister a profile (its data is kept unless you pass --purge)')
  .argument('<name>')
  .option('-p, --provider <provider>')
  .option('--purge', 'also delete the profile directory and its login')
  .option('-y, --yes', 'skip confirmation')
  .action(async (name, opts) => {
    await removeCommand(name, { ...opts, provider: parseProvider(opts.provider) });
  });

// ---------------------------------------------------------------- swarm
program
  .command('start')
  .description('start a General Manager in this folder: am start <profile> gm [name]')
  .argument('<profile>', 'a Claude Code or Codex profile, e.g. personal')
  .argument('<kind>', 'gm')
  .argument('[name]', 'a name for the General Manager, e.g. friday (defaults to the folder name)')
  .option('--agents <n>', 'number of task agents to create (default from swarm.agents)')
  .option('--dir <path>', 'workspace folder (default: current folder)')
  .option('--keep-api-keys', 'do not strip ANTHROPIC_API_KEY / OPENAI_API_KEY')
  .option('--dry-run', 'set everything up and print the command instead of starting the session')
  .action(async (profile, kind, name, opts) => {
    await startCommand(profile, kind, name, opts);
  });

program
  .command('gm')
  .description('come back to the General Manager in this folder (am gm ls lists them all)')
  .argument('[name]', 'GM name, or "ls"')
  .option('--json', 'machine-readable output for ls')
  .action(async (name, opts) => {
    if (name === 'ls' || name === 'list') gmListCommand(opts);
    else await gmCommand(name);
  });

program
  .command('tasks')
  .alias('tm')
  .alias('board')
  .description('the board: every task and every agent, live')
  .argument('[name]', 'GM name (defaults to the one for this folder)')
  .option('-g, --group <by>', 'status | agent | eta', 'status')
  .option('--json', 'print the board as JSON')
  .option('--size <cols>x<rows>', 'override the terminal size if your host reports it wrong (also AM_BOARD_SIZE)')
  .action(async (name, opts) => {
    await tasksCommand(name, opts);
  });

program
  .command('task')
  .description('act on a task from the shell: show|add|eta|note|answer|approve|reject|cancel|retry|reassign|dispatch #id …')
  .argument('<action>')
  .argument('[args...]')
  .option('--swarm <name>', 'GM name (defaults to the one for this folder)')
  .option('--agent <name>', 'agent for add/dispatch/reassign')
  .option('--description <text>', 'description for add')
  .option('--dispatch', 'start right away (add)')
  .option('--eta <when>', 'when it should be done, e.g. 2h, 1d, or a date and time (add)')
  .option('--json', 'machine-readable output')
  .action(async (action, args: string[], opts) => {
    await taskCommand(action, args ?? [], opts);
  });

program
  .command('agent')
  .description('the team: ls | add [name] | rm <name> | move <name> --profile <p>')
  .argument('<action>')
  .argument('[name]')
  .option('--swarm <name>', 'GM name (defaults to the one for this folder)')
  .option('--profile <name>', 'profile for add/move')
  .option('--model <id>', 'model for add')
  .option('--json', 'machine-readable output')
  .action(async (action, name, opts) => {
    await agentCommand(action, name, opts);
  });

program
  .command('stop')
  .description('stop the General Manager\'s team and task manager; the board is kept')
  .argument('[name]')
  .action(async (name) => {
    await stopCommand(name);
  });

program
  .command('config')
  .description('swarm settings: am config swarm.<key> [value]')
  .argument('[key]')
  .argument('[value]')
  .action(async (key, value) => {
    await configCommand(key, value);
  });

program
  .command('tm-serve', { hidden: true })
  .requiredOption('--swarm <name>')
  .action((opts) => {
    serveCommand(opts.swarm);
  });

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

program
  .command('shell-init')
  .description('print the shell hook that makes `am use` affect the current shell')
  .argument('[shell]', 'zsh | bash | fish (auto-detected by default)')
  .action((shell) => {
    shellInitCommand(shell);
  });

/**
 * Announce a one-time rename on stderr, so JSON on stdout and the shell hook's
 * `am env` output stay clean.
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
