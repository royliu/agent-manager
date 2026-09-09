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

// ---- config: `am config <group.key> <value>` ----

/** Public names, grouped by the thing they describe, and the schema key each maps to. */
export const CONFIG_KEYS: Array<{ key: string; internal: string; help: string }> = [
  { key: 'model.gm', internal: 'gmModel', help: "the General Manager's model; unset = the profile's own" },
  { key: 'model.tm', internal: 'tmModel', help: "the task manager's model; unset = the profile's own" },
  { key: 'model.agents', internal: 'agentModel', help: "task agents on Claude Code profiles; unset = each profile's own" },
  { key: 'model.codex-agents', internal: 'codexAgentModel', help: 'task agents on Codex profiles (Codex has its own model names)' },
  { key: 'profile.agents', internal: 'agentProfile', help: "profile new task agents are created on, any Claude Code or Codex profile; unset = the GM's" },
  { key: 'team.size', internal: 'agents', help: 'task agents a new GM starts with' },
  { key: 'team.notify', internal: 'notify', help: 'desktop notification when something needs you' },
  { key: 'gm.propose', internal: 'dispatch', help: 'true: the GM proposes tasks and waits for your go · false: clear single tasks start at once' },
  { key: 'gm.hud', internal: 'hud', help: "show the profile's own status line (claude-hud if installed) above the GM's line" },
  { key: 'tm.answers', internal: 'triage', help: 'which questions the task manager answers itself: most · notes (only what a note settles) · off (all go to the GM)' },
  { key: 'agent.permissions', internal: 'permissionMode', help: 'Claude Code permission mode for agents' },
  { key: 'agent.allow', internal: 'allow', help: 'tools agents may use without asking (a JSON list)' },
  { key: 'agent.compact-at', internal: 'compactAt', help: 'context % at which an agent checkpoints and gets a fresh session' },
  { key: 'agent.stall-after', internal: 'stallAfterMin', help: 'minutes without activity before an agent counts as stalled' },
  { key: 'agent.context-window', internal: 'contextWindow', help: 'assumed context window for models without a [1m] marker' },
  { key: 'agent.compact-env', internal: 'compactEnv', help: 'environment variable that asks the tool itself to compact at agent.compact-at' },
  { key: 'limits.budget-usd', internal: 'budgetUsd', help: 'list-price budget per agent per day; work pauses when it is reached' },
  { key: 'limits.quota-warn', internal: 'quotaWarnAt', help: 'subscription quota % at which you are warned' },
  { key: 'limits.quota-hold', internal: 'quotaHoldAt', help: 'subscription quota % at which new work is held' },
];
const MODEL_INTERNAL = new Set(['gmModel', 'tmModel', 'agentModel', 'codexAgentModel']);
const OLD_ALIASES: Record<string, string> = { triageModel: 'tmModel' };

/** Public value ↔ stored value where they differ: gm.propose is a yes/no over dispatch propose|auto. */
function toPublic(internal: string, v: unknown): unknown {
  return internal === 'dispatch' ? v === 'propose' : v;
}
function toInternal(internal: string, raw: string): unknown {
  if (internal === 'dispatch') {
    if (raw === 'true' || raw === 'propose') return 'propose';
    if (raw === 'false' || raw === 'auto') return 'auto';
    return raw;
  }
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (raw === 'true' || raw === 'false') return raw === 'true';
  if (raw.startsWith('[')) return JSON.parse(raw) as unknown;
  return raw;
}

/** Raw file contents with old key names mapped to their current ones. */
function rawSwarmConfig(): Record<string, unknown> {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(SWARM_CONFIG_FILE, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
  for (const [old, now] of Object.entries(OLD_ALIASES)) {
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

export function saveSwarmConfig(cfg: SwarmConfig): void {
  ensureAmHome();
  writeJsonAtomic(SWARM_CONFIG_FILE, cfg);
}

export interface ConfigEntry {
  key: string;
  internal: string;
  value: unknown;
  isModel: boolean;
  help: string;
}

/** Every setting by its public name, in group order, unset ones included. */
export function swarmConfigEntries(): ConfigEntry[] {
  const cfg = loadSwarmConfig() as unknown as Record<string, unknown>;
  return CONFIG_KEYS.map((k) => ({ key: k.key, internal: k.internal, value: toPublic(k.internal, cfg[k.internal]), isModel: MODEL_INTERNAL.has(k.internal), help: k.help }));
}

/** Accept a public key, an old `swarm.<camelCase>` key or a bare schema key, and say what it is called now. */
export function publicConfigKey(input: string): { key: string; internal: string; renamedFrom?: string } | undefined {
  const k = input.replace(/^swarm\./, '');
  const direct = CONFIG_KEYS.find((c) => c.key === k);
  if (direct) return { key: direct.key, internal: direct.internal };
  const internal = OLD_ALIASES[k] ?? k;
  const byInternal = CONFIG_KEYS.find((c) => c.internal === internal);
  if (byInternal) return { key: byInternal.key, internal: byInternal.internal, renamedFrom: input };
  return undefined;
}

/** Set one setting from a CLI string. "default" (or "profile" for a model) clears it. */
export function setSwarmConfigKey(publicKey: string, raw: string): { key: string; value: unknown; isModel: boolean; cfg: SwarmConfig } {
  const resolved = publicConfigKey(publicKey);
  if (!resolved) throw new Error(`unknown setting "${publicKey}"; known: ${CONFIG_KEYS.map((c) => c.key).join(', ')}`);
  const cfg = rawSwarmConfig();
  const isModel = MODEL_INTERNAL.has(resolved.internal);
  if (raw === 'default' || raw === '' || (isModel && raw === 'profile')) delete cfg[resolved.internal];
  else cfg[resolved.internal] = toInternal(resolved.internal, raw);
  const parsed = SwarmConfigSchema.safeParse(cfg);
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${resolved.key}: ${i.message}`).join('; '));
  saveSwarmConfig(parsed.data);
  return { key: resolved.key, value: toPublic(resolved.internal, (parsed.data as unknown as Record<string, unknown>)[resolved.internal]), isModel, cfg: parsed.data };
}
