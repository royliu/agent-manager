import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ensureAmHome } from '../core/paths.js';
import { SwarmConfigSchema, SwarmMetaSchema, type SwarmConfig, type SwarmMeta } from './model.js';
import { SWARMS_FILE, SWARM_CONFIG_FILE } from './paths.js';
import { readJson, writeJsonAtomic } from './store.js';

const RegistrySchema = z.object({
  version: z.literal(1).default(1),
  swarms: z.array(SwarmMetaSchema).default([]),
});

export function realDir(dir: string): string {
  try {
    return fs.realpathSync(path.resolve(dir));
  } catch {
    return path.resolve(dir);
  }
}

export function listSwarms(): SwarmMeta[] {
  return readJson(SWARMS_FILE, RegistrySchema)?.swarms ?? [];
}

export function findSwarm(name: string): SwarmMeta | undefined {
  return listSwarms().find((s) => s.name === name);
}

export function swarmForDir(dir: string): SwarmMeta | undefined {
  const real = realDir(dir);
  return listSwarms().find((s) => realDir(s.dir) === real);
}

/** Name from the argument, else the swarm registered for the current folder. */
export function resolveSwarmName(name?: string, cwd = process.cwd()): SwarmMeta | undefined {
  if (name) return findSwarm(name);
  return swarmForDir(cwd);
}

export function saveSwarm(meta: SwarmMeta): void {
  ensureAmHome();
  const swarms = listSwarms().filter((s) => s.name !== meta.name);
  swarms.push(meta);
  writeJsonAtomic(SWARMS_FILE, { version: 1, swarms });
}

export function removeSwarm(name: string): void {
  writeJsonAtomic(SWARMS_FILE, { version: 1, swarms: listSwarms().filter((s) => s.name !== name) });
}

export const SWARM_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

// ---- config: `am config swarm.<key> <value>` ----

const CONFIG_ALIASES: Record<string, string> = { triageModel: 'tmModel' };
const MODEL_KEYS = ['gmModel', 'tmModel', 'agentModel', 'codexAgentModel'];

/** Raw file contents with old key names mapped to their current ones. */
function rawSwarmConfig(): Record<string, unknown> {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(SWARM_CONFIG_FILE, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
  for (const [old, now] of Object.entries(CONFIG_ALIASES)) {
    if (old in raw) {
      if (!(now in raw)) raw[now] = raw[old];
      delete raw[old];
    }
  }
  return raw;
}

export function loadSwarmConfig(): SwarmConfig {
  const parsed = SwarmConfigSchema.safeParse(rawSwarmConfig());
  return parsed.success ? parsed.data : SwarmConfigSchema.parse({});
}

/** Every setting with its current value, unset optional ones included, for `am config`. */
export function swarmConfigEntries(): Array<{ key: string; value: unknown; isModel: boolean; set: boolean }> {
  const raw = rawSwarmConfig();
  const cfg = loadSwarmConfig() as unknown as Record<string, unknown>;
  return Object.keys(SwarmConfigSchema.shape).map((key) => ({ key, value: cfg[key], isModel: MODEL_KEYS.includes(key), set: key in raw }));
}

export function saveSwarmConfig(cfg: SwarmConfig): void {
  ensureAmHome();
  writeJsonAtomic(SWARM_CONFIG_FILE, cfg);
}

/** Parse a CLI string into the type the key expects. */
export function setSwarmConfigKey(keyArg: string, raw: string): SwarmConfig {
  const key = CONFIG_ALIASES[keyArg] ?? keyArg;
  const cfg = rawSwarmConfig();
  if (!(key in SwarmConfigSchema.shape)) {
    throw new Error(`unknown setting "swarm.${key}"; known: ${Object.keys(SwarmConfigSchema.shape).join(', ')}`);
  }
  // "default" (or "profile" for a model key) clears the setting, so the built-in or profile default applies again.
  if (raw === 'default' || raw === '' || (MODEL_KEYS.includes(key) && raw === 'profile')) {
    delete cfg[key];
  } else {
    let value: unknown = raw;
    if (/^-?\d+(\.\d+)?$/.test(raw)) value = Number(raw);
    else if (raw === 'true' || raw === 'false') value = raw === 'true';
    else if (raw.startsWith('[')) value = JSON.parse(raw);
    cfg[key] = value;
  }
  const parsed = SwarmConfigSchema.safeParse(cfg);
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => i.message).join('; '));
  saveSwarmConfig(parsed.data);
  return parsed.data;
}
