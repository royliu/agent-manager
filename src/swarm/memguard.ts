import { execFileSync } from 'node:child_process';
import os from 'node:os';
import pc from 'picocolors';

/**
 * ═══ THE MEMORY GUARD ═══ (friday, 28 Sep 2026)
 *
 * At 05:49 the Mac ran out of memory with 358 node and 331 esbuild processes alive (~280 GB resident):
 * the agents' check scripts (tsx, each with an esbuild helper) piling up. Nothing capped how many ran,
 * a script's own timeout killed only its launcher and left the child running, and every agent restarted
 * at the same moment after a limit reset and after a wake. The Mac froze twice.
 *
 * So the board server samples the process table every tick and counts what the agents' scripts hold:
 * everything a task agent's Claude Code or Codex session started through its shell (a Bash tool call is
 * a shell child of the session), with all of its descendants, plus anything still in that shell's
 * process group after its parent died (an orphan a timeout left behind). The sessions themselves, their
 * MCP servers, the board server, the GM and anything the agents did not start are never counted and
 * never stopped.
 */

export interface Proc {
  pid: number;
  ppid: number;
  pgid: number;
  /** Resident memory in bytes. */
  rss: number;
  /** Seconds since it started. */
  age: number;
  command: string;
}

/** Who a script belongs to. */
export interface Owner {
  agent: string;
  taskId?: number;
}

/** One script an agent started: a shell and everything under it, or an orphaned process group. */
export interface ScriptUnit {
  /** g<pgid> when it has its own process group (killed as a group), p<pid> otherwise (killed as a tree). */
  key: string;
  pgid?: number;
  owner: Owner;
  procs: Proc[];
  rss: number;
  /** Seconds since its oldest process started: when the script began. */
  age: number;
}

export function parseEtime(s: string): number {
  // [[dd-]hh:]mm:ss
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s.trim());
  if (!m) return 0;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

/** `ps -Ao pid,ppid,pgid,rss,etime,command` output (header included). */
export function parsePs(text: string): Proc[] {
  const out: Proc[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), rss: Number(m[4]) * 1024, age: parseEtime(m[5]!), command: m[6]! });
  }
  return out;
}

export function readPs(): Proc[] {
  const text = execFileSync('ps', ['-Aww', '-o', 'pid=,ppid=,pgid=,rss=,etime=,command='], {
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
  }).toString();
  return parsePs(text);
}

/** What the Mac has in use, as Activity Monitor counts it (app + wired + compressed). Undefined off macOS. */
export function macMemory(): { usedBytes: number; totalBytes: number } | undefined {
  if (process.platform !== 'darwin') return undefined;
  try {
    const text = execFileSync('vm_stat', [], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const page = Number(/page size of (\d+) bytes/.exec(text)?.[1] ?? 16384);
    const n = (label: string) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(text)?.[1] ?? 0);
    const used = (n('Anonymous pages') - n('Pages purgeable') + n('Pages wired down') + n('Pages occupied by compressor')) * page;
    return { usedBytes: Math.max(0, used), totalBytes: os.totalmem() };
  } catch {
    return undefined;
  }
}

const SHELL_RE = /^(?:\S*\/)?(?:sh|bash|zsh|dash|ksh|fish|sandbox-exec)(?:\s|$)/;
const SESSION_RE = /(?:^|\/)(?:claude|codex)(?:\s|$)|\/codex(?:\.js)?(?:\s|$)|@openai\/codex/;

/**
 * The agents' scripts in a process table. `roots` are the session processes the board server spawned
 * (pid → owner); `tracked` remembers the process groups of scripts seen before, so a script whose shell
 * died (reparented to launchd) is still found through its group. `protectedPids` are never included.
 */
