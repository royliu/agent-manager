import os from 'node:os';
import path from 'node:path';
import { AM_HOME, ensureDir } from '../core/paths.js';

/** Everything one swarm owns lives under ~/.agent-manager/swarms/<name>/. */
export const SWARMS_DIR = path.join(AM_HOME, 'swarms');
export const SWARMS_FILE = path.join(AM_HOME, 'swarms.json');
export const SWARM_CONFIG_FILE = path.join(AM_HOME, 'swarm-config.json');

export interface SwarmPaths {
  dir: string;
  tasks: string;
  events: string;
  inbox: string;
  team: string;
  workspace: string;
  meta: string;
  counter: string;
  runs: string;
  worktrees: string;
  sock: string;
  pid: string;
  lock: string;
  log: string;
  mcpConfig: string;
  gmSettings: string;
  gmPrompt: string;
}

export function swarmPaths(name: string): SwarmPaths {
  const dir = path.join(SWARMS_DIR, name);
  return {
    dir,
    tasks: path.join(dir, 'tasks'),
    events: path.join(dir, 'events.jsonl'),
    inbox: path.join(dir, 'inbox.jsonl'),
    team: path.join(dir, 'team.json'),
    workspace: path.join(dir, 'workspace.json'),
    meta: path.join(dir, 'meta.json'),
    counter: path.join(dir, 'counter.json'),
    runs: path.join(dir, 'runs'),
    worktrees: path.join(dir, 'wt'),
    // Unix socket paths are capped near 100 bytes, so the socket lives in a short per-user dir, not the swarm dir.
    // A fixed dir (not TMPDIR) so every shell, hook and tool bridge agrees on the address.
    sock: path.join(socketDir(), `${name}.sock`),
    pid: path.join(dir, 'tm.pid'),
    lock: path.join(dir, 'tm.lock'),
    log: path.join(dir, 'tm.log'),
    mcpConfig: path.join(dir, 'mcp.json'),
    gmSettings: path.join(dir, 'gm-settings.json'),
    gmPrompt: path.join(dir, 'gm-prompt.md'),
  };
}

export function socketDir(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'u';
  return path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', `am-${uid}`);
}

export function ensureSwarmDirs(name: string): SwarmPaths {
  const p = swarmPaths(name);
  ensureDir(p.dir);
  ensureDir(p.tasks);
  ensureDir(p.runs);
  ensureDir(p.worktrees);
  ensureDir(socketDir());
  return p;
}
