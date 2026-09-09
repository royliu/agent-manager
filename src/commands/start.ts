import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { runForeground } from '../core/exec.js';
import { getProvider, readIdentitySafe } from '../providers/index.js';
import { ensureService, withClient } from '../swarm/client.js';
import { buildGmLaunch } from '../swarm/gmlaunch.js';
import type { Agent, SwarmMeta, Workspace } from '../swarm/model.js';
import { describeAgentProfile, modelNameNote, modelsLines, normalizeModelValue, resolveAgentProfile, type ModelsView } from '../swarm/models.js';
import { ensureSwarmDirs } from '../swarm/paths.js';
import { findSwarm, loadSwarmConfig, realDir, saveSwarm, swarmForDir, SWARM_NAME_RE } from '../swarm/registry.js';
import { Store } from '../swarm/store.js';
import { bold, cyan, dim, green, red } from '../ui/format.js';
import { closePrompts } from '../ui/prompt.js';
import { resolveProfile } from './resolve.js';

interface StartOptions {
  agents?: string;
  /** false with --no-open: start the team in the background and return. */
  open?: boolean;
  gmModel?: string;
  tmModel?: string;
  agentModel?: string;
  codexAgentModel?: string;
  agentProfile?: string;
  dir?: string;
  keepApiKeys?: boolean;
  dryRun?: boolean;
}

function git(dir: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || undefined;
  } catch {
    return undefined;
  }
}
function tryVersion(cmd: string, args: string[]): string | undefined {
  try {
    return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('\n')[0];
  } catch {
    return undefined;
  }
}

function captureWorkspace(dir: string): Workspace {
  const tools: Record<string, string> = {};
  const node = tryVersion('node', ['--version']);
  if (node) tools.node = node;
  const g = tryVersion('git', ['--version']);
  if (g) tools.git = g.replace(/^git version /, '');
  return {
    dir,
    repo: git(dir, ['rev-parse', '--show-toplevel']),
    branch: git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    env: {},
    tools,
    notes: '',
    brief: '',
    updatedAt: Date.now(),
  };
}

/** Names that would collide with `am gm` subcommands. */
const RESERVED_GM_NAMES = new Set(['start', 'open', 'stop', 'ls', 'list', 'show', 'rm', 'remove']);

