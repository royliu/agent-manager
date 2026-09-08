import { serviceRunning, TmClient } from './client.js';
import { listSwarms } from './registry.js';
import { isActive, needsYou, type BoardSnapshot } from './service.js';
import { Store } from './store.js';

/** One GM as the home screen shows it. */
export interface GmRow {
  name: string;
  profile: string;
  dir: string;
  running: boolean;
  needYou: number;
  working: number;
  open: number;
}

async function snapshotWithin(name: string, ms: number): Promise<BoardSnapshot | undefined> {
  const c = new TmClient(name);
  const timer = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms));
  try {
    return await Promise.race([
      (async () => {
        await c.connect();
        return c.call<BoardSnapshot>('snapshot');
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
    const snap = running ? await snapshotWithin(s.name, 1500) : undefined;
    const tasks = snap?.tasks ?? new Store(s.name).all();
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
