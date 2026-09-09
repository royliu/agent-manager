import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { profileByName } from '../core/config.js';
import { runForeground } from '../core/exec.js';
import { tildify } from '../core/paths.js';
import { ensureService, serviceRunning, TmClient } from '../swarm/client.js';
import { buildGmLaunch } from '../swarm/gmlaunch.js';
import { agentRole, describeAgentProfile, describeModel, modelsView, resolveAgentProfile, resolveModel } from '../swarm/models.js';
import { swarmPaths } from '../swarm/paths.js';
import { listSwarms, loadSwarmConfig, removeSwarm, resolveSwarmName, saveSwarm } from '../swarm/registry.js';
import { isActive, needsYou, statusLabel, type BoardSnapshot } from '../swarm/service.js';
import { Store } from '../swarm/store.js';
import { bold, cyan, dim, green, padEnd, red, yellow } from '../ui/format.js';
import { closePrompts, confirm, isInteractive } from '../ui/prompt.js';

export function noSwarm(name?: string): void {
  console.error(name ? `${red('✗')} No General Manager named "${name}".` : `${red('✗')} No General Manager in this folder.`);
  const all = listSwarms();
  if (all.length) console.error(`  ${dim('Known:')} ${all.map((s) => `${s.name} ${dim(`(${s.dir})`)}`).join(', ')}`);
  console.error(`  ${dim('Start one here:')} ${cyan('am gm start <profile> [name]')}`);
  process.exitCode = 1;
}

/** `am gm [name]` · `am gm open [name]`: reattach to the GM's conversation. */
export async function gmCommand(name: string | undefined): Promise<void> {
  const meta = resolveSwarmName(name);
  if (!meta) return noSwarm(name);
  const profile = profileByName(meta.profile);
  if (!profile) {
    console.error(`${red('✗')} Profile ${meta.profile} is gone.`);
    process.exitCode = 1;
    return;
  }
  await ensureService(meta.name);
  const cfg = loadSwarmConfig();
  const { spec, sessionId } = buildGmLaunch(meta, profile, cfg, { resume: !!meta.gmSessionId });
  if (sessionId) {
    meta.gmSessionId = sessionId;
    new Store(meta.name).saveMeta(meta);
    saveSwarm(meta);
  }
  console.log(`  ${dim(`▸ back to ${meta.name} in ${meta.dir}`)}`);
  closePrompts();
  process.chdir(meta.dir);
  process.exitCode = await runForeground(spec);
}

/** `am gm ls` */
export function gmListCommand(opts: { json?: boolean }): void {
  const all = listSwarms();
  if (opts.json) {
    console.log(JSON.stringify(all.map((s) => ({ ...s, running: serviceRunning(s.name) })), null, 2));
    return;
  }
  if (!all.length) {
    console.log(dim('No General Managers yet.') + ` Start one in a project folder: ${cyan('am gm start <profile> [name]')}`);
    return;
  }
  console.log('');
  console.log('  ' + padEnd(dim('GM'), 14) + padEnd(dim('PROFILE'), 12) + padEnd(dim('STATE'), 10) + dim('FOLDER'));
  for (const s of all) {
    const running = serviceRunning(s.name);
    console.log(`  ${padEnd(bold(s.name), 14)}${padEnd(s.profile, 12)}${padEnd(running ? green('running') : dim('stopped'), 10)}${dim(s.dir)}`);
  }
  console.log('');
}

/** Live counts from the task manager, or nothing if it is not running. */
async function liveSnapshot(name: string): Promise<BoardSnapshot | undefined> {
  if (!serviceRunning(name)) return undefined;
  const c = new TmClient(name);
  try {
    await c.connect();
    return await c.call<BoardSnapshot>('snapshot');
  } catch {
    return undefined;
  } finally {
    c.close();
  }
}

