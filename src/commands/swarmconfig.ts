import { serviceRunning, TmClient } from '../swarm/client.js';
import { listSwarms, publicConfigKey, setSwarmConfigKey, swarmConfigEntries } from '../swarm/registry.js';
import { bold, cyan, dim, green, padEnd, red, width } from '../ui/format.js';

/** `am config [group.key] [value]`: settings that apply to every GM. */
export async function configCommand(key: string | undefined, value: string | undefined): Promise<void> {
  const entries = swarmConfigEntries();
  if (!key) {
    console.log('');
    let group = '';
    for (const e of entries) {
      const g = e.key.split('.')[0]!;
      if (g !== group) {
        if (group) console.log('');
        group = g;
      }
      const shown = e.value === undefined ? dim(e.isModel ? "unset → the profile's own model" : 'unset') : JSON.stringify(e.value);
      // Long values (a tool list, a model name) push the meaning onto its own line rather than into the value.
      if (width(shown) > 30) {
        console.log(`  ${padEnd(bold(e.key), 22)}${shown}`);
        console.log(`  ${' '.repeat(22)}${dim(e.help)}`);
      } else {
        console.log(`  ${padEnd(bold(e.key), 22)}${padEnd(shown, 32)}${dim(e.help)}`);
      }
    }
    console.log('');
    console.log(dim(`  These apply to every GM. Set one: ${cyan('am config <group.key> <value>')} · clear one: ${cyan('am config <group.key> default')}`));
    console.log(dim(`  Models for one GM only: ${cyan('am gm start <profile> <name> --gm-model | --tm-model | --agent-model <model>')}, or ask the GM.`));
    console.log('');
    return;
  }
  const resolved = publicConfigKey(key);
  if (!resolved) {
    console.error(`${red('✗')} unknown setting ${key}. ${dim('Known:')} ${entries.map((e) => e.key).join(', ')}`);
    process.exitCode = 1;
    return;
  }
  if (resolved.renamedFrom) console.error(dim(`  (${resolved.renamedFrom} is now ${resolved.key})`));
  if (value === undefined) {
    const e = entries.find((x) => x.key === resolved.key)!;
    console.log(e.value === undefined ? '' : JSON.stringify(e.value));
    return;
  }
  const result = setSwarmConfigKey(resolved.key, value);
  console.log(`  ${green('✓')} ${result.key} = ${result.value === undefined ? dim(result.isModel ? "unset → the profile's own model" : 'unset') : JSON.stringify(result.value)}`);
  if (result.isModel) console.log(dim('  Applies at the next start: the GM when you next run am gm, the task manager at its next answer, agents at their next run.'));
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