export function scriptUnits(procs: Proc[], roots: Map<number, Owner>, tracked: Map<number, Owner>, protectedPids: Set<number>): { units: ScriptUnit[]; sessionPids: Set<number> } {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const kids = new Map<number, Proc[]>();
  for (const p of procs) {
    const list = kids.get(p.ppid);
    if (list) list.push(p);
    else kids.set(p.ppid, [p]);
  }
  // The sessions: each root, and any claude/codex process it runs (Codex's npm launcher has a native child).
  const sessionPids = new Set<number>();
  const tops: Array<{ proc: Proc; owner: Owner }> = [];
  for (const [rootPid, owner] of roots) {
    const root = byPid.get(rootPid);
    if (!root) continue;
    const stack = [root];
    while (stack.length) {
      const s = stack.pop()!;
      sessionPids.add(s.pid);
      for (const c of kids.get(s.pid) ?? []) {
        if (protectedPids.has(c.pid)) continue;
        if (SHELL_RE.test(c.command)) tops.push({ proc: c, owner });
        else if (SESSION_RE.test(c.command)) stack.push(c);
        // Anything else (an MCP server, the task bridge) is part of the session, not a script.
      }
    }
  }
  const off = (p: Proc) => protectedPids.has(p.pid) || sessionPids.has(p.pid);
  /** Process groups that must never be signalled as a group: the sessions' and the board server's own. */
  const safeGroups = new Set<number>();
  for (const pid of [...sessionPids, ...protectedPids]) {
    const p = byPid.get(pid);
    if (p) safeGroups.add(p.pgid);
  }
  const taken = new Set<number>();
  const units = new Map<string, ScriptUnit>();
  const collect = (start: Proc, into: Proc[]) => {
    const stack = [start];
    while (stack.length) {
      const p = stack.pop()!;
      if (taken.has(p.pid) || off(p)) continue;
      taken.add(p.pid);
      into.push(p);
      stack.push(...(kids.get(p.pid) ?? []));
    }
  };
  for (const { proc, owner } of tops) {
    const own = proc.pgid === proc.pid && !safeGroups.has(proc.pgid);
    const key = own ? `g${proc.pgid}` : `p${proc.pid}`;
    const unit = units.get(key) ?? { key, pgid: own ? proc.pgid : undefined, owner, procs: [], rss: 0, age: 0 };
    collect(proc, unit.procs);
    units.set(key, unit);
    if (own) tracked.set(proc.pgid, owner);
  }
  // Orphans: still in a script's group after the shell or the session that started it is gone.
  for (const p of procs) {
    if (taken.has(p.pid) || off(p) || safeGroups.has(p.pgid)) continue;
    const owner = tracked.get(p.pgid);
    if (!owner) continue;
    const key = `g${p.pgid}`;
    const unit = units.get(key) ?? { key, pgid: p.pgid, owner, procs: [], rss: 0, age: 0 };
    collect(p, unit.procs);
    units.set(key, unit);
  }
  // A group with no process left can be forgotten; its id cannot be reused while any member lives.
  const liveGroups = new Set(procs.map((p) => p.pgid));
  for (const g of [...tracked.keys()]) if (!liveGroups.has(g)) tracked.delete(g);
  const out = [...units.values()].filter((u) => u.procs.length);
  for (const u of out) {
    u.rss = u.procs.reduce((n, p) => n + p.rss, 0);
    u.age = Math.max(...u.procs.map((p) => p.age));
  }
  return { units: out, sessionPids };
}

/** Which scripts to stop: newest first, until what is left is at or under the hold line. None under the stop line. */
export function planStops(units: ScriptUnit[], holdBytes: number, stopBytes: number): ScriptUnit[] {
  let total = units.reduce((n, u) => n + u.rss, 0);
  if (total <= stopBytes) return [];
  const stops: ScriptUnit[] = [];
  for (const u of [...units].sort((a, b) => a.age - b.age)) {
    if (total <= holdBytes) break;
    stops.push(u);
    total -= u.rss;
  }
  return stops;
}

export const GB = 1024 ** 3;
export const gb = (bytes: number) => (bytes / GB).toFixed(bytes >= 10 * GB ? 0 : 1);

/** "node … proof/1182/check.mts": the biggest process of a script, by its program and its last argument. */
export function describeUnit(u: ScriptUnit): string {
  const big = [...u.procs].sort((a, b) => b.rss - a.rss)[0];
  if (!big) return 'a script';
  const words = big.command.split(/\s+/).filter(Boolean);
  const prog = (words[0] ?? '').split('/').pop() ?? '';
  // The last path-like argument, shortened to its last three parts, and whatever follows it ("vitest run").
  let i = words.length - 1;
  while (i > 0 && !words[i]!.includes('/')) i -= 1;
  const from = i > 0 ? i : Math.min(1, words.length - 1);
  const rest = words.slice(from).map((w, n) => (n === 0 && w.includes('/') ? w.split('/').filter(Boolean).slice(-3).join('/') : w)).join(' ');
  const shown = from > 0 && rest ? `${prog} … ${rest.slice(0, 60)}` : prog;
  return shown || 'a script';
}

export function ago(sec: number): string {
  if (sec < 90) return `${Math.max(1, Math.round(sec))} s ago`;
  if (sec < 5400) return `${Math.round(sec / 60)} min ago`;
  return `${Math.round(sec / 3600)} h ago`;
}

/** What the board and `am status` show about memory, from the guard's last sample. */
export interface MemView {
  scriptsBytes: number;
  holdGb: number;
  stopGb: number;
  macUsedBytes?: number;
  macTotalBytes?: number;
  /** When the guard last stopped a script. */
  stoppedAt?: number;
  working: number;
  maxWorking: number;
  /** Why no new run starts right now, if one would wait. */
  held?: string;
  at: number;
}

/** "mem 9.2/24 GB · mac 41/64 GB", coloured green under the hold line, yellow to the stop line, red above it or after a stop. */
export function memCell(m: MemView | undefined, withMac: boolean, now = Date.now()): string {
  if (!m) return '';
  const hot = m.scriptsBytes >= m.stopGb * GB || (m.stoppedAt !== undefined && now - m.stoppedAt < 10 * 60_000);
  const warm = m.scriptsBytes >= m.holdGb * GB;
  const paint = hot ? pc.red : warm ? pc.yellow : pc.green;
  const mem = paint(`mem ${gb(m.scriptsBytes)}/${m.stopGb} GB`);
  if (!withMac || m.macUsedBytes === undefined || !m.macTotalBytes) return mem;
  return `${mem}${pc.dim(` · mac ${Math.round(m.macUsedBytes / GB)}/${Math.round(m.macTotalBytes / GB)} GB`)}`;
}
