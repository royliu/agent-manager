import fs from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import { ensureDir } from '../core/paths.js';
import {
  AgentSchema, EventSchema, InboxItemSchema, SwarmMetaSchema, TaskSchema, WorkspaceSchema,
  type Agent, type Event, type InboxItem, type SwarmMeta, type Task, type Workspace,
} from './model.js';
import { ensureSwarmDirs, type SwarmPaths } from './paths.js';

/** Atomic write, same discipline as the profile registry. */
export function writeJsonAtomic(file: string, data: unknown): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 7)}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function readJson<T>(file: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): T | undefined {
  try {
    const parsed = schema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function readJsonl<T>(file: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): T[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = schema.safeParse(JSON.parse(line));
      if (parsed.success) out.push(parsed.data);
    } catch {
      /* skip a torn line */
    }
  }
  return out;
}

/**
 * The swarm's files. The task manager service is the single writer; the board
 * and shell commands read through the service, never through this directly.
 */
export class Store {
  readonly paths: SwarmPaths;
  private tasks = new Map<number, Task>();

  constructor(readonly name: string) {
    this.paths = ensureSwarmDirs(name);
    this.loadTasks();
  }

  private loadTasks(): void {
    this.tasks.clear();
    for (const f of fs.readdirSync(this.paths.tasks)) {
      if (!f.endsWith('.json')) continue;
      const t = readJson(path.join(this.paths.tasks, f), TaskSchema);
      if (t) this.tasks.set(t.id, t);
    }
  }

  // ---- meta / team / workspace ----
  meta(): SwarmMeta | undefined {
    return readJson(this.paths.meta, SwarmMetaSchema);
  }
  saveMeta(meta: SwarmMeta): void {
    writeJsonAtomic(this.paths.meta, meta);
  }
  team(): Agent[] {
    return readJson(this.paths.team, AgentSchema.array()) ?? [];
  }
  saveTeam(team: Agent[]): void {
    writeJsonAtomic(this.paths.team, team);
  }
  workspace(): Workspace | undefined {
    return readJson(this.paths.workspace, WorkspaceSchema);
  }
  saveWorkspace(ws: Workspace): void {
    writeJsonAtomic(this.paths.workspace, ws);
  }

  // ---- tasks ----
  nextId(): number {
    const counter = readJson(this.paths.counter, TaskSchema.shape.id.array()) ?? [];
    const last = counter[0] ?? Math.max(0, ...this.tasks.keys());
    const next = last + 1;
    writeJsonAtomic(this.paths.counter, [next]);
    return next;
  }
  all(): Task[] {
    return [...this.tasks.values()].sort((a, b) => a.id - b.id);
  }
  get(id: number): Task | undefined {
    return this.tasks.get(id);
  }
  save(task: Task): Task {
    task.updatedAt = Date.now();
    this.tasks.set(task.id, task);
    writeJsonAtomic(path.join(this.paths.tasks, `${task.id}.json`), task);
    return task;
  }

  // ---- events ----
  appendEvent(ev: Event): void {
    fs.appendFileSync(this.paths.events, JSON.stringify(ev) + '\n');
  }
  events(limit = 200, taskId?: number): Event[] {
    const all = readJsonl(this.paths.events, EventSchema);
    const filtered = taskId === undefined ? all : all.filter((e) => e.taskId === taskId);
    return filtered.slice(-limit).reverse();
  }

  // ---- inbox ----
  inbox(): InboxItem[] {
    return readJsonl(this.paths.inbox, InboxItemSchema);
  }
  pushInbox(item: InboxItem): void {
    fs.appendFileSync(this.paths.inbox, JSON.stringify(item) + '\n');
  }
  ackInbox(ids?: string[]): number {
    const items = this.inbox();
    let n = 0;
    for (const it of items) {
      if (!it.read && (!ids || ids.includes(it.id))) {
        it.read = true;
        n += 1;
      }
    }
    // Keep the file small: drop read items older than a day.
    const cutoff = Date.now() - 864e5;
    const kept = items.filter((it) => !it.read || it.at > cutoff);
    fs.writeFileSync(this.paths.inbox, kept.map((it) => JSON.stringify(it)).join('\n') + (kept.length ? '\n' : ''));
    return n;
  }
}
