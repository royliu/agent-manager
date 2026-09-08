import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/** Root for everything agent-manager owns. Overridable for tests. */
export const AM_HOME =
  process.env.AGENT_MANAGER_HOME ?? path.join(os.homedir(), '.agent-manager');

export const PROFILES_DIR = path.join(AM_HOME, 'profiles');
export const CONFIG_FILE = path.join(AM_HOME, 'profiles.json');
export const STATE_FILE = path.join(AM_HOME, 'state.json');
export const CACHE_DIR = path.join(AM_HOME, 'cache');

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function ensureAmHome(): void {
  ensureDir(AM_HOME);
  ensureDir(PROFILES_DIR);
  ensureDir(CACHE_DIR);
}

/** Where a managed profile's isolated config directory lives. */
export function profileHome(provider: string, name: string): string {
  return path.join(PROFILES_DIR, provider, name);
}

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Render an absolute path back to ~/... for display. */
export function tildify(p: string): string {
  const home = os.homedir();
  return p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p;
}
