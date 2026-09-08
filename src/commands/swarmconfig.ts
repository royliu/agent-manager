import { serviceRunning, TmClient } from '../swarm/client.js';
import { listSwarms, loadSwarmConfig, setSwarmConfigKey, swarmConfigEntries } from '../swarm/registry.js';
import { bold, dim, green, red } from '../ui/format.js';

/** `am config swarm.<key> [value]` */
export async function configCommand(key: string | undefined, value: string | undefined): Promise<void> {
  const cfg = loadSwarmConfig() as unknown as Record<string, unknown>;
  if (!key) {
    console.log('');
    for (const e of swarmConfigEntries()) {
      const shown = e.value === undefined ? dim(e.isModel ? "unset → the profile's own model" : 'unset') : JSON.stringify(e.value);
      console.log(`  ${bold(`swarm.${e.key}`)} ${dim('=')} ${shown}`);
    }
    console.log('');
    console.log(dim('  These apply to every GM. Set one: am config swarm.<key> <value> · clear one: am config swarm.<key> default'));
    console.log(dim('  Models for one GM only: am start <profile> gm <name> --gm-model | --tm-model | --agent-model <model>, or ask the GM.'));
    console.log('');
    return;
  }
  const k = key.replace(/^swarm\./, '');
  if (value === undefined) {
    if (!(k in cfg)) {
      console.error(`${red('✗')} unknown setting swarm.${k}`);
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(cfg[k]));
    return;
  }
  const next = setSwarmConfigKey(k, value) as unknown as Record<string, unknown>;
  const kk = k === 'triageModel' ? 'tmModel' : k;
  console.log(`  ${green('✓')} swarm.${kk} = ${next[kk] === undefined ? dim("unset → the profile's own model") : JSON.stringify(next[kk])}`);
  if (/Model$/.test(kk)) console.log(dim(`  Applies at the next start: the GM when you next run am gm, the task manager at its next answer, agents at their next run.`));
  for (const s of listSwarms()) {
    if (!serviceRunning(s.name)) continue;
    const c = new TmClient(s.name);
    try {
      await c.connect();
      await c.call('config.reload');
    } catch {
      /* ignore */
    } finally {
      c.close();
    }
  }
}
