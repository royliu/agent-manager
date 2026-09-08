import { withClient } from '../swarm/client.js';
import type { Agent } from '../swarm/model.js';
import { resolveSwarmName } from '../swarm/registry.js';
import { bold, cyan, dim, green, padEnd, red, yellow } from '../ui/format.js';
import { noSwarm } from './gm.js';

export async function agentCommand(sub: string, arg: string | undefined, opts: { gm?: string; profile?: string; model?: string; json?: boolean }): Promise<void> {
  const meta = resolveSwarmName(opts.gm);
  if (!meta) return noSwarm(opts.gm);
  await withClient(meta.name, async (c) => {
    switch (sub) {
      case 'ls':
      case 'list': {
        const team = await c.call<Array<Agent & { effectiveModel?: string }>>('team.list');
        if (opts.json) return console.log(JSON.stringify(team, null, 2));
        console.log('');
        console.log('  ' + padEnd(dim('AGENT'), 14) + padEnd(dim('STATE'), 12) + padEnd(dim('TASK'), 8) + padEnd(dim('CTX'), 6) + padEnd(dim('PROFILE'), 12) + dim('MODEL'));
        for (const a of team) {
          const state = a.state === 'working' ? green(a.state) : a.state === 'waiting' || a.state === 'compacting' ? yellow(a.state) : a.state === 'stalled' ? red(a.state) : dim(a.state);
          console.log(`  ${padEnd(bold(a.name), 14)}${padEnd(state, 12)}${padEnd(a.taskId !== undefined ? `#${a.taskId}` : dim('—'), 8)}${padEnd(`${a.contextPct}%`, 6)}${padEnd(a.profile, 12)}${dim(a.effectiveModel ?? 'tool default')}`);
        }
        console.log(dim(`  ${cyan(`am gm show ${meta.name}`)} for the GM's and task manager's models.`));
        console.log('');
        return;
      }
      case 'add': {
        const a = await c.call<Agent>('team.add', { name: arg, profile: opts.profile, model: opts.model });
        console.log(`  ${green('✓')} ${a.name} added on ${a.profile}. ${dim(`${meta.name} can assign to it now.`)}`);
        return;
      }
      case 'rm':
      case 'remove': {
        if (!arg) throw new Error('which agent? am agent rm <name>');
        await c.call('team.remove', { name: arg });
        console.log(`  ${green('✓')} ${arg} removed.`);
        return;
      }
      case 'move': {
        if (!arg || !opts.profile) throw new Error('am agent move <name> --profile <profile>');
        const a = await c.call<Agent>('team.move', { name: arg, profile: opts.profile });
        console.log(`  ${green('✓')} ${a.name} now runs on ${a.profile}; its next task starts a fresh session there.`);
        return;
      }
      default:
        console.error(`${red('✗')} Unknown: am agent ${sub}. Try ${cyan('am agent ls|add|rm|move')}.`);
        process.exitCode = 1;
    }
  });
}