/** `am gm start <profile> [name]`: set up the team in this folder and open the GM's conversation. */
export async function startCommand(profileName: string, nameArg: string | undefined, opts: StartOptions): Promise<void> {
  if (nameArg && RESERVED_GM_NAMES.has(nameArg)) {
    console.error(`${red('✗')} "${nameArg}" is a command word; pick another name for the General Manager.`);
    process.exitCode = 1;
    return;
  }
  const profile = resolveProfile(profileName, { command: 'am gm start' });
  if (!profile) return;
  if (profile.provider !== 'claude-code' && profile.provider !== 'codex') {
    console.error(`${red('✗')} ${profile.name} is a ${getProvider(profile.provider).displayName} profile; a GM needs Claude Code or Codex.`);
    process.exitCode = 1;
    return;
  }
  const dir = realDir(opts.dir ?? process.cwd());
  const cfg = loadSwarmConfig();

  let meta = swarmForDir(dir);
  if (meta && nameArg && nameArg !== meta.name) {
    console.error(`${red('✗')} This folder already has a General Manager named ${bold(meta.name)}.`);
    console.error(`  ${dim('Come back to it:')} ${cyan('am gm')}   ${dim('or stop it first:')} ${cyan(`am gm stop ${meta.name}`)}`);
    process.exitCode = 1;
    return;
  }
  if (!meta && nameArg) {
    const elsewhere = findSwarm(nameArg);
    if (elsewhere) {
      console.error(`${red('✗')} ${bold(nameArg)} already lives in ${elsewhere.dir}.`);
      console.error(`  ${dim('Go there and run')} ${cyan('am gm')}${dim(', or pick another name here.')}`);
      process.exitCode = 1;
      return;
    }
  }

  const identity = await readIdentitySafe(getProvider(profile.provider), profile.home);
  console.log('');
  console.log(`  ${cyan('●')} profile ${bold(profile.name)} ${dim(`· ${[identity.plan ?? profile.plan, identity.account ?? profile.account].filter(Boolean).join(' · ')}`)}`);
  if (!identity.loggedIn) {
    console.log(`  ${red('!')} ${profile.name} is not signed in; the GM will start and ask you to sign in.`);
  }

  let fresh = false;
  if (!meta) {
    fresh = true;
    const derived = path.basename(dir).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    const name = (nameArg ?? (derived || 'gm')).slice(0, 32);
    if (!SWARM_NAME_RE.test(name)) {
      console.error(`${red('✗')} "${name}" is not a valid name: lowercase letters, digits, - and _, starting with a letter.`);
      process.exitCode = 1;
      return;
    }
    const agentProfileFlag = normalizeModelValue(opts.agentProfile);
    const newMeta: SwarmMeta = { name, dir, profile: profile.name, provider: profile.provider, createdAt: Date.now(), profiles: agentProfileFlag ? { agents: agentProfileFlag } : undefined };
    // New agents go on the profile set for this GM, else for every GM, else the GM's own.
    const agentProf = resolveProfile(resolveAgentProfile(newMeta, cfg).profile, { command: 'am gm start --agent-profile' });
    if (!agentProf) return;
    if (agentProf.provider !== 'claude-code' && agentProf.provider !== 'codex') {
      console.error(`${red('✗')} ${agentProf.name} is a ${getProvider(agentProf.provider).displayName} profile; task agents need Claude Code or Codex.`);
      process.exitCode = 1;
      return;
    }
    ensureSwarmDirs(name);
    const store = new Store(name);
    store.saveMeta(newMeta);
    const count = Math.max(1, Math.min(16, Number.parseInt(opts.agents ?? '', 10) || cfg.agents));
    const team: Agent[] = [];
    for (let i = 1; i <= count; i += 1) {
      team.push({ name: `${name}-${i}`, profile: agentProf.name, provider: agentProf.provider, state: 'idle', contextPct: 0, memory: '', rotateSession: false, paused: false, usdToday: 0, nudges: 0 });
    }
    store.saveTeam(team);
    store.saveWorkspace(captureWorkspace(dir));
    saveSwarm(newMeta);
    meta = newMeta;
  }

  await ensureService(meta.name);
  // Model flags are remembered for this GM; "default" clears one so the profile's model applies again.
  const modelFlags: Record<string, string> = {};
  for (const [flag, role] of [['gmModel', 'gm'], ['tmModel', 'tm'], ['agentModel', 'agent'], ['codexAgentModel', 'codexAgent']] as const) {
    const raw = opts[flag];
    if (raw !== undefined) modelFlags[role] = normalizeModelValue(raw) ?? '';
  }
  const { models, agentsProfile, moved, busy } = await withClient(meta.name, async (c) => {
    if (Object.keys(modelFlags).length) await c.call('models.set', { ...modelFlags, by: 'you' });
    let moved: string[] = [];
    let busy: string[] = [];
    // On a GM that already exists, --agent-profile moves the idle agents there now.
    if (opts.agentProfile !== undefined && !fresh) {
      const r = await c.call<{ moved: string[]; busy: string[] }>('profiles.set', { agents: normalizeModelValue(opts.agentProfile) ?? '', by: 'you' });
      moved = r.moved;
      busy = r.busy;
    }
    return { models: await c.call<ModelsView>('models.get'), agentsProfile: await c.call<{ profile: string; source: 'this GM' | 'am config' | 'profile' | 'tool default' }>('profiles.get'), moved, busy };
  });
  meta = (swarmForDir(dir) ?? meta) as SwarmMeta;
  const store = new Store(meta.name);
  const team = store.team();
  const ws = store.workspace();
  console.log(`  ${green('✓')} task manager and ${team.length} task agent${team.length === 1 ? '' : 's'} ${fresh ? 'ready' : 'back'}: ${team.map((a) => a.name).join(' ')} ${dim(`(${fresh ? 'idle' : 'as they were'}, ${profile.name})`)}`);
  console.log(`  ${green('✓')} models: ${modelsLines(models, meta.name).join(dim(' · '))}`);
  for (const note of [modelNameNote(models.gm.model), modelNameNote(models.tm.model), modelNameNote(models.agent.model)].filter((n, i, all): n is string => !!n && all.indexOf(n) === i)) console.log(`    ${dim(note)}`);
  if (agentsProfile.source !== 'profile' || moved.length || busy.length) {
    console.log(`  ${green('✓')} task agents on profile ${describeAgentProfile(agentsProfile)}${moved.length ? dim(` · moved ${moved.join(', ')}`) : ''}${busy.length ? ` ${dim(`· ${busy.join(', ')} still working, move later with`)} ${cyan('am agent move')}` : ''}`);
  }
  console.log(`  ${green('✓')} workspace: ${ws?.dir ?? dir}${ws?.branch ? ` · ${ws.branch}` : ''}${ws?.tools.node ? ` · node ${ws.tools.node.replace(/^v/, '')}` : ''} · your shell environment ${dim('(API keys stripped)')}`);
  if (opts.open === false) {
    console.log(`  ${dim(`▸ ${meta.name}'s team is running in the background.`)} ${cyan(`am gm ${meta.name}`)} ${dim('opens the conversation ·')} ${cyan(`am board ${meta.name}`)} ${dim('the board')}`);
    console.log('');
    return;
  }
  console.log(`  ${dim(`▸ ${fresh ? 'starting' : 'resuming'} ${getProvider(profile.provider).displayName} as ${meta.name}… the board is`)} ${cyan('am board')} ${dim('in another terminal')}`);
  console.log('');

  const resume = !fresh && !!meta.gmSessionId;
  const { spec, sessionId } = buildGmLaunch(meta, profile, cfg, { resume });
  if (sessionId && !opts.dryRun) {
    meta.gmSessionId = sessionId;
    store.saveMeta(meta);
    saveSwarm(meta);
  }
  if (opts.keepApiKeys) spec.env = getProvider(profile.provider).launch(profile.home, spec.args, { keepApiKeys: true }).env;
  if (opts.dryRun) {
    console.log(`  ${dim('would run:')} ${spec.command} ${spec.args.map((a) => (a.length > 60 ? `'${a.slice(0, 57)}…'` : a)).join(' ')}`);
    console.log(`  ${dim('in')} ${dir} ${dim('with')} ${Object.keys(spec.env).filter((k) => k === 'CLAUDE_CONFIG_DIR' || k === 'CODEX_HOME' || k === 'AM_GM').map((k) => `${k}=${spec.env[k]}`).join(' ')}`);
    return;
  }
  closePrompts();
  process.chdir(dir);
  const code = await runForeground(spec);
  console.log('');
  console.log(`  ${dim(`${meta.name}'s team keeps working in the background.`)} ${cyan('am gm')} ${dim('to come back ·')} ${cyan('am board')} ${dim('for the board ·')} ${cyan('am gm stop')} ${dim('to stop the team')}`);
  process.exitCode = code;
}
