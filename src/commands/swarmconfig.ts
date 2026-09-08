import { serviceRunning, TmClient } from '../swarm/client.js';
import { listSwarms, loadSwarmConfig, setSwarmConfigKey } from '../swarm/registry.js';
import { bold, dim, green, red } from '../ui/format.js';

/** `am config swarm.<key> [value]` */
export async function configCommand(key: string | undefined, value: string | undefined): Promise<void> {
  const cfg = loadSwarmConfig() as unknown as Record<string, unknown>;
  if (!key) {
    for (const [k, v] of Object.entries(cfg)) console.log(`  ${bold(`swarm.${k}`)} ${dim('=')} ${JSON.stringify(v)}`);
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
  console.log(`  ${green('✓')} swarm.${k} = ${JSON.stringify(next[k])}`);
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
