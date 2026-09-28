import { readSummary, serviceRunning, TmClient } from './client.js';
import { listSwarms } from './registry.js';
import { isActive, needsYou, type BoardSummary } from './service.js';
import { Store } from './store.js';
import type { MemView } from './memguard.js';

/** One GM as the home screen shows it. */
export interface GmRow {
  name: string;
  profile: string;
  dir: string;
  running: boolean;
  needYou: number;
  working: number;
  open: number;
  /** Agent-script memory, when the task manager answered. */
  memory?: MemView;
}

async function summaryWithin(name: string, ms: number): Promise<BoardSummary | undefined> {
  const c = new TmClient(name);
  const timer = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms));
  try {
    return await Promise.race([
      (async () => {
        await c.connect();
        return readSummary(c);
      })(),
      timer,
    ]);
  } catch {
    return undefined;
  } finally {
    c.close();
  }
}

/** Every GM with live counts when its task manager answers, and counts from disk otherwise. */
export async function gmOverview(): Promise<GmRow[]> {
  const rows: GmRow[] = [];
  for (const s of listSwarms()) {
    const running = serviceRunning(s.name);
    const live = running ? await summaryWithin(s.name, 1500) : undefined;
    if (live) {
      rows.push({ name: s.name, profile: s.profile, dir: s.dir, running, needYou: live.needYou, working: live.running, open: live.active, memory: live.memory });
      continue;
    }
    const tasks = new Store(s.name).all();
    rows.push({
      name: s.name,
      profile: s.profile,
      dir: s.dir,
      running,
      needYou: tasks.filter(needsYou).length,
      working: tasks.filter((t) => t.status === 'in_progress').length,
      open: tasks.filter(isActive).length,
    });
  }
  return rows;
}
