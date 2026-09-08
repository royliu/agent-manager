import { profileByName } from '../core/config.js';
import { runForeground } from '../core/exec.js';
import { ensureService, serviceRunning } from '../swarm/client.js';
import { buildGmLaunch } from '../swarm/gmlaunch.js';
import { listSwarms, loadSwarmConfig, resolveSwarmName, saveSwarm } from '../swarm/registry.js';
import { Store } from '../swarm/store.js';
import { bold, cyan, dim, green, padEnd, red } from '../ui/format.js';
import { closePrompts } from '../ui/prompt.js';

export function noSwarm(name?: string): void {
  console.error(name ? `${red('✗')} No General Manager named "${name}".` : `${red('✗')} No General Manager in this folder.`);
  const all = listSwarms();
  if (all.length) console.error(`  ${dim('Known:')} ${all.map((s) => `${s.name} ${dim(`(${s.dir})`)}`).join(', ')}`);
  console.error(`  ${dim('Start one here:')} ${cyan('am start <profile> gm [name]')}`);
  process.exitCode = 1;
}

/** `am gm [name]`: reattach to the GM's conversation. */
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
    console.log(dim('No General Managers yet.') + ` Start one in a project folder: ${cyan('am start <profile> gm [name]')}`);
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
