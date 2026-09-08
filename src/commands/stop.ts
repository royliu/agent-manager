import { serviceRunning, TmClient } from '../swarm/client.js';
import { resolveSwarmName } from '../swarm/registry.js';
import { cyan, dim, green } from '../ui/format.js';
import { noSwarm } from './gm.js';

/** `am stop [name]`: stop the agents and the task manager; the board's state is kept. */
export async function stopCommand(name: string | undefined): Promise<void> {
  const meta = resolveSwarmName(name);
  if (!meta) return noSwarm(name);
  if (!serviceRunning(meta.name)) {
    console.log(`  ${dim(`${meta.name} is not running.`)}`);
    return;
  }
  const c = new TmClient(meta.name);
  await c.connect();
  try {
    await c.call('shutdown');
  } catch {
    /* the socket closes as it stops */
  }
  c.close();
  console.log(`  ${green('✓')} ${meta.name} stopped. Tasks, notes and agents are kept; ${cyan('am start')} ${dim('here or')} ${cyan(`am gm ${meta.name}`)} ${dim('picks them up.')}`);
}
