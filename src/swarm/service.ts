import { execFileSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { profileByName, type Profile } from '../core/config.js';
import { takeSnapshot } from '../core/snapshot.js';
import { agentAdapter } from './agents/index.js';
import { amEntry } from './client.js';
import {
  PRIORITY_LABEL, QuestionSchema, ReportSchema, shortId, type Agent, type BlockedOn, type InboxItem, type Note,
  type Question, type Run, type Status, type SwarmConfig, type SwarmMeta, type Task, type Workspace,
} from './model.js';
import { notifyDesktop } from './notify.js';
import { agentBrief, gmSystemPrompt, resumeMessage } from './prompts.js';
import type { Push, Request, Response } from './protocol.js';
import { RpcError } from './protocol.js';
import { findSwarm, loadSwarmConfig, saveSwarm } from './registry.js';
import { agentRole, modelArg, modelsView, MODEL_ROLES, normalizeModelValue, resolveAgentProfile, resolveModel, ROLE_LABEL, windowFor, type ModelsView } from './models.js';
import { Store, writeJsonAtomic } from './store.js';
import { readClaudeSession, type SessionStats } from './transcript.js';
import { triageQuestion } from './triage.js';

type Params = Record<string, unknown>;
const str = (p: Params, k: string, req = true): string => {
  const v = p[k];
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (req) throw new RpcError(`"${k}" is required`);
  return '';
};
const num = (p: Params, k: string, req = true): number => {
  const v = p[k];
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number.parseInt(v.replace(/^#/, ''), 10) : NaN;
  if (Number.isFinite(n)) return n;
  if (req) throw new RpcError(`"${k}" must be a number`);
  return NaN;
};

export const ACTIVE: Status[] = ['open', 'plan', 'in_progress', 'blocked', 'review'];
export function isActive(t: Task): boolean {
  return ACTIVE.includes(t.status);
}
export function needsYou(t: Task): boolean {
  return (
    (t.status === 'blocked' && t.blockedOn?.kind === 'question' && t.blockedOn.to === 'user') ||
    (t.status === 'review' && t.reviewStage === 'user') ||
    (t.status === 'plan' && t.awaitingPlanApproval)
  );
}
export function statusLabel(t: Task, gm = 'gm'): string {
  const who = (to: 'tm' | 'gm' | 'user') => (to === 'tm' ? 'task manager' : to === 'gm' ? gm : 'you');
  switch (t.status) {
    case 'blocked': {
      const b = t.blockedOn;
      if (!b) return 'blocked';
      if (b.kind === 'question') return `blocked · question → ${who(b.to)}`;
      if (b.kind === 'dependency') return `blocked · waiting on #${b.taskId}`;
      if (b.kind === 'quota') return `blocked · quota${b.resetsAt ? ` (resets ${new Date(b.resetsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})` : ''}`;
      return `blocked · ${b.kind}`;
    }
    case 'review':
      return `review · ${t.reviewStage === 'user' ? 'you' : gm}`;
    case 'plan':
      return t.awaitingPlanApproval ? 'plan · awaiting you' : 'plan';
    case 'in_progress':
      return 'in progress';
    case 'open':
      return t.hold ? 'on hold' : 'open';
    default:
      return t.status;
  }
}

/** A task for a one-line list: everything but the notes, questions, runs, report and activity. */
export function lightTask(t: Task): Task {
  return { ...t, description: '', notes: [], questions: [], runs: [], report: undefined, activity: [] };
}

export interface BoardSnapshot {
  meta: SwarmMeta;
  config: SwarmConfig;
  workspace?: Workspace;
  team: Array<Agent & { effectiveModel?: string }>;
  tasks: Task[];
  /** Which model each group runs on, and where that choice came from. */
  models: ModelsView;
  inboxUnread: number;
  needYou: number;
  quota?: { profile: string; label: string; usedPercent: number; resetsAt?: number; plan?: string; account?: string };
  gmContextPct?: number;
  takenAt: number;
}

/**
 * The board's counts without the task bodies. Status lines, hooks, the MCP bridge and `am team` ask
 * often and read only these; a whole snapshot is megabytes once a board holds a few hundred tasks.
 */
export interface BoardSummary {
  meta: SwarmMeta;
  team: Array<Agent & { effectiveModel?: string }>;
  inboxUnread: number;
  needYou: number;
  /** Tasks in progress. */
  running: number;
  /** Open tasks waiting for an agent. */
  queued: number;
  /** Tasks not yet done or cancelled. */
  active: number;
  quota?: BoardSnapshot['quota'];
  gmContextPct?: number;
  takenAt: number;
}

interface Conn {
  sock: net.Socket;
  subscribed: boolean;
}

/**
 * Bytes a connection may have waiting to be sent. A reader that falls this far behind (a board asking
 * for megabyte snapshots faster than it reads them) is dropped instead of growing the heap until the
 * process dies; the board and bridges reconnect on their own.
 */
const MAX_UNSENT_BYTES = 64 * 1024 * 1024;
/** A subscriber this far behind misses pushes; it re-reads the board when it catches up. */
const PUSH_SKIP_BYTES = 1024 * 1024;

/** A task's file list, tidied: no leading "./", no empty entries, at most 40 paths. */
export function readPaths(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const raw of v) {
    if (typeof raw !== 'string') continue;
    const p = raw.trim().replace(/^\.\//, '').replace(/^\/+/, '');
    if (p && !out.includes(p)) out.push(p);
  }
  return out.slice(0, 40);
}

/** Does one declared path cover the other? "a/b/" and "a/b/*" cover everything under a/b. */
function pathTouches(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\/?\*+$/, '/').replace(/\/+$/, '/');
  const x = norm(a), y = norm(b);
  const dirX = x.endsWith('/'), dirY = y.endsWith('/');
  if (!dirX && !dirY) return x === y;
  if (dirX && dirY) return x.startsWith(y) || y.startsWith(x);
  return dirX ? (y + '/').startsWith(x) : (x + '/').startsWith(y);
}

/** The first file two tasks would both change, or null when they can run side by side. */
export function pathsClash(a: string[], b: string[]): string | null {
  for (const x of a) for (const y of b) if (pathTouches(x, y)) return x === y ? x : `${x} and ${y}`;
  return null;
}

export class TaskManagerService {
  readonly store: Store;
  readonly meta: SwarmMeta;
  cfg: SwarmConfig;
  private profile: Profile;
  private server?: net.Server;
  private conns = new Set<Conn>();
  private children = new Map<string, ChildProcess>(); // agent name → process
  private timer?: NodeJS.Timeout;
  private quotaCache?: { at: number; value: BoardSnapshot['quota'] };
  private quotaWarnedAt = 0;
  private stopping = false;

  constructor(readonly name: string) {
    this.store = new Store(name);
    const meta = this.store.meta();
    if (!meta) throw new Error(`swarm "${name}" is not set up; run am gm start`);
    this.meta = meta;
    this.cfg = loadSwarmConfig();
    const profile = profileByName(meta.profile);
    if (!profile) throw new Error(`profile "${meta.profile}" is gone`);
    this.profile = profile;
  }

  // ---------------------------------------------------------------- lifecycle
  /** Only one task manager per swarm: an exclusive lock file holding the live pid. */
  private acquireLock(): boolean {
    const p = this.store.paths;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = fs.openSync(p.lock, 'wx');
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        return true;
      } catch {
        // Someone holds it. If that process is really a live task manager for this swarm, yield; else clear a stale lock.
        let holder = NaN;
        try {
          holder = Number.parseInt(fs.readFileSync(p.lock, 'utf8'), 10);
        } catch {
          /* unreadable */
        }
        if (holder !== process.pid && this.isLiveTaskManager(holder)) return false;
        try {
          fs.unlinkSync(p.lock);
        } catch {
          /* gone */
        }
      }
    }
    return false;
  }

  /** Validate the lock holder directly; the pid file may not exist yet during a concurrent start. */
  private isLiveTaskManager(pid: number): boolean {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      const cmd = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      return (/tm-serve/.test(cmd) && cmd.includes(`--swarm ${this.name}`)) || (/_serve/.test(cmd) && cmd.includes(`--gm ${this.name}`));
    } catch {
      return false;
    }
  }

  listen(): void {
    const p = this.store.paths;
    // The lock is taken before the pid file exists, so two starts in the same instant cannot both proceed.
    if (!this.acquireLock()) {
      this.log('another task manager for this swarm is already running; exiting');
      setTimeout(() => process.exit(0), 10);
      return;
    }
    fs.writeFileSync(p.pid, String(process.pid));
    try {
      fs.unlinkSync(p.sock);
    } catch {
      /* none */
    }
    this.server = net.createServer((sock) => this.accept(sock));
    this.server.listen(p.sock, () => {
      try {
        fs.chmodSync(p.sock, 0o600);
      } catch {
        /* best effort */
      }
      fs.writeFileSync(p.pid, String(process.pid));
      this.log(`task manager for ${this.name} listening`);
    });
    // This process owns no workers yet. Recover every in-progress task, even if a previous
    // coordinator left the agent row idle before it died.
    const team = this.store.team();
    for (const t of this.store.all()) {
      if (t.status !== 'in_progress') continue;
      const a = t.agent ? team.find((candidate) => candidate.name === t.agent) : undefined;
      const run = t.runs.find((candidate) => !candidate.endedAt);
      if (a && run) this.learnSessionId(a, run);
      this.closeRun(t, 'paused', 'task manager restarted');
      t.status = 'open';
      t.dispatchRequested = true;
      this.store.save(t);
      if (a) {
        a.state = 'idle';
        a.taskId = undefined;
      }
    }
    for (const a of team) {
      if (a.state === 'working' || a.state === 'compacting') {
        a.state = 'idle';
        a.taskId = undefined;
      }
    }
    this.store.saveTeam(team);
    this.timer = setInterval(() => void this.tick(), 5000);
    void this.tick();
    const bye = () => void this.shutdown();
    process.on('SIGINT', bye);
    process.on('SIGTERM', bye);
  }

  async shutdown(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.log('shutting down');
    if (this.timer) clearInterval(this.timer);
    for (const [agentName, child] of this.children) {
      const agent = this.agent(agentName);
      const t = agent?.taskId !== undefined ? this.store.get(agent.taskId) : undefined;
      if (t) {
        const run = t.runs.find((r) => !r.endedAt);
        if (agent && run) {
          this.learnSessionId(agent, run);
          // Preserve the real Codex thread before the team snapshot below is loaded. Without
          // this save, a coordinator restart overwrites it with the pre-launch value and the
          // next run either loses its context or tries to resume a placeholder UUID.
          this.saveAgent(agent);
        }
        this.closeRun(t, 'paused', 'task manager stopped');
        if (t.status === 'in_progress') {
          t.status = 'open';
          t.dispatchRequested = true;
          this.store.save(t);
        }
      }
      try {
        this.terminateChild(agentName, child);
      } catch {
        /* gone */
      }
    }
    const team = this.store.team();
    for (const a of team) {
      if (a.state !== 'paused') a.state = 'idle';
      a.taskId = undefined;
    }
    this.store.saveTeam(team);
    for (const c of this.conns) c.sock.destroy();
    this.server?.close();
    // Clean up only what is ours; a sibling that won the race keeps its files.
    for (const f of [this.store.paths.sock, this.store.paths.pid, this.store.paths.lock]) {
      try {
        if (f === this.store.paths.sock || fs.readFileSync(f, 'utf8').trim() === String(process.pid)) fs.unlinkSync(f);
      } catch {
        /* already gone */
      }
    }
    setTimeout(() => process.exit(0), 50);
  }

  private log(msg: string): void {
    process.stderr.write(`${new Date().toISOString()} ${msg}\n`);
  }

  // ------------------------------------------------------------------- socket
  private accept(sock: net.Socket): void {
    const conn: Conn = { sock, subscribed: false };
    this.conns.add(conn);
    sock.setEncoding('utf8');
    let buf = '';
    sock.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) void this.handle(conn, line);
      }
    });
    sock.on('close', () => this.conns.delete(conn));
    sock.on('error', () => this.conns.delete(conn));
  }

  private async handle(conn: Conn, line: string): Promise<void> {
    let req: Request;
    try {
      req = JSON.parse(line) as Request;
    } catch {
      return;
    }
    const reply = (r: Response) => {
      if (conn.sock.destroyed) return;
      conn.sock.write(JSON.stringify(r) + '\n');
      this.dropIfBehind(conn);
    };
    try {
      if (req.method === 'subscribe') {
        conn.subscribed = true;
        reply({ id: req.id, result: true });
        return;
      }
      const result = await this.dispatch(req.method, req.params ?? {});
      reply({ id: req.id, result });
    } catch (e) {
      const err = e instanceof RpcError ? { message: e.message, code: e.code } : { message: e instanceof Error ? e.message : String(e) };
      reply({ id: req.id, error: err });
    }
  }

  private push(p: Push): void {
    const line = JSON.stringify(p) + '\n';
    for (const c of this.conns) {
      if (!c.subscribed || c.sock.destroyed) continue;
      if (c.sock.writableLength > PUSH_SKIP_BYTES) continue;
      c.sock.write(line);
    }
  }

  /** Close a connection whose unsent replies have piled up past MAX_UNSENT_BYTES. */
  private dropIfBehind(conn: Conn): void {
    const unsent = conn.sock.writableLength;
    if (unsent <= MAX_UNSENT_BYTES) return;
    this.log(`dropped a connection with ${Math.round(unsent / 1048576)} MB unsent; it was not reading its replies`);
    this.conns.delete(conn);
    conn.sock.destroy();
  }

  private changed(taskId?: number): void {
    this.push({ event: 'changed', data: { taskId } });
  }

  // ------------------------------------------------------------------ helpers
  private now(): number {
    return Date.now();
  }
  private agent(name: string): Agent | undefined {
    return this.store.team().find((a) => a.name === name);
  }
  private saveAgent(a: Agent): void {
    const team = this.store.team();
    const i = team.findIndex((x) => x.name === a.name);
    if (i >= 0) team[i] = a;
    else team.push(a);
    this.store.saveTeam(team);
  }
  private task(id: number): Task {
    const t = this.store.get(id);
    if (!t) throw new RpcError(`no task #${id}`, 'not_found');
    return t;
  }
  private event(actor: string, text: string, taskId?: number): void {
    this.store.appendEvent({ at: this.now(), actor, taskId, text });
  }
  private note(t: Task, author: string, kind: Note['kind'], text: string): Note {
    const n: Note = { id: shortId('n'), author, kind, text, at: this.now() };
    t.notes.push(n);
    return n;
  }
  private inbox(kind: InboxItem['kind'], text: string, taskId?: number): void {
    this.store.pushInbox({ id: shortId('i'), at: this.now(), kind, taskId, text, read: false });
    this.push({ event: 'inbox' });
  }
  private tellOwner(title: string, text: string): void {
    if (this.cfg.notify) notifyDesktop(title, text);
    this.push({ event: 'attention', data: { title, text } });
  }
  private gm(): string {
    return this.meta.name;
  }
  private root(t: Task): Task {
    let cur = t;
    const seen = new Set<number>();
    while (cur.parentId !== undefined && !seen.has(cur.id)) {
      seen.add(cur.id);
      const p = this.store.get(cur.parentId);
      if (!p) break;
      cur = p;
    }
    return cur;
  }

  // ------------------------------------------------------------------ methods
  private async dispatch(method: string, p: Params): Promise<unknown> {
    switch (method) {
      case 'ping':
        return 'pong';
      case 'snapshot':
        return this.snapshot();
      case 'summary':
        return this.summary();
      case 'task.list':
        return p.light === true ? this.store.all().map(lightTask) : this.store.all();
      case 'task.get':
        return this.task(num(p, 'id'));
      case 'task.create':
        return this.createTask(p);
      case 'task.update':
        return this.updateTask(p);
      case 'task.dispatch':
        return this.dispatchTask(num(p, 'id'), str(p, 'agent', false) || undefined, str(p, 'by', false) || this.gm());
      case 'task.reassign':
        return this.reassign(num(p, 'id'), str(p, 'agent'), str(p, 'by', false) || this.gm());
      case 'task.note':
        return this.addNote(num(p, 'id'), str(p, 'author', false) || this.gm(), (str(p, 'kind', false) || 'context') as Note['kind'], str(p, 'text'));
      case 'task.progress':
        return this.progress(num(p, 'id'), str(p, 'agent'), str(p, 'text'), Number.isFinite(num(p, 'percent', false)) ? num(p, 'percent', false) : undefined);
      case 'task.eta':
        return this.setEta(num(p, 'id'), p.eta, str(p, 'by', false) || 'agent');
      case 'task.ask':
        return this.ask(p);
      case 'task.answer':
        return this.answer(num(p, 'id'), str(p, 'answer'), str(p, 'by', false) || 'you', str(p, 'questionId', false) || undefined);
      case 'task.escalate':
        return this.escalate(num(p, 'id'), str(p, 'view', false));
      case 'task.approve':
        return this.approve(num(p, 'id'), str(p, 'by', false) || 'you', str(p, 'text', false));
      case 'task.reject':
        return this.reject(num(p, 'id'), str(p, 'feedback', false), str(p, 'by', false) || 'you');
      case 'task.report':
        return this.report(p);
      case 'task.checkpoint':
        return this.checkpoint(num(p, 'id'), str(p, 'agent'), str(p, 'text'));
      case 'task.cancel':
        return this.cancel(num(p, 'id'), str(p, 'by', false) || 'you');
      case 'task.retry':
        return this.retry(num(p, 'id'));
      case 'memory.update':
        return this.updateMemory(str(p, 'agent'), str(p, 'text'));
      case 'agent.notice':
        return this.notice(str(p, 'agent'), p.answers === true);
      case 'team.list':
        return this.store.team().map((a) => ({ ...a, effectiveModel: this.effectiveModel(a) }));
      case 'models.get':
        return this.models();
      case 'models.set':
        return this.setModels(p, str(p, 'by', false) || 'you');
      case 'profiles.get':
        return resolveAgentProfile(this.meta, this.cfg);
      case 'profiles.set':
        return this.setAgentsProfile(str(p, 'agents', false), str(p, 'by', false) || 'you');
      case 'team.add':
        return this.addAgent(str(p, 'name', false) || undefined, str(p, 'profile', false) || undefined, str(p, 'model', false) || undefined);
      case 'team.remove':
        return this.removeAgent(str(p, 'name'));
      case 'team.move':
        return this.moveAgent(str(p, 'name'), str(p, 'profile'));
      case 'team.pause':
        return this.pauseAll(p.resume === true);
      case 'workspace.get':
        return this.store.workspace();
      case 'workspace.update':
        return this.updateWorkspace(p);
      case 'inbox.read':
        return this.readInbox(p.ack === true);
      case 'inbox.ack':
        return this.store.ackInbox(Array.isArray(p.ids) ? (p.ids as string[]) : undefined);
      case 'events':
        return this.store.events(typeof p.limit === 'number' ? p.limit : 100, Number.isFinite(num(p, 'taskId', false)) ? num(p, 'taskId', false) : undefined);
      case 'gm.session':
        this.meta.gmSessionId = str(p, 'sessionId');
        this.store.saveMeta(this.meta);
        return true;
      case 'gm.prompt':
        return gmSystemPrompt(this.meta, this.store.team(), this.store.workspace(), this.cfg, this.models());
      case 'config.reload':
        this.cfg = loadSwarmConfig();
        return this.cfg;
      case 'shutdown':
        setTimeout(() => void this.shutdown(), 10);
        return true;
      default:
        throw new RpcError(`unknown method ${method}`, 'no_method');
    }
  }

  // ------------------------------------------------------------------ snapshot
  private gmContextPct(): number | undefined {
    if (!this.meta.gmSessionId || this.meta.provider !== 'claude-code') return undefined;
    return readClaudeSession(this.profile.home, this.meta.gmSessionId, windowFor(resolveModel('gm', this.meta, this.cfg, this.profile).model, this.cfg.contextWindow)).contextPct;
  }

  private summary(): BoardSummary {
    const tasks = this.store.all();
    return {
      meta: this.meta,
      team: this.store.team().map((a) => ({ ...a, effectiveModel: this.effectiveModel(a) })),
      inboxUnread: this.store.inbox().filter((i) => !i.read).length,
      needYou: tasks.filter(needsYou).length,
      running: tasks.filter((t) => t.status === 'in_progress').length,
      queued: tasks.filter((t) => t.status === 'open' && t.dispatchRequested).length,
      active: tasks.filter(isActive).length,
      quota: this.quotaCache?.value,
      gmContextPct: this.gmContextPct(),
      takenAt: this.now(),
    };
  }

  private snapshot(): BoardSnapshot {
    const tasks = this.store.all();
    const team = this.store.team();
    const gmContextPct = this.gmContextPct();
    return {
      meta: this.meta,
      config: this.cfg,
      models: this.models(),
      workspace: this.store.workspace(),
      team: team.map((a) => ({ ...a, effectiveModel: this.effectiveModel(a) })),
      tasks,
      inboxUnread: this.store.inbox().filter((i) => !i.read).length,
      needYou: tasks.filter(needsYou).length,
      quota: this.quotaCache?.value,
      gmContextPct,
      takenAt: this.now(),
    };
  }

  // -------------------------------------------------------------------- tasks
  private createTask(p: Params): Task {
    const id = this.store.nextId();
    const parentId = Number.isFinite(num(p, 'parentId', false)) ? num(p, 'parentId', false) : undefined;
    const deps = Array.isArray(p.dependsOn) ? (p.dependsOn as unknown[]).map((d) => Number(String(d).replace(/^#/, ''))).filter((n) => Number.isFinite(n)) : [];
    const agent = str(p, 'agent', false) || undefined;
    if (agent && !this.agent(agent)) throw new RpcError(`no agent named ${agent}; the team is ${this.store.team().map((a) => a.name).join(', ')}`);
    const eta = this.parseEta(p.eta);
    if (!eta) throw new RpcError('Every task needs an eta. Give one like "2h", "1d", or a date and time such as "2026-09-07 18:00".', 'needs_eta');
    const t: Task = {
      id,
      title: str(p, 'title'),
      description: str(p, 'description', false),
      ask: str(p, 'ask', false) || undefined,
      status: 'open',
      awaitingPlanApproval: false,
      planFirst: p.planFirst === true,
      planApproved: false,
      reviewBy: p.reviewBy === 'gm' ? 'gm' : 'user',
      priority: Number.isFinite(num(p, 'priority', false)) ? Math.max(0, Math.min(3, num(p, 'priority', false))) : 2,
      eta,
      parentId,
      dependsOn: deps,
      paths: readPaths(p.paths),
      agent,
      dispatchRequested: false,
      hold: false,
      useWorktree: p.useWorktree === true,
      notes: [],
      questions: [],
      runs: [],
      activity: [],
      usage: { tokens: 0, usd: 0 },
      createdBy: str(p, 'by', false) || this.gm(),
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    const acceptance = str(p, 'acceptance', false);
    if (acceptance) this.note(t, t.createdBy, 'acceptance', acceptance);
    if (Array.isArray(p.notes)) for (const n of p.notes as string[]) if (typeof n === 'string' && n.trim()) this.note(t, t.createdBy, 'context', n);
    this.store.save(t);
    this.event(t.createdBy, `created${parentId ? ` under #${parentId}` : ''}${deps.length ? ` · waits for ${deps.map((d) => '#' + d).join(', ')}` : ''}`, id);
    this.changed(id);
    if (p.dispatch === true) this.dispatchTask(id, agent, t.createdBy);
    return this.task(id);
  }

  private parseEta(v: unknown): number | undefined {
    if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : v * 1000;
    if (typeof v === 'string' && v.trim()) {
      const s = v.trim();
      const rel = /^(\d+(?:\.\d+)?)\s*(m|min|h|hr|hours?|d|days?)$/i.exec(s);
      if (rel) {
        const n = Number(rel[1]);
        const u = rel[2]!.toLowerCase();
        const ms = u.startsWith('m') ? n * 6e4 : u.startsWith('h') ? n * 36e5 : n * 864e5;
        return this.now() + ms;
      }
      const d = new Date(s);
      if (!Number.isNaN(d.getTime())) return d.getTime();
    }
    return undefined;
  }

  private updateTask(p: Params): Task {
    const t = this.task(num(p, 'id'));
    if (typeof p.title === 'string' && p.title.trim()) t.title = p.title.trim();
    if (typeof p.description === 'string') t.description = p.description;
    if (p.priority !== undefined) t.priority = Math.max(0, Math.min(3, num(p, 'priority')));
    if (p.eta !== undefined) t.eta = this.parseEta(p.eta);
    if (Array.isArray(p.dependsOn)) t.dependsOn = (p.dependsOn as unknown[]).map((d) => Number(String(d).replace(/^#/, ''))).filter((n) => Number.isFinite(n));
    if (Array.isArray(p.paths)) t.paths = readPaths(p.paths);
    if (typeof p.reviewBy === 'string') t.reviewBy = p.reviewBy === 'gm' ? 'gm' : 'user';
    if (p.planFirst !== undefined) t.planFirst = p.planFirst === true;
    if (p.useWorktree !== undefined) t.useWorktree = p.useWorktree === true;
    if (p.hold !== undefined) {
      t.hold = p.hold === true;
      if (t.hold) t.dispatchRequested = false;
    }
    this.store.save(t);
    this.event(str(p, 'by', false) || this.gm(), p.hold === true ? 'put on hold' : p.hold === false ? 'taken off hold' : 'updated', t.id);
    if (p.hold === false) void this.tick();
    this.changed(t.id);
    return t;
  }

  private dispatchTask(id: number, agentName: string | undefined, by: string): Task {
    const t = this.task(id);
    if (!isActive(t)) throw new RpcError(`#${id} is ${t.status}`);
    if (agentName) {
      if (!this.agent(agentName)) throw new RpcError(`no agent named ${agentName}`);
      t.agent = agentName;
    }
    t.dispatchRequested = true;
    t.hold = false;
    if (t.status === 'plan' && t.awaitingPlanApproval) {
      // approving the plan is the dispatch
    } else if (t.status === 'open' || t.status === 'plan') {
      const unmet = this.unmetDeps(t);
      if (unmet.length) {
        t.status = 'blocked';
        t.blockedOn = { kind: 'dependency', taskId: unmet[0]!.id };
        t.resumeTo = 'open';
      }
    }
    this.store.save(t);
    this.event(by, `start requested${t.agent ? ` → ${t.agent}` : ' → next free agent'}`, id);
    this.changed(id);
    void this.tick();
    return t;
  }

  private unmetDeps(t: Task): Task[] {
    return t.dependsOn.map((d) => this.store.get(d)).filter((d): d is Task => !!d && d.status !== 'done' && d.status !== 'cancelled');
  }

  private reassign(id: number, agentName: string, by: string): Task {
    const t = this.task(id);
    // "none" (or an empty name) clears the pin: the task goes to the first free agent when it is
    // released, instead of waiting for one particular agent (owner, 11 Sep: a paused or open task
    // must not keep its previous agent reserved).
    if (agentName === '' || agentName === 'none') {
      if (t.status === 'in_progress') throw new RpcError(`#${id} is in progress on ${t.agent}; stop it before unassigning`);
      const was = t.agent;
      t.agent = undefined;
      this.store.save(t);
      this.event(by, `unassigned${was ? ` (was ${was})` : ''}`, id);
      this.changed(id);
      return t;
    }
    if (!this.agent(agentName)) throw new RpcError(`no agent named ${agentName}`);
    const prev = t.agent;
    if (t.status === 'in_progress' && prev) {
      this.killAgent(prev, 'moved to another agent');
      this.closeRun(t, 'paused', `moved to ${agentName}`);
      t.status = 'open';
      t.dispatchRequested = true;
    }
    t.agent = agentName;
    this.store.save(t);
    this.event(by, `assigned ${prev ? `from ${prev} ` : ''}→ ${agentName}`, id);
    this.changed(id);
    void this.tick();
    return t;
  }

  private addNote(id: number, author: string, kind: Note['kind'], text: string): Note & { message?: string } {
    const t = this.task(id);
    const n = this.note(t, author, kind, text);
    let message: string | undefined;
    if (kind === 'plan' && t.planFirst && !t.planApproved && isActive(t)) {
      // The plan is written: hold the task for the owner's approval.
      t.status = 'plan';
      t.awaitingPlanApproval = true;
      t.blockedOn = undefined;
      const a = this.agent(author);
      if (a && a.taskId === t.id) {
        a.state = 'waiting';
        this.saveAgent(a);
        message = 'Plan recorded. It now waits for the owner\'s approval; end your reply and you will be continued when it is approved or sent back.';
      }
      this.inbox('note', `A plan is waiting for approval on #${id} ${t.title} (by ${author}): ${text}`, id);
      this.tellOwner(`${this.gm()} · plan on #${id}`, `${t.title}: a plan is waiting for your approval`);
      this.event(author, 'plan written → awaiting your approval', id);
    } else {
      this.event(author, `note (${kind})`, id);
    }
    this.store.save(t);
    this.changed(id);
    return { ...n, message };
  }

  private progress(id: number, agent: string, text: string, percent?: number): boolean {
    const t = this.task(id);
    t.progress = text;
    t.progressAt = this.now();
    if (percent !== undefined) t.progressPct = Math.max(0, Math.min(100, Math.round(percent)));
    this.store.save(t);
    const a = this.agent(agent);
    if (a) {
      a.state = a.state === 'compacting' ? 'compacting' : 'working';
      this.saveAgent(a);
    }
    this.event(agent, `progress${percent !== undefined ? ` ${Math.round(percent)}%` : ''}: ${text}`, id);
    this.changed(id);
    return true;
  }

  private setEta(id: number, eta: unknown, by: string): Task {
    const t = this.task(id);
    t.eta = this.parseEta(eta);
    this.store.save(t);
    this.event(by, t.eta ? `eta → ${new Date(t.eta).toLocaleString()}` : 'eta cleared', id);
    this.changed(id);
    return t;
  }

  // ----------------------------------------------------------------- question
  private async ask(p: Params): Promise<{ ok: true; message: string }> {
    const id = num(p, 'id');
    const from = str(p, 'agent');
    const t = this.task(id);
    const missing = ['about', 'known', 'question', 'default'].filter((k) => !str(p, k, false));
    if (missing.length) {
      throw new RpcError(
        'Your question needs context: say what the task is for (about), what you know so far (known), what exactly you are asking (question), and what you will do if nobody answers, by when (default). Missing: ' +
          missing.join(', '),
        'needs_context',
      );
    }
    const q: Question = QuestionSchema.parse({
      id: shortId('q'),
      from,
      to: 'tm',
      about: str(p, 'about'),
      known: str(p, 'known'),
      question: str(p, 'question'),
      options: Array.isArray(p.options) ? (p.options as unknown[]).map(String).filter(Boolean) : [],
      default: str(p, 'default'),
      path: [],
      askedAt: this.now(),
    });
    t.questions.push(q);
    t.resumeTo = t.status === 'blocked' ? t.resumeTo : t.status;
    t.status = 'blocked';
    t.blockedOn = { kind: 'question', questionId: q.id, to: 'tm' };
    this.store.save(t);
    const a = this.agent(from);
    if (a) {
      a.state = 'waiting';
      this.saveAgent(a);
    }
    this.event(from, `asked: ${q.question}`, id);
    this.changed(id);

    // First hop: the task manager answers what is already written down, or approves a routine default.
    let answered = false;
    let why: string | undefined;
    if (this.cfg.triage !== 'off') {
      const all = this.store.all();
      const decisionsElsewhere = all
        .filter((x) => x.id !== id)
        .flatMap((x) => x.notes.filter((n) => n.kind === 'decision' || n.kind === 'acceptance').map((n) => ({ taskId: x.id, title: x.title, text: n.text, at: n.at })))
        .sort((a, b) => b.at - a.at)
        .slice(0, 15);
      const asks = all.filter((x) => x.ask && isActive(x)).map((x) => ({ taskId: x.id, ask: x.ask! })).slice(-10);
      const activeTasks = all.filter(isActive).map((x) => ({ id: x.id, title: x.title, status: statusLabel(x, this.gm()), agent: x.agent }));
      const tmModel = resolveModel('tm', this.meta, this.cfg, this.profile);
      const r = await triageQuestion(this.profile.home, modelArg(tmModel), this.cfg.triage, {
        task: t,
        root: this.root(t),
        parent: t.parentId !== undefined ? this.store.get(t.parentId) : undefined,
        decisionsElsewhere,
        asks,
        activeTasks,
        workspace: this.store.workspace(),
        gmName: this.gm(),
      }, q, {
        sessionId: this.meta.tmSessionId,
        onNewSession: (sid) => {
          this.meta.tmSessionId = sid;
          this.store.saveMeta(this.meta);
        },
      }, windowFor(tmModel.model, this.cfg.contextWindow), this.cfg.compactAt);
      if (r && 'answer' in r) {
        this.event('task manager', `answered (${r.basis}): ${r.answer}`, id);
        this.answer(id, `${r.answer}${r.reasoning ? ` — ${r.reasoning}` : ''}`, 'task manager', q.id);
        this.inbox('info', `For your awareness, no action needed: the task manager answered ${from}'s question on #${id} ${t.title}.\n  question: ${q.question}\n  answer: ${r.answer}\n  why: ${r.reasoning || r.basis}`, id);
        answered = true;
      } else if (r && 'escalate' in r) {
        why = r.why;
      }
    }
    if (!answered) {
      const fresh = this.task(id);
      const qq = fresh.questions.find((x) => x.id === q.id)!;
      qq.to = 'gm';
      qq.path.push({ to: 'gm', at: this.now(), note: why ? `the task manager could not settle it: ${why}` : 'the task manager could not settle it from what is written down' });
      fresh.blockedOn = { kind: 'question', questionId: q.id, to: 'gm' };
      this.store.save(fresh);
      this.inbox('question', `${from} asked on #${id} ${fresh.title}${why ? ` (the task manager could not settle it: ${why})` : ''}:\n  about: ${q.about}\n  known: ${q.known}\n  question: ${q.question}\n  options: ${q.options.join(' | ') || '(none)'}\n  default: ${q.default}\nAnswer it (task_answer) if the ask, the notes or your design settle it; otherwise put it to the owner in this shape with your view (task_escalate).`, id);
      this.event('task manager', `escalated to ${this.gm()}`, id);
      this.changed(id);
    }
    return { ok: true, message: 'Your question is recorded. Stop now and end your reply; you will be continued with the answer.' };
  }

  private escalate(id: number, view: string): Task {
    const t = this.task(id);
    const q = [...t.questions].reverse().find((x) => !x.answer);
    if (!q) throw new RpcError(`no open question on #${id}`);
    q.to = 'user';
    q.path.push({ to: 'user', at: this.now(), note: view || undefined });
    t.blockedOn = { kind: 'question', questionId: q.id, to: 'user' };
    this.store.save(t);
    this.event(this.gm(), `put the question to you${view ? `: ${view}` : ''}`, id);
    this.changed(id);
    this.tellOwner(`${this.gm()} · #${id} needs you`, q.question);
    return t;
  }

  private answer(id: number, answer: string, by: string, questionId?: string): Task {
    const t = this.task(id);
    const q = questionId ? t.questions.find((x) => x.id === questionId) : [...t.questions].reverse().find((x) => !x.answer);
    if (!q) throw new RpcError(`no open question on #${id}`);
    if (q.answer) throw new RpcError('that question was already answered');
    q.answer = answer;
    q.answeredBy = by;
    q.answeredAt = this.now();
    this.note(t, by, 'answer', `Answer to "${q.question}": ${answer}`);
    if (t.status === 'blocked' && t.blockedOn?.kind === 'question' && t.blockedOn.questionId === q.id) {
      t.status = t.resumeTo && t.resumeTo !== 'blocked' ? t.resumeTo : 'in_progress';
      t.blockedOn = undefined;
      t.resumeTo = undefined;
      const a = t.agent ? this.agent(t.agent) : undefined;
      if (t.status === 'in_progress' && a && this.runAlive(a.name)) {
        // The agent named its default and kept working, so its run is still going. The task stays in
        // progress and the answer reaches that run in its next task tool result. Setting the task to Open
        // and starting a run here did nothing (the agent already has a live run), which left a working
        // agent's task under Open on the board (17 Sep, #448).
        q.deliverLive = true;
        a.state = 'working';
        a.taskId = t.id;
        this.saveAgent(a);
      } else if (t.status === 'in_progress') {
        // Continue the agent with the answer.
        t.status = 'open';
        t.dispatchRequested = true;
        this.store.save(t);
        if (a) {
          a.state = 'idle';
          this.saveAgent(a);
          this.startRun(t, a, resumeMessage('answer', answer, t));
        }
      }
    }
    this.store.save(this.task(id));
    this.event(by, `answered: ${answer}`, id);
    this.changed(id);
    return this.task(id);
  }

  // ------------------------------------------------------------------- review
  private approve(id: number, by: string, text: string): Task {
    const t = this.task(id);
    if (t.status === 'plan' && t.awaitingPlanApproval) {
      t.awaitingPlanApproval = false;
      t.planApproved = true;
      t.status = 'open';
      t.dispatchRequested = true;
      this.note(t, by, 'decision', `Plan approved${text ? `: ${text}` : '.'}`);
      this.store.save(t);
      this.event(by, 'plan approved', id);
      this.changed(id);
      const a = t.agent ? this.agent(t.agent) : undefined;
      if (a && (a.state === 'waiting' || a.state === 'idle') && a.taskId === t.id) {
        a.state = 'idle';
        this.saveAgent(a);
        this.startRun(t, a, `Your plan for #${t.id} was approved${text ? ` with this note: ${text}` : ''}. Go ahead and carry it out, then report.`);
      } else void this.tick();
      return t;
    }
    if (t.status !== 'review') throw new RpcError(`nothing to approve on #${id} (${statusLabel(t, this.gm())})`);
    const isGm = by === this.gm();
    if (t.reviewStage === 'gm' && isGm && t.reviewBy === 'user') {
      t.reviewStage = 'user';
      if (text) this.note(t, by, 'decision', `Reviewed: ${text}`);
      this.store.save(t);
      this.event(by, 'approved → waiting for your acceptance', id);
      this.changed(id);
      this.tellOwner(`${this.gm()} · #${id} ready for you`, `${t.title}: reviewed by ${this.gm()}, needs your acceptance`);
      return t;
    }
    t.status = 'done';
    t.closedAt = this.now();
    t.reviewStage = undefined;
    if (text) this.note(t, by, 'decision', `Accepted: ${text}`);
    this.store.save(t);
    this.event(by, 'accepted → done', id);
    this.changed(id);
    this.unblockDependents(t);
    this.rollupParent(t);
    void this.tick();
    return t;
  }

  private reject(id: number, feedback: string, by: string): Task {
    const t = this.task(id);
    if (t.status === 'plan' && t.awaitingPlanApproval) {
      this.note(t, by, 'feedback', `Plan sent back: ${feedback}`);
      t.awaitingPlanApproval = false;
      t.status = 'open';
      t.dispatchRequested = true;
      this.store.save(t);
      this.event(by, 'plan sent back', id);
      this.changed(id);
      const a = t.agent ? this.agent(t.agent) : undefined;
      if (a && a.taskId === t.id && (a.state === 'waiting' || a.state === 'idle')) {
        a.state = 'idle';
        this.saveAgent(a);
        this.startRun(t, a, `Your plan for #${t.id} was sent back with this feedback: ${feedback}\n\nRevise the plan, record it again as a plan note, then end your reply.`);
      } else {
        this.inbox('note', `The plan on #${id} was sent back by ${by}: ${feedback}. Revise it (a new plan note) so it can be approved.`, id);
      }
      return t;
    }
    if (t.status === 'in_progress' || t.status === 'blocked') {
      // Stop the work. With feedback the agent is restarted on it; without, the task is put on hold.
      const a = t.agent ? this.agent(t.agent) : undefined;
      if (a) this.killAgent(a.name, feedback ? `redirected by ${by}` : `stopped by ${by}`);
      this.closeRun(t, 'paused', feedback ? `stopped by ${by} with feedback` : `stopped by ${by}`);
      if (a && a.taskId === t.id) {
        a.state = a.paused ? 'paused' : 'idle';
        a.taskId = undefined;
        this.saveAgent(a);
      }
      t.blockedOn = undefined;
      t.resumeTo = undefined;
      t.status = 'open';
      if (feedback) {
        this.note(t, by, 'feedback', `Stopped and redirected: ${feedback}`);
        t.dispatchRequested = true;
        this.store.save(t);
        this.event(by, `stopped ${a?.name ?? 'the agent'} and redirected: ${feedback}`, id);
        this.changed(id);
        if (a && !a.paused) this.startRun(t, a, resumeMessage('feedback', `You were stopped mid-task. ${feedback}`, t));
        else void this.tick();
      } else {
        this.note(t, by, 'decision', 'Stopped. On hold until started again.');
        t.dispatchRequested = false;
        t.hold = true;
        t.progress = undefined;
        this.store.save(t);
        this.event(by, `stopped ${a?.name ?? 'the agent'}; #${id} is on hold`, id);
        this.inbox('note', `${by === 'you' ? 'The owner' : by} stopped #${id} ${t.title}${a ? ` (${a.name} is idle again)` : ''}. It is on hold: start it again when it should continue, or cancel it.`, id);
        this.changed(id);
        void this.tick();
      }
      return t;
    }
    if (t.status !== 'review') throw new RpcError(`nothing to send back on #${id} (${statusLabel(t, this.gm())})`);
    if (!feedback) throw new RpcError('say what to change: feedback is needed to send a report back');
    this.note(t, by, 'feedback', `Sent back: ${feedback}`);
    t.status = 'open';
    t.reviewStage = undefined;
    t.dispatchRequested = true;
    this.store.save(t);
    this.event(by, `sent back: ${feedback}`, id);
    this.changed(id);
    const a = t.agent ? this.agent(t.agent) : undefined;
    if (a && a.state === 'idle') this.startRun(t, a, resumeMessage('feedback', feedback, t));
    else void this.tick();
    return t;
  }

  private report(p: Params): { ok: true; message: string } {
    const id = num(p, 'id');
    const from = str(p, 'agent');
    const t = this.task(id);
    const missing = ['changed', 'verified', 'left'].filter((k) => !str(p, k, false));
    if (missing.length) {
      throw new RpcError(`Your report needs: what changed (changed), how you verified it (verified), what is left (left). Missing: ${missing.join(', ')}`, 'needs_evidence');
    }
    t.report = ReportSchema.parse({ changed: str(p, 'changed'), verified: str(p, 'verified'), left: str(p, 'left'), watch: str(p, 'watch', false) || undefined, status: p.status === 'failed' ? 'failed' : 'done' });
    if (t.report.status === 'done') {
      t.progressPct = 100;
      t.progressAt = this.now();
    }
    if (t.report.status === 'failed') {
      t.status = 'open';
      t.dispatchRequested = false;
      this.note(t, from, 'finding', `Could not finish: ${t.report.changed}. Verified: ${t.report.verified}. Left: ${t.report.left}`);
      this.inbox('failed', `${from} could not finish #${id} ${t.title}: ${t.report.left}`, id);
    } else {
      t.status = 'review';
      t.reviewStage = 'gm';
      this.note(t, from, 'finding', `Reported done. Changed: ${t.report.changed} Verified: ${t.report.verified} Left: ${t.report.left}${t.report.watch ? ` Watch: ${t.report.watch}` : ''}`);
      this.inbox('done', `${from} reports #${id} ${t.title} done.\n  changed: ${t.report.changed}\n  verified: ${t.report.verified}\n  left: ${t.report.left}${t.report.watch ? `\n  watch: ${t.report.watch}` : ''}\nLook at the work${t.branch ? ` (branch ${t.branch})` : ''}, then task_approve or task_reject with feedback.`, id);
    }
    t.progress = undefined;
    this.store.save(t);
    const a = this.agent(from);
    if (a) {
      a.state = 'idle';
      a.taskId = undefined;
      this.saveAgent(a);
    }
    this.event(from, t.report.status === 'done' ? 'reported done → review' : 'reported: could not finish', id);
    this.changed(id);
    return { ok: true, message: 'Report recorded. You are done with this task; end your reply.' };
  }

  private checkpoint(id: number, agent: string, text: string): { ok: true; message: string } {
    const t = this.task(id);
    this.note(t, agent, 'checkpoint', text);
    this.store.save(t);
    const a = this.agent(agent);
    if (a) {
      a.rotateSession = true;
      a.compactRequestedAt = undefined;
      a.state = 'compacting';
      this.saveAgent(a);
    }
    this.event(agent, 'checkpoint written · will continue with a fresh context', id);
    this.changed(id);
    return { ok: true, message: 'Checkpoint saved. Refresh your project memory (memory_update) if needed, then end your reply; you will be continued with a fresh context.' };
  }

  private cancel(id: number, by: string): Task {
    const t = this.task(id);
    if (t.agent && t.status === 'in_progress') this.killAgent(t.agent, 'cancelled');
    this.closeRun(t, 'cancelled', `cancelled by ${by}`);
    t.status = 'cancelled';
    t.closedAt = this.now();
    t.blockedOn = undefined;
    this.store.save(t);
    const a = t.agent ? this.agent(t.agent) : undefined;
    if (a && a.taskId === id) {
      a.state = 'idle';
      a.taskId = undefined;
      this.saveAgent(a);
    }
    this.event(by, 'cancelled', id);
    this.changed(id);
    void this.tick();
    return t;
  }

  private retry(id: number): Task {
    const t = this.task(id);
    if (t.status === 'done') throw new RpcError(`#${id} is done`);
    t.status = 'open';
    t.blockedOn = undefined;
    t.dispatchRequested = true;
    this.store.save(t);
    this.event('you', 'retry requested', id);
    this.changed(id);
    void this.tick();
    return t;
  }

  private updateMemory(agent: string, text: string): boolean {
    const a = this.agent(agent);
    if (!a) throw new RpcError(`no agent ${agent}`);
    a.memory = text.slice(0, 2000);
    this.saveAgent(a);
    this.event(agent, 'refreshed project memory');
    return true;
  }

  /**
   * Appended to every agent tool result while its context is over the line. With `answers` (the agent's
   * own task tools), it also hands over, once, an answer that arrived while the agent's run kept working.
   */
  private notice(agent: string, answers = false): string | null {
    const a = this.agent(agent);
    if (!a) return null;
    if (a.compactRequestedAt && !a.rotateSession) {
      return `Notice from the task manager: your context is at ${a.contextPct}%, over the ${this.cfg.compactAt}% line. Write a checkpoint now (task_checkpoint: what is done, what is left, the next step, decisions and why), refresh your project memory (memory_update), then end your reply. You will be continued with a fresh context.`;
    }
    const t = a.taskId !== undefined ? this.store.get(a.taskId) : undefined;
    const waiting = answers && t ? t.questions.filter((q) => q.deliverLive && q.answer) : [];
    if (t && waiting.length) {
      for (const q of waiting) q.deliverLive = undefined;
      this.store.save(t);
      return waiting.map((q) => `Notice from the task manager: your question on #${t.id} was answered while you worked. Question: "${q.question}" Answer (${q.answeredBy ?? 'the task manager'}): ${q.answer}`).join('\n\n');
    }
    if (a.workspaceNotice) {
      const what = a.workspaceNotice;
      a.workspaceNotice = undefined;
      this.saveAgent(a);
      return `Notice from the task manager: the workspace changed while you worked: ${what}\n\nThese are the owner's current conventions; they win over anything older, including this task's own notes. Adapt and carry on.`;
    }
    if (t && !t.eta && t.status === 'in_progress') {
      return `Notice from the task manager: #${t.id} has no eta. Set one now with task_eta ("2h", "1d", or a date and time) and refine it as you learn more.`;
    }
    return null;
  }

  private unblockDependents(done: Task): void {
    for (const t of this.store.all()) {
      if (t.status === 'blocked' && t.blockedOn?.kind === 'dependency' && t.blockedOn.taskId === done.id) {
        if (this.unmetDeps(t).length === 0) {
          t.status = t.resumeTo ?? 'open';
          t.blockedOn = undefined;
          t.resumeTo = undefined;
          this.store.save(t);
          this.event('task manager', `#${done.id} is done; unblocked`, t.id);
          this.changed(t.id);
        } else {
          t.blockedOn = { kind: 'dependency', taskId: this.unmetDeps(t)[0]!.id };
          this.store.save(t);
        }
      }
    }
  }

  private rollupParent(child: Task): void {
    if (child.parentId === undefined) return;
    const parent = this.store.get(child.parentId);
    if (!parent) return;
    const kids = this.store.all().filter((k) => k.parentId === parent.id);
    if (kids.length && kids.every((k) => k.status === 'done' || k.status === 'cancelled') && isActive(parent) && parent.runs.length === 0) {
      parent.status = 'review';
      parent.reviewStage = 'gm';
      this.store.save(parent);
      this.inbox('done', `All sub-tasks of #${parent.id} ${parent.title} are done. Review the whole and approve or send back.`, parent.id);
      this.event('task manager', 'all sub-tasks done → review', parent.id);
      this.changed(parent.id);
    }
  }

  // --------------------------------------------------------------------- team
  private addAgent(name?: string, profileName?: string, model?: string): Agent {
    const team = this.store.team();
    const n = name ?? `${this.meta.name}-${team.length + 1}`;
    if (team.some((a) => a.name === n)) throw new RpcError(`agent ${n} exists`);
    const prof = profileName ? profileByName(profileName) : profileByName(resolveAgentProfile(this.meta, this.cfg).profile);
    if (!prof) throw new RpcError(`no profile ${profileName ?? resolveAgentProfile(this.meta, this.cfg).profile}`);
    if (prof.provider !== 'claude-code' && prof.provider !== 'codex') throw new RpcError(`profile ${prof.name} is ${prof.provider}; agents need Claude Code or Codex`);
    const a: Agent = { name: n, profile: prof.name, provider: prof.provider, model, state: 'idle', contextPct: 0, memory: '', rotateSession: false, paused: false, usdToday: 0, nudges: 0 };
    team.push(a);
    this.store.saveTeam(team);
    this.event('you', `agent ${n} added (${prof.name})`);
    this.push({ event: 'team' });
    void this.tick();
    return a;
  }

  private removeAgent(name: string): boolean {
    const a = this.agent(name);
    if (!a) throw new RpcError(`no agent ${name}`);
    if (a.state === 'working' || a.state === 'compacting') throw new RpcError(`${name} is working on #${a.taskId}; move that task to another agent or cancel it first`);
    this.store.saveTeam(this.store.team().filter((x) => x.name !== name));
    this.event('you', `agent ${name} removed`);
    this.push({ event: 'team' });
    return true;
  }

  private moveAgent(name: string, profileName: string): Agent {
    const a = this.agent(name);
    if (!a) throw new RpcError(`no agent ${name}`);
    const prof = profileByName(profileName);
    if (!prof) throw new RpcError(`no profile ${profileName}`);
    if (prof.provider !== 'claude-code' && prof.provider !== 'codex') throw new RpcError(`profile ${prof.name} is ${prof.provider}`);
    if (a.state === 'working' || a.state === 'compacting') throw new RpcError(`${name} is working on #${a.taskId}; wait for it to pause or finish`);
    a.profile = prof.name;
    a.provider = prof.provider;
    a.sessionId = undefined;
    a.sessionCwd = undefined;
    this.saveAgent(a);
    this.event('you', `agent ${name} moved to profile ${prof.name}`);
    this.push({ event: 'team' });
    return a;
  }

  private pauseAll(resume: boolean): Agent[] {
    const team = this.store.team();
    for (const a of team) {
      if (resume) {
        a.paused = false;
        if (a.state === 'paused') a.state = 'idle';
      } else {
        a.paused = true;
        if (a.state === 'working' || a.state === 'compacting') {
          this.killAgent(a.name, 'paused by you');
          const t = a.taskId !== undefined ? this.store.get(a.taskId) : undefined;
          if (t) {
            this.closeRun(t, 'paused', 'paused by you');
            t.status = 'open';
            t.dispatchRequested = true;
            this.store.save(t);
          }
        }
        a.state = 'paused';
        a.taskId = undefined;
      }
    }
    this.store.saveTeam(team);
    this.event('you', resume ? 'resumed every agent' : 'paused every agent');
    this.push({ event: 'team' });
    this.changed();
    if (resume) void this.tick();
    return team;
  }

  private updateWorkspace(p: Params): Workspace {
    const ws = this.store.workspace() ?? { dir: this.meta.dir, env: {}, tools: {}, notes: '', brief: '', updatedAt: this.now() };
    if (typeof p.branch === 'string') ws.branch = p.branch;
    if (typeof p.notes === 'string') ws.notes = p.notes;
    if (typeof p.brief === 'string') ws.brief = p.brief;
    if (typeof p.dir === 'string' && p.dir.trim()) ws.dir = p.dir.trim();
    if (p.env && typeof p.env === 'object') ws.env = { ...ws.env, ...(p.env as Record<string, string>) };
    ws.updatedAt = this.now();
    this.store.saveWorkspace(ws);
    this.event(this.gm(), `workspace updated: ${[ws.branch && `branch ${ws.branch}`, ws.notes, typeof p.brief === 'string' ? 'project brief' : ''].filter(Boolean).join(' · ')}`);
    // Only what agents work from counts as a change for them: the project brief is the task manager's.
    const touched = ['branch', 'notes', 'dir', 'env'].some((k) => p[k] !== undefined);
    if (touched) {
      const what = [ws.branch && `branch ${ws.branch}`, ws.notes].filter(Boolean).join(' · ');
      // A run already going gets it in its next tool result, once; the next start carries the new brief.
      for (const a of this.store.team()) {
        if (a.state !== 'working' && a.state !== 'compacting') continue;
        const t = a.taskId !== undefined ? this.store.get(a.taskId) : undefined;
        if (t) {
          this.note(t, this.gm(), 'context', `Workspace changed: ${what}`);
          this.store.save(t);
        }
        if (this.runAlive(a.name)) {
          a.workspaceNotice = what.slice(0, 4000);
          this.saveAgent(a);
        }
      }
    }
    this.changed();
    return ws;
  }

  private readInbox(ack: boolean): InboxItem[] {
    const items = this.store.inbox().filter((i) => !i.read);
    if (ack && items.length) this.store.ackInbox(items.map((i) => i.id));
    return items;
  }

  // -------------------------------------------------------------- scheduling
  private async tick(): Promise<void> {
    if (this.stopping) return;
    try {
      await this.refreshQuota();
      this.watch();
      this.assign();
    } catch (e) {
      this.log(`tick error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async refreshQuota(): Promise<void> {
    if (this.quotaCache && this.now() - this.quotaCache.at < 60_000) return;
    try {
      // Claude Code keeps no local quota cache, so ask the provider (cached 5 min, backs off on 429).
      const snap = await takeSnapshot({ provider: this.profile.provider, live: true });
      const mine = snap.profiles.find((p) => p.profile.name === this.profile.name);
      const win = mine?.usage.windows.slice().sort((a, b) => a.windowMinutes - b.windowMinutes)[0];
      this.quotaCache = {
        at: this.now(),
        value: win
          ? { profile: this.profile.name, label: win.label, usedPercent: win.usedPercent, resetsAt: win.resetsAt, plan: mine?.identity.plan, account: mine?.identity.account }
          : { profile: this.profile.name, label: '', usedPercent: -1, plan: mine?.identity.plan, account: mine?.identity.account },
      };
      if (win && win.usedPercent >= this.cfg.quotaWarnAt && this.now() - this.quotaWarnedAt > 3_600_000) {
        this.quotaWarnedAt = this.now();
        this.inbox('quota', `The ${this.profile.name} profile has used ${Math.round(win.usedPercent)}% of its ${win.label} window${win.resetsAt ? ` (resets ${new Date(win.resetsAt).toLocaleTimeString()})` : ''}. Tell the owner, and offer to slow down or move an agent to another profile (am agent move <agent> --profile <name>).`);
      }
    } catch {
      /* quota is advisory */
    }
  }

  private quotaHold(): boolean {
    const q = this.quotaCache?.value;
    return !!q && q.usedPercent >= this.cfg.quotaHoldAt;
  }

  /** What the manager has already said about a file clash, so it says it once per pairing. */
  private clashSaid = new Map<number, number>();

  private assign(): void {
    const team = this.store.team();
    const idle = team.filter((a) => a.state === 'idle' && !a.paused);
    if (!idle.length) return;
    // What a free agent may pick up: tasks someone started, and, with autostart, any open task that is not
    // parked on hold and not waiting on another task. Most urgent first: priority, then ETA, then age.
    const all = this.store.all();
    const queued = all
      .filter((t) => t.status === 'open' && !t.hold && (t.dispatchRequested || this.cfg.autostart) && this.unmetDeps(t).length === 0)
      .sort((a, b) => a.priority - b.priority || (a.eta ?? Infinity) - (b.eta ?? Infinity) || a.id - b.id);
    /** The agent that knows this corner best: worked on this task, its parent, or a sibling. */
    const familiar = (t: Task): string[] => {
      const names = t.runs.map((r) => r.agent);
      const kin = all.filter((x) => x.id !== t.id && (x.id === t.parentId || (t.parentId !== undefined && x.parentId === t.parentId)));
      for (const k of kin) names.push(...k.runs.map((r) => r.agent), ...(k.agent ? [k.agent] : []));
      return [...new Set(names)].reverse();
    };
    for (const t of queued) {
      if (this.quotaHold()) {
        if (t.status === 'open') {
          t.status = 'blocked';
          t.blockedOn = { kind: 'quota', profile: this.profile.name, resetsAt: this.quotaCache?.value?.resetsAt };
          t.resumeTo = 'open';
          this.store.save(t);
          this.changed(t.id);
        }
        continue;
      }
      /**
       * ═══ TWO LANES NEVER EDIT THE SAME FILE AT ONCE ═══ (friday, 17 Sep 2026)
       *
       * Re-applying onto a line another lane has just moved cost more time on 17 Sep than every suite run put
       * together: one task re-applied against twenty-one landings. So a task whose declared files a running task
       * already holds waits for it, and the manager fills the free agent with the next task instead. A task that
       * declares no paths is unaffected, so this only ever helps a lane that said what it would touch.
       */
      const busy = t.paths.length
        ? all.find((o) => o.status === 'in_progress' && o.id !== t.id && o.paths.length && pathsClash(t.paths, o.paths))
        : undefined;
      if (busy) {
        if (this.clashSaid.get(t.id) !== busy.id) {
          this.clashSaid.set(t.id, busy.id);
          this.event('task manager', `waiting for #${busy.id}: both change ${pathsClash(t.paths, busy.paths)}`, t.id);
        }
        continue;
      }
      const free = idle.filter((a) => !queued.some((o) => o.agent === a.name && o.id !== t.id));
      let agent = t.agent
        ? idle.find((a) => a.name === t.agent)
        : familiar(t).map((n) => free.find((a) => a.name === n)).find(Boolean) ?? free[0] ?? idle[0];
      if (!agent) continue;
      if (t.agent && agent.name !== t.agent) continue;
      idle.splice(idle.indexOf(agent), 1);
      agent = this.agent(agent.name)!;
      if (!t.dispatchRequested) {
        // Nobody asked for this one yet: the task manager is filling a free agent's hands.
        t.dispatchRequested = true;
        this.store.save(t);
        this.event('task manager', `started on ${agent.name}, who was free`, t.id);
        this.inbox('info', `For your awareness, no action needed: ${agent.name} was free, so the task manager started #${t.id} ${t.title} on it${t.priority <= 1 ? ' (high priority)' : ''}. Put a task on hold if it should wait.`, t.id);
      }
      this.startRun(t, agent);
      if (!idle.length) break;
    }
    // Quota freed up: release held tasks.
    if (!this.quotaHold()) {
      for (const t of this.store.all()) {
        if (t.status === 'blocked' && t.blockedOn?.kind === 'quota') {
          t.status = 'open';
          t.blockedOn = undefined;
          this.store.save(t);
          this.changed(t.id);
        }
      }
    }
  }

  private watch(): void {
    const team = this.store.team();
    let dirty = false;
    for (const a of team) {
      if (a.state !== 'working' && a.state !== 'compacting' && a.state !== 'stalled') continue;
      const t = a.taskId !== undefined ? this.store.get(a.taskId) : undefined;
      const run = t?.runs.find((r) => !r.endedAt);
      if (!t || !run) continue;
      const stats = this.stats(a, run.sessionId ?? a.sessionId);
      if (stats) {
        // What the agent is doing, for the board.
        const prevTop = t.activity[0]?.text;
        if (stats.recent.length) t.activity = stats.recent;
        if (t.activity[0]?.text !== prevTop) this.changed(t.id);
        if (a.state === 'stalled') {
          const idle = this.now() - (stats.lastActivity ?? run.startedAt);
          if (idle < this.cfg.stallAfterMin * 60_000) {
            a.state = 'working';
            if (t.status === 'blocked' && t.blockedOn?.kind === 'stalled') {
              t.status = 'in_progress';
              t.blockedOn = undefined;
              this.store.save(t);
              this.event('task manager', `${a.name} is active again`, t.id);
              this.changed(t.id);
            }
          }
          dirty = true;
          continue;
        }
        a.contextPct = stats.contextPct;
        run.contextPct = stats.contextPct;
        run.tokens = stats.totals.total;
        run.usd = stats.usd;
        t.usage = this.sumUsage(t);
        this.store.save(t);
        dirty = true;
        // How big the brief itself was: the context at the session's first reply, when this run began the session.
        const freshSession = !!run.sessionId && t.runs.filter((r) => r.sessionId === run.sessionId).length === 1;
        if (run.startContextPct === undefined && freshSession && stats.firstContextPct !== undefined) {
          run.startContextPct = stats.firstContextPct;
          this.store.save(t);
        }
        // A fresh session already over the line before doing anything: the brief is too big. Compacting again
        // would only loop, so stop and hand it to the GM.
        const startedOver = freshSession && run.startContextPct !== undefined && run.startContextPct >= this.cfg.compactAt;
        if (startedOver && t.status === 'in_progress') {
          this.holdOversized(a, t, stats);
          continue;
        }
        // Over the line and no checkpoint asked yet: ask, through the next tool call (hook) and tool result.
        if (stats.contextPct >= this.cfg.compactAt && !a.compactRequestedAt && !a.rotateSession && !startedOver) {
          a.compactRequestedAt = this.now();
          this.event('task manager', `${a.name} context at ${stats.contextPct}% → asked for a checkpoint`, t.id);
          this.inbox('context', `${a.name} is at ${stats.contextPct}% context on #${t.id}; it has been asked to write a checkpoint and will continue with a fresh context.`, t.id);
        }
        // Asked, but nothing written: after the grace period, or at the hard line, the task manager checkpoints for it.
        if (a.compactRequestedAt && !a.rotateSession && t.status === 'in_progress') {
          const waited = this.now() - a.compactRequestedAt;
          const hardLine = Math.max(98, this.cfg.compactAt); // a last resort; the grace period is the normal path
          if (waited > this.cfg.compactGraceMin * 60_000 || stats.contextPct >= hardLine) {
            // Three short compactions in a row with no report between them means we are spinning, not working.
            const previous = t.runs.filter((r) => r.endedAt).slice(-3);
            const spinning = previous.length === 3 && previous.every((r) => r.exit === 'compacted' && (r.endedAt ?? 0) - r.startedAt < 2 * 60_000);
            if (spinning) this.holdOversized(a, t, stats);
            else this.forceCheckpoint(a, t, stats);
            continue;
          }
        }
        // Budget.
        if (this.cfg.budgetUsd && t.usage.usd >= this.cfg.budgetUsd && t.status === 'in_progress') {
          this.killAgent(a.name, 'over budget');
          this.closeRun(t, 'paused', 'over budget');
          t.status = 'blocked';
          t.blockedOn = { kind: 'budget' };
          t.resumeTo = 'open';
          this.store.save(t);
          a.state = 'idle';
          a.taskId = undefined;
          this.inbox('note', `#${t.id} ${t.title} crossed its budget ($${t.usage.usd.toFixed(2)} of $${this.cfg.budgetUsd}). It is paused; raise the budget or cancel it.`, t.id);
          this.changed(t.id);
          continue;
        }
        // Stall: no transcript activity for stallAfterMin.
        const last = stats.lastActivity ?? run.startedAt;
        if (this.now() - last > this.cfg.stallAfterMin * 60_000 && t.status === 'in_progress') {
          a.state = 'stalled';
          this.event('task manager', `${a.name} shows no activity for ${this.cfg.stallAfterMin} min → stalled`, t.id);
          this.inbox('stalled', `${a.name} has shown no activity on #${t.id} ${t.title} for ${this.cfg.stallAfterMin} minutes. If it does not recover, cancel and retry the task (task_cancel, then am task retry).`, t.id);
          t.status = 'blocked';
          t.blockedOn = { kind: 'stalled' };
          t.resumeTo = 'in_progress';
          this.store.save(t);
          this.changed(t.id);
        }
      }
    }
    if (dirty) this.store.saveTeam(team);
    if (dirty) this.push({ event: 'team' });
  }

  /** The model an agent actually runs on: its own, else the one set for this GM, else the global setting, else its profile's default. */
  effectiveModel(a: Agent): string | undefined {
    return a.model ?? resolveModel(agentRole(a), this.meta, this.cfg, profileByName(a.profile)).model;
  }
  /** What to put on an agent's command line; unset means the tool applies the profile's own default. */
  private agentModelArg(a: Agent): string | undefined {
    return a.model ?? modelArg(resolveModel(agentRole(a), this.meta, this.cfg, profileByName(a.profile)));
  }
  models(): ModelsView {
    return modelsView(this.meta, this.cfg, this.profile, this.store.team(), profileByName);
  }
  /** Set a model for one or more groups, for this GM only. Empty, "default" or "profile" clears a group. */
  private setModels(p: Record<string, unknown>, by: string): ModelsView {
    const fresh = this.store.meta() ?? this.meta;
    const models: NonNullable<SwarmMeta['models']> = { ...(fresh.models ?? {}) };
    const changes: string[] = [];
    for (const role of MODEL_ROLES) {
      if (!(role in p)) continue;
      const v = normalizeModelValue(typeof p[role] === 'string' ? (p[role] as string) : undefined);
      if (v) models[role] = v;
      else delete models[role];
      changes.push(`${ROLE_LABEL[role]} → ${v ?? 'profile default'}`);
    }
    if (!changes.length) throw new RpcError('nothing to set: give gm, tm, agent or codexAgent');
    fresh.models = Object.keys(models).length ? models : undefined;
    this.meta.models = fresh.models;
    this.store.saveMeta(fresh);
    const reg = findSwarm(this.name);
    if (reg) saveSwarm({ ...reg, models: fresh.models });
    this.event(by, `models: ${changes.join('; ')}`);
    this.push({ event: 'team' });
    return this.models();
  }
  /**
   * The profile task agents live on, for this GM. Idle agents move now (their next task starts a fresh
   * session there); an agent in the middle of a run is left alone and named, so the owner can move it later.
   */
  private setAgentsProfile(profileName: string, by: string): { profile: string; source: string; moved: string[]; busy: string[] } {
    const fresh = this.store.meta() ?? this.meta;
    const value = normalizeModelValue(profileName);
    if (value) {
      const prof = profileByName(value);
      if (!prof) throw new RpcError(`no profile named ${value}`);
      if (prof.provider !== 'claude-code' && prof.provider !== 'codex') throw new RpcError(`profile ${prof.name} is ${prof.provider}; agents need Claude Code or Codex`);
    }
    fresh.profiles = value ? { ...(fresh.profiles ?? {}), agents: value } : undefined;
    this.meta.profiles = fresh.profiles;
    this.store.saveMeta(fresh);
    const reg = findSwarm(this.name);
    if (reg) saveSwarm({ ...reg, profiles: fresh.profiles });
    const target = resolveAgentProfile(this.meta, this.cfg);
    const prof = profileByName(target.profile);
    if (!prof || (prof.provider !== 'claude-code' && prof.provider !== 'codex')) throw new RpcError(`profile ${target.profile} is missing or is not a Claude Code or Codex profile`);
    const moved: string[] = [];
    const busy: string[] = [];
    const team = this.store.team();
    for (const a of team) {
      if (a.profile === prof.name) continue;
      if (a.state === 'working' || a.state === 'compacting') {
        busy.push(a.name);
        continue;
      }
      a.profile = prof.name;
      a.provider = prof.provider;
      a.sessionId = undefined;
      a.sessionCwd = undefined;
      moved.push(a.name);
    }
    this.store.saveTeam(team);
    this.event(by, `task agents' profile → ${target.profile}${moved.length ? ` (moved ${moved.join(', ')})` : ''}${busy.length ? ` (${busy.join(', ')} still working; move later)` : ''}`);
    this.push({ event: 'team' });
    return { profile: target.profile, source: target.source, moved, busy };
  }
  /**
   * The 90% line holds even when the agent never gets round to its own checkpoint: end the run,
   * write a checkpoint from what the task manager saw, and continue the task in a fresh session.
   */
  private forceCheckpoint(a: Agent, t: Task, stats: SessionStats): void {
    const seen = [
      t.progress ? `Last reported progress: ${t.progress}${t.progressPct !== undefined ? ` (${t.progressPct}%)` : ''}.` : '',
      stats.lastText ? `The agent's last words: "${stats.lastText}".` : '',
      stats.recent.length ? `Its most recent actions, latest first: ${stats.recent.slice(0, 6).map((r) => r.text).join('; ')}.` : '',
    ].filter(Boolean).join(' ');
    const text = `Automatic checkpoint by the task manager: ${a.name}'s context reached ${stats.contextPct}% without a checkpoint of its own. ${seen || 'No progress had been reported.'} Decisions and findings so far are in the notes above; files in the folder are as the agent left them. Continue from there and re-check anything half-done.`;
    this.killAgent(a.name, `context ${stats.contextPct}%, no checkpoint within the grace period`);
    this.closeRun(t, 'compacted', `context ${stats.contextPct}% → checkpoint by the task manager → fresh session`);
    this.note(t, 'task manager', 'checkpoint', text);
    a.rotateSession = true;
    a.compactRequestedAt = undefined;
    a.contextPct = 0;
    a.state = 'idle';
    a.taskId = undefined;
    this.saveAgent(a);
    t.status = 'open';
    t.blockedOn = undefined;
    t.dispatchRequested = true;
    this.store.save(t);
    this.event('task manager', `${a.name} did not checkpoint in time at ${stats.contextPct}% → checkpointed for it; continues with a fresh context`, t.id);
    this.inbox('context', `${a.name} reached ${stats.contextPct}% context on #${t.id} ${t.title} without writing a checkpoint, so the task manager wrote one from what it saw and is continuing the task in a fresh session. Glance at that checkpoint note if the work looks off.`, t.id);
    this.changed(t.id);
    void this.tick();
  }
  /** The task cannot be worked under the line as briefed: park it and tell the GM what to trim. */
  private holdOversized(a: Agent, t: Task, stats: SessionStats): void {
    this.killAgent(a.name, `over the context line (${stats.contextPct}%) as soon as it starts`);
    this.closeRun(t, 'paused', `context ${stats.contextPct}% right after starting: the brief is too big`);
    a.rotateSession = true;
    a.compactRequestedAt = undefined;
    a.contextPct = 0;
    a.state = 'idle';
    a.taskId = undefined;
    this.saveAgent(a);
    t.status = 'open';
    t.hold = true;
    t.dispatchRequested = false;
    t.blockedOn = undefined;
    this.note(t, 'task manager', 'finding', `Put on hold: a fresh session was at ${stats.contextPct}% context before doing anything, so this task's brief (description, notes, checkpoints) is too big to work under the ${this.cfg.compactAt}% line. Trim or summarise the notes, or split the task, then start it again.`);
    this.store.save(t);
    this.event('task manager', `${a.name} was over the context line (${stats.contextPct}%) as soon as it started → #${t.id} on hold: brief too big`, t.id);
    this.inbox('note', `#${t.id} ${t.title} is on hold: a fresh session was at ${stats.contextPct}% context before doing anything, so its brief (description plus notes) is too big to work under the ${this.cfg.compactAt}% line. Trim or summarise its notes (task_update description; move detail into the project brief), or split it into smaller tasks, then task_start it.`, t.id);
    this.changed(t.id);
    this.push({ event: 'team' });
  }
  private stats(a: Agent, sessionId?: string) {
    if (!sessionId || a.provider !== 'claude-code') return undefined;
    const prof = profileByName(a.profile);
    if (!prof) return undefined;
    return readClaudeSession(prof.home, sessionId, windowFor(this.effectiveModel(a), this.cfg.contextWindow));
  }

  private sumUsage(t: Task): { tokens: number; usd: number } {
    return t.runs.reduce((acc, r) => ({ tokens: acc.tokens + r.tokens, usd: acc.usd + r.usd }), { tokens: 0, usd: 0 });
  }

  // --------------------------------------------------------------- processes
  private terminateChild(name: string, child: ChildProcess): void {
    const a = this.agent(name);
    if (a?.provider === 'codex' && child.pid) {
      // Codex's npm launcher has a native child. Signal the whole detached group so neither the
      // model process nor its task bridge survives a stop and keeps editing the same worktree.
      process.kill(-child.pid, 'SIGTERM');
      return;
    }
    child.kill('SIGTERM');
  }

  private killAgent(name: string, why: string): void {
    const child = this.children.get(name);
    if (child) {
      this.children.delete(name);
      try {
        this.terminateChild(name, child);
      } catch {
        /* gone */
      }
      this.log(`killed ${name}: ${why}`);
    }
  }

  private closeRun(t: Task, exit: Run['exit'], note?: string): void {
    const run = t.runs.find((r) => !r.endedAt);
    if (!run) return;
    run.endedAt = this.now();
    run.exit = exit;
    run.exitNote = note;
    this.store.save(t);
  }

  private cwdFor(t: Task, ws: Workspace | undefined): string {
    const base = ws?.dir ?? this.meta.dir;
    if (!t.useWorktree) return base;
    if (t.worktree && fs.existsSync(t.worktree)) return t.worktree;
    const slug = t.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
    const branch = `swarm/${t.id}-${slug}`;
    const dir = path.join(this.store.paths.worktrees, String(t.id));
    try {
      execFileSync('git', ['worktree', 'add', '-B', branch, dir], { cwd: base, stdio: 'ignore' });
      t.worktree = dir;
      t.branch = branch;
      this.store.save(t);
      this.event('task manager', `worktree created on branch ${branch}`, t.id);
      return dir;
    } catch (e) {
      this.note(t, 'task manager', 'context', `Could not create a worktree (${e instanceof Error ? e.message : String(e)}); working in the shared folder instead.`);
      t.useWorktree = false;
      this.store.save(t);
      return base;
    }
  }

  private mcpConfigFor(a: Agent, t: Task): { file: string; command: { command: string; args: string[] } } {
    const command = { command: process.execPath, args: [amEntry(), '_bridge', '--gm', this.name, '--role', 'agent', '--agent', a.name, '--task', String(t.id)] };
    const file = path.join(this.store.paths.dir, `mcp-${a.name}.json`);
    writeJsonAtomic(file, { mcpServers: { swarm: command } });
    return { file, command };
  }

  /**
   * Claude Code settings for an agent: a hook on every tool call that, once the agent is over the
   * context line, refuses the call and tells it to checkpoint. So the notice reaches it on its very
   * next action, not only when it happens to use a task tool.
   */
  private agentSettingsFor(a: Agent): string | undefined {
    if (a.provider !== 'claude-code') return undefined;
    const file = path.join(this.store.paths.dir, `agent-settings-${a.name}.json`);
    const hook = `"${process.execPath}" "${amEntry()}" _hook compact --gm ${this.name} --agent ${a.name}`;
    writeJsonAtomic(file, { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: hook, timeout: 10 }] }] } });
    return file;
  }

  /**
   * A task's checkout and a linked worktree's shared Git directory both have to be writable.
   * Codex normally treats its current directory as writable, but its project boundary can still
   * come from the conversation that launched it. Naming the checkout explicitly keeps a task
   * that lives outside the GM's repository folder writable as well.
   */
  private writableRootsFor(cwd: string, task: Task): string[] {
    const roots = [cwd];
    /** A continuation may deliberately finish work in its parent's existing checkout rather
     * than create a second branch. Give it that one checkout, not the whole worktree folder. */
    const parent = task.parentId === undefined ? undefined : this.store.get(task.parentId);
    for (const worktree of [task.worktree, parent?.worktree]) {
      if (worktree && fs.existsSync(worktree)) roots.push(worktree);
    }
    try {
      const raw = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      if (!raw) return roots;
      roots.push(path.isAbsolute(raw) ? raw : path.resolve(cwd, raw));
      return [...new Set(roots)];
    } catch {
      return roots;
    }
  }

  /** Start (or continue) an agent on a task. `message` replaces the brief when resuming mid-task. */
  /** True while this task manager's run for the agent has not exited. */
  private runAlive(agentName: string): boolean {
    const child = this.children.get(agentName);
    return !!child && child.exitCode === null && child.signalCode === null;
  }

  private startRun(t: Task, a: Agent, message?: string): void {
    const running = this.children.get(a.name);
    if (running) {
      // A child that has already exited must not block the agent forever. The exit handler only
      // deletes the entry when the exiting child is the stored one; two quick dispatches can leave
      // a dead child in the map (11 Sep: friday-4 idle on the board, never given a task again).
      if (running.exitCode === null && running.signalCode === null) return;
      this.children.delete(a.name);
    }
    const prof = profileByName(a.profile);
    if (!prof) {
      this.inbox('note', `Agent ${a.name} points at a profile that no longer exists (${a.profile}).`);
      return;
    }
    const ws = this.store.workspace();
    const cwd = this.cwdFor(t, ws);
    const all = this.store.all();
    const parent = t.parentId !== undefined ? this.store.get(t.parentId) : undefined;
    const brief = agentBrief({
      agent: a,
      task: t,
      root: this.root(t),
      parent,
      siblings: all.filter((s) => s.parentId === t.parentId && s.id !== t.id && t.parentId !== undefined),
      dependsOn: t.dependsOn.map((d) => this.store.get(d)).filter((d): d is Task => !!d),
      workspace: ws,
      cwd,
      gmName: this.gm(),
      compactAt: this.cfg.compactAt,
      verify: this.cfg.verify,
      testsFirst: this.cfg.testsFirst,
    });
    // Session continuity: keep the agent's session unless it must rotate or the folder changed.
    // Also start fresh when the agent's last session is already over the line: a new task must not inherit a full window.
    const mustRotate = a.rotateSession || !a.sessionId || (a.sessionCwd && a.sessionCwd !== cwd) || a.contextPct >= this.cfg.compactAt || a.provider === 'codex' && !a.sessionId;
    const resume = !mustRotate;
    let prompt: string;
    if (resume && message) prompt = message;
    else if (resume) prompt = `New task for you.\n\n${brief}`;
    else if (a.rotateSession && message) prompt = `${message}\n\nFor reference, the task brief again:\n\n${brief}`;
    else if (a.rotateSession) {
      const cp = [...t.notes].reverse().find((n) => n.kind === 'checkpoint');
      prompt = cp ? `${resumeMessage('checkpoint', cp.text, t)}\n\nThe task brief again:\n\n${brief}` : brief;
    } else prompt = brief;
    if (mustRotate) {
      // Claude accepts a caller-assigned id for a new conversation. Codex does not: it assigns
      // the real thread id after launch. Do not persist a temporary UUID for Codex, because if
      // the first turn ends before that id is learned the automatic nudge will try to resume a
      // conversation that never existed and put the task straight back in Open.
      a.sessionId = a.provider === 'codex' ? undefined : randomUUID();
      a.sessionCwd = cwd;
      a.rotateSession = false;
    }
    a.compactRequestedAt = undefined;
    const runN = t.runs.length + 1;
    const run: Run = { id: shortId('r'), n: runN, taskId: t.id, agent: a.name, sessionId: a.sessionId, startedAt: this.now(), tokens: 0, usd: 0, log: path.join(this.store.paths.runs, `${t.id}-${runN}-${a.name}.log`) };
    const mcp = this.mcpConfigFor(a, t);
    const adapter = agentAdapter(a.provider);
    let child: ChildProcess;
    try {
      child = adapter.spawn({
        provider: a.provider,
        profileHome: prof.home,
        cwd,
        prompt,
        systemPrompt: `You are ${a.name}, a task agent. Follow the task brief you were given. Use the task tools to ask, note, report and checkpoint; never end a task without reporting or asking.`,
        // A fresh Codex launch ignores this value; keeping the placeholder local prevents it
        // from ever becoming continuation state. `learnSessionId` replaces it with Codex's real
        // thread id before any legitimate resume.
        sessionId: a.sessionId ?? randomUUID(),
        resume,
        mcpConfigPath: mcp.file,
        mcpCommand: mcp.command,
        model: this.agentModelArg(a),
        allow: this.cfg.allow,
        permissionMode: this.cfg.permissionMode,
        extraEnv: ws?.env ?? {},
        writableRoots: this.writableRootsFor(cwd, t),
        compactAt: this.cfg.compactAt,
        compactEnv: this.cfg.compactEnv,
        logPath: run.log!,
        settingsPath: this.agentSettingsFor(a),
      });
    } catch (e) {
      this.inbox('failed', `Could not start ${a.name} on #${t.id}: ${e instanceof Error ? e.message : String(e)}`, t.id);
      return;
    }
    run.pid = child.pid;
    t.runs.push(run);
    t.status = 'in_progress';
    t.blockedOn = undefined;
    t.agent = a.name;
    t.progress = resume && message ? 'continuing' : 'starting';
    this.store.save(t);
    a.state = 'working';
    a.taskId = t.id;
    this.saveAgent(a);
    this.children.set(a.name, child);
    this.event(a.name, `${resume ? 'continued' : 'started'} run ${runN}${t.branch ? ` on ${t.branch}` : ''}`, t.id);
    this.changed(t.id);
    this.push({ event: 'team' });
    child.on('exit', (code) => this.onExit(a.name, t.id, run.id, code, child));
    child.on('error', (e) => {
      this.log(`spawn error for ${a.name}: ${e.message}`);
      this.onExit(a.name, t.id, run.id, 1, child);
    });
  }

  /** Codex assigns its own thread id after launch; preserve it before any continuation or restart. */
  private learnSessionId(a: Agent, run: Run): void {
    const adapter = agentAdapter(a.provider);
    if (!adapter.sessionIdFromLog || !run.log) return;
    const sid = adapter.sessionIdFromLog(run.log);
    if (!sid) return;
    a.sessionId = sid;
    run.sessionId = sid;
  }

  private onExit(agentName: string, taskId: number, runId: string, code: number | null, child?: ChildProcess): void {
    if (this.children.get(agentName) === child) this.children.delete(agentName);
    const a = this.agent(agentName);
    const t = this.store.get(taskId);
    if (!a || !t) return;
    const run = t.runs.find((r) => r.id === runId);
    if (!run) return;
    if (run.endedAt) {
      // Closed by cancel/stop/reassign already. Reset the agent unless it has moved on to another
      // open run. This must not depend on a.taskId matching THIS run: a stop, a reassign to another
      // agent and a quick second dispatch can leave a.taskId pointing at a different task whose run
      // is also closed, and the agent then stays "working" forever with nothing running (11 Sep,
      // friday-4 stuck on #193 while friday-3 ran it; the profile move was refused for it).
      const busyElsewhere = this.store.all().some((x) => x.runs.some((r) => !r.endedAt && r.agent === agentName));
      if (!busyElsewhere) {
        a.state = a.paused ? 'paused' : 'idle';
        a.taskId = undefined;
        this.saveAgent(a);
      }
      void this.tick();
      return;
    }
    // Learn the session id if the tool assigned it (Codex).
    this.learnSessionId(a, run);
    const stats = this.stats(a, run.sessionId);
    if (stats) {
      run.tokens = stats.totals.total;
      run.usd = stats.usd;
      run.contextPct = stats.contextPct;
      a.contextPct = stats.contextPct;
    }
    run.endedAt = this.now();
    const fresh = this.task(taskId);
    if (fresh.status === 'blocked' && fresh.blockedOn?.kind === 'question') {
      run.exit = 'blocked';
      a.state = 'waiting';
      a.nudges = 0;
    } else if (fresh.status === 'plan' && fresh.awaitingPlanApproval) {
      run.exit = 'paused';
      run.exitNote = 'plan awaiting approval';
      a.state = 'waiting';
      a.nudges = 0;
    } else if (fresh.status === 'review' || fresh.status === 'done' || (fresh.status === 'open' && fresh.report?.status === 'failed')) {
      run.exit = 'done';
      a.state = 'idle';
      a.taskId = undefined;
      a.nudges = 0;
    } else if (fresh.status === 'cancelled') {
      run.exit = 'cancelled';
      a.state = 'idle';
      a.taskId = undefined;
    } else if (a.rotateSession) {
      run.exit = 'compacted';
      run.exitNote = `context ${run.contextPct ?? '?'}% → checkpoint → fresh session`;
      a.state = 'idle';
      a.contextPct = 0;
      fresh.status = 'open';
      fresh.dispatchRequested = true;
      a.nudges = 0;
    } else if (code !== 0 && code !== null) {
      run.exit = 'failed';
      run.exitNote = `exit code ${code}`;
      a.state = 'idle';
      a.taskId = undefined;
      a.rotateSession = true;
      fresh.status = 'open';
      fresh.dispatchRequested = false;
      this.note(fresh, 'task manager', 'finding', `${a.name}'s run ended with an error (exit ${code}); see ${run.log}.`);
      this.inbox('failed', `${a.name}'s run on #${taskId} ${fresh.title} ended with an error (exit code ${code}). The task is back to open; check ${run.log}, then start it again or cancel it.`, taskId);
    } else if (a.nudges < 2) {
      // Ended its turn without reporting or asking: nudge once or twice, then give up.
      run.exit = 'paused';
      run.exitNote = 'ended without a report or a question';
      a.nudges += 1;
      a.state = 'idle';
      fresh.status = 'open';
      fresh.dispatchRequested = true;
      this.store.save(fresh);
      this.saveAgent(a);
      this.event('task manager', `${a.name} ended without reporting; asked it to continue (${a.nudges}/2)`, taskId);
      this.startRun(fresh, a, `You ended your reply without reporting or asking. If #${taskId} is finished, report it now (task_report) with what changed, how you verified it and what is left. If you are stuck, ask (task_ask) with the five parts. Otherwise continue the work.`);
      return;
    } else {
      run.exit = 'failed';
      run.exitNote = 'ended repeatedly without a report';
      a.state = 'idle';
      a.taskId = undefined;
      a.nudges = 0;
      a.rotateSession = true;
      fresh.status = 'open';
      fresh.dispatchRequested = false;
      this.inbox('failed', `${a.name} stopped twice on #${taskId} ${fresh.title} without reporting. The task is back to open; look at ${run.log}, then start it again with a clearer brief or cancel it.`, taskId);
    }
    fresh.usage = this.sumUsage(fresh);
    this.store.save(fresh);
    this.saveAgent(a);
    this.event(a.name, `run ended · ${run.exit}${run.exitNote ? ` · ${run.exitNote}` : ''}`, taskId);
    this.changed(taskId);
    this.push({ event: 'team' });
    void this.tick();
  }
}

export function fmtPriority(p: number): string {
  return PRIORITY_LABEL[p] ?? `P${p}`;
}
export type { BlockedOn };
