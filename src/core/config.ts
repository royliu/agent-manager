import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { CONFIG_FILE, STATE_FILE, ensureAmHome, ensureDir } from './paths.js';

export const ProviderIdSchema = z.enum([
  'claude-code',
  'codex',
  'claude-desktop',
  'gemini',
  'cursor',
]);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const ProfileSchema = z.object({
  /** Unique across every provider — a name identifies one profile, full stop. */
  name: z.string().min(1).regex(/^[a-zA-Z0-9._-]+$/, 'use letters, digits, . _ -'),
  provider: ProviderIdSchema,
  /** Isolated config dir (CLAUDE_CONFIG_DIR / CODEX_HOME / --user-data-dir). */
  home: z.string().min(1),
  /** Human label, e.g. "Work — Max 20x". */
  label: z.string().optional(),
  /** Account email, cached from the profile's own credential store. */
  account: z.string().optional(),
  /** Plan hint, e.g. "pro", "max20x". Refreshed by status. */
  plan: z.string().optional(),
  /**
   * false => this profile points at the tool's own default directory
   * (~/.claude, ~/.codex). We never move or rewrite those.
   */
  managed: z.boolean().default(true),
  createdAt: z.string(),
});
export type Profile = z.infer<typeof ProfileSchema>;

const ConfigSchema = z.object({
  version: z.literal(1).default(1),
  profiles: z.array(ProfileSchema).default([]),
});
export type Config = z.infer<typeof ConfigSchema>;

const StateSchema = z.object({
  version: z.literal(1).default(1),
  /** provider -> active profile name */
  active: z.record(z.string()).default({}),
});
export type State = z.infer<typeof StateSchema>;

function readJson<T>(file: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, fallback: T): T {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : fallback;
  } catch {
    return fallback;
  }
}

/** Atomic write so a crash mid-write can't corrupt the registry. */
function writeJson(file: string, data: unknown): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function loadConfig(): Config {
  return readJson(CONFIG_FILE, ConfigSchema, { version: 1, profiles: [] });
}

export function saveConfig(cfg: Config): void {
  ensureAmHome();
  writeJson(CONFIG_FILE, cfg);
}

export function loadState(): State {
  return readJson(STATE_FILE, StateSchema, { version: 1, active: {} });
}

export function saveState(state: State): void {
  ensureAmHome();
  writeJson(STATE_FILE, state);
}

export function findProfile(name: string, provider?: ProviderId): Profile | undefined {
  const { profiles } = loadConfig();
  return profiles.find(
    (p) => p.name === name && (provider ? p.provider === provider : true),
  );
}

/** Names are unique across tools, so a name alone identifies a profile. */
export function profileByName(name: string): Profile | undefined {
  return loadConfig().profiles.find((p) => p.name === name);
}

/**
 * First free name in the `base`, `base-2`, `base-3` series. `taken` lets a
 * caller reserve names it is about to create but has not written yet.
 */
export function uniqueProfileName(base: string, taken: Iterable<string> = []): string {
  const used = new Set([...loadConfig().profiles.map((p) => p.name), ...taken]);
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

export function profilesFor(provider: ProviderId): Profile[] {
  return loadConfig().profiles.filter((p) => p.provider === provider);
}

export function upsertProfile(profile: Profile): void {
  const cfg = loadConfig();
  const i = cfg.profiles.findIndex((p) => p.name === profile.name);
  if (i >= 0) cfg.profiles[i] = profile;
  else cfg.profiles.push(profile);
  saveConfig(cfg);
}

export function removeProfile(name: string, provider: ProviderId): boolean {
  const cfg = loadConfig();
  const before = cfg.profiles.length;
  cfg.profiles = cfg.profiles.filter(
    (p) => !(p.name === name && p.provider === provider),
  );
  if (cfg.profiles.length === before) return false;
  saveConfig(cfg);

  const state = loadState();
  if (state.active[provider] === name) {
    delete state.active[provider];
    saveState(state);
  }
  return true;
}

export function getActive(provider: ProviderId): string | undefined {
  return loadState().active[provider];
}

export function setActive(provider: ProviderId, name: string | undefined): void {
  const state = loadState();
  if (name === undefined) delete state.active[provider];
  else state.active[provider] = name;
  saveState(state);
}