/** `am gm show [name]`: models, team, workspace and what needs you, whether or not the team is running. */
export async function gmShowCommand(name: string | undefined, opts: { json?: boolean }): Promise<void> {
  const meta = resolveSwarmName(name);
  if (!meta) return noSwarm(name);
  const cfg = loadSwarmConfig();
  const profile = profileByName(meta.profile);
  const store = new Store(meta.name);
  const live = await liveSnapshot(meta.name);
  const team = live?.team ?? store.team();
  const tasks = live?.tasks ?? store.all();
  const ws = live?.workspace ?? store.workspace();
  const models = live?.models ?? modelsView(meta, cfg, profile, team, profileByName);
  const active = tasks.filter(isActive);
  const counts = {
    needYou: tasks.filter(needsYou).length,
    running: tasks.filter((t) => t.status === 'in_progress').length,
    queued: tasks.filter((t) => t.status === 'open' && t.dispatchRequested).length,
    open: active.length,
  };
  const running = !!live;

  if (opts.json) {
    console.log(JSON.stringify({ ...meta, running, models, team, workspace: ws, counts }, null, 2));
    return;
  }
  console.log('');
  console.log(`  ${bold(meta.name)} ${dim('·')} ${running ? green('running') : dim('stopped')} ${dim(`· ${meta.profile} · ${tildify(meta.dir)}`)}`);
  console.log('');
  console.log(`  ${padEnd(dim('general manager'), 18)}${describeModel(models.gm)}`);
  console.log(`  ${padEnd(dim('task manager'), 18)}${describeModel(models.tm)}`);
  console.log(`  ${padEnd(dim("agents' profile"), 18)}${describeAgentProfile(resolveAgentProfile(meta, cfg))}`);
  console.log('');
  console.log('  ' + padEnd(dim('AGENT'), 14) + padEnd(dim('STATE'), 12) + padEnd(dim('TASK'), 8) + padEnd(dim('CTX'), 6) + padEnd(dim('PROFILE'), 12) + dim('MODEL'));
  for (const a of team) {
    const model = (a as { effectiveModel?: string }).effectiveModel ?? a.model ?? resolveModel(agentRole(a), meta, cfg, profileByName(a.profile)).model ?? 'the tool default';
    const state = running ? (a.state === 'working' ? green(a.state) : a.state === 'waiting' || a.state === 'compacting' ? yellow(a.state) : a.state === 'stalled' ? red(a.state) : dim(a.state)) : dim('stopped');
    console.log(`  ${padEnd(bold(a.name), 14)}${padEnd(state, 12)}${padEnd(a.taskId !== undefined ? `#${a.taskId}` : dim('—'), 8)}${padEnd(`${a.contextPct}%`, 6)}${padEnd(a.profile, 12)}${dim(model)}`);
  }
  console.log('');
  console.log(`  ${padEnd(dim('workspace'), 18)}${ws?.dir ?? meta.dir}${ws?.branch ? ` · ${ws.branch}` : ''}${ws?.notes ? ` · conventions: ${ws.notes}` : ''}`);
  console.log(`  ${padEnd(dim('project brief'), 18)}${ws?.brief ? `${ws.brief.split(/\s+/).length} words, kept by ${meta.name}` : dim('none yet')}`);
  console.log('');
  const needs = counts.needYou ? yellow(`${counts.needYou} need you`) : dim('nothing needs you');
  console.log(`  ${padEnd(dim('board'), 18)}${needs} · ${counts.running} running · ${counts.queued} queued · ${counts.open} open in all`);
  for (const t of tasks.filter(needsYou).slice(0, 5)) console.log(`  ${padEnd('', 18)}${dim(`#${t.id}`)} ${t.title} ${dim(`· ${statusLabel(t, meta.name)}`)}`);
  console.log('');
  console.log(dim(`  ${cyan(`am gm ${meta.name}`)} opens the conversation · ${cyan(`am board ${meta.name}`)} the board · ${cyan(`am gm ${running ? 'stop' : 'start ' + meta.profile} ${meta.name}`)}`));
  console.log('');
}

/** `am gm rm <name>`: forget a stopped GM. The project folder is never touched. */
export async function gmRemoveCommand(name: string, opts: { yes?: boolean }): Promise<void> {
  const meta = resolveSwarmName(name);
  if (!meta) return noSwarm(name);
  if (serviceRunning(meta.name)) {
    console.error(`${red('✗')} ${meta.name} is running. Stop it first: ${cyan(`am gm stop ${meta.name}`)}`);
    process.exitCode = 1;
    return;
  }
  const store = new Store(meta.name);
  const tasks = store.all();
  const p = swarmPaths(meta.name);
  console.log('');
  console.log(`  ${yellow('!')} This deletes ${bold(meta.name)}'s records: ${tasks.length} task${tasks.length === 1 ? '' : 's'} with notes, questions and runs, the team and its memories.`);
  console.log(`    ${dim(tildify(p.dir))}`);
  console.log(`    ${dim(`The project folder ${tildify(meta.dir)} and its git history are not touched.`)}`);
  const ok = opts.yes || (isInteractive() && (await confirm(`Forget ${meta.name}?`, false)));
  closePrompts();
  if (!ok) {
    console.log(dim('  Kept.'));
    return;
  }
  removeSwarm(meta.name);
  fs.rmSync(p.dir, { recursive: true, force: true });
  for (const f of [p.sock]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* none */
    }
  }
  // Worktrees created for tasks lived under the records folder; tell git they are gone.
  const repo = store.workspace()?.repo ?? meta.dir;
  try {
    execFileSync('git', ['worktree', 'prune'], { cwd: repo, stdio: 'ignore' });
  } catch {
    /* not a repo, or git missing */
  }
  console.log(`  ${green('✓')} ${meta.name} forgotten. ${dim(`Start again any time: am gm start ${meta.profile} ${meta.name}`)}`);
  console.log('');
}
