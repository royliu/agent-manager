import fs from 'node:fs';
import path from 'node:path';
import type { Profile } from '../core/config.js';
import type { Agent, SwarmConfig, SwarmMeta } from './model.js';

/**
 * Which model each group runs on. Three groups the owner can set, plus a fourth key for
 * task agents that live on a Codex profile (Codex has its own model names).
 *
 * Resolution order, per group:
 *   1. set for this GM         (am start … --gm-model / --tm-model / --agent-model, or Friday's models_set)
 *   2. set for every GM        (am config swarm.gmModel | tmModel | agentModel | codexAgentModel)
 *   3. the profile's own model (Claude Code settings.json "model", Codex config.toml "model")
 *   4. the tool's default
 * Only 1 and 2 are passed on the command line; for 3 and 4 the tool applies its own default.
 */
export type ModelRole = 'gm' | 'tm' | 'agent' | 'codexAgent';
export const MODEL_ROLES: ModelRole[] = ['gm', 'tm', 'agent', 'codexAgent'];
export const ROLE_LABEL: Record<ModelRole, string> = {
  gm: 'general manager',
  tm: 'task manager',
  agent: 'task agents',
  codexAgent: 'task agents on Codex',
};

export type ModelSource = 'this GM' | 'am config' | 'profile' | 'tool default';
export interface ModelChoice {
  model?: string;
  source: ModelSource;
}
export interface ModelsView {
  gm: ModelChoice;
  tm: ModelChoice;
  agent: ModelChoice;
  /** Present only when at least one task agent runs on a Codex profile. */
  codexAgent?: ModelChoice;
}

/** The model a profile's tool would pick on its own. */
export function profileDefaultModel(profile: Profile | undefined): string | undefined {
  if (!profile) return undefined;
  try {
    if (profile.provider === 'codex') {
      const toml = fs.readFileSync(path.join(profile.home, 'config.toml'), 'utf8');
      const m = /^\s*model\s*=\s*"([^"]+)"/m.exec(toml);
      return m?.[1];
    }
    return (JSON.parse(fs.readFileSync(path.join(profile.home, 'settings.json'), 'utf8')) as { model?: string }).model || undefined;
  } catch {
    return undefined;
  }
}

export function resolveModel(role: ModelRole, meta: SwarmMeta, cfg: SwarmConfig, profile: Profile | undefined): ModelChoice {
  const own = meta.models?.[role];
  if (own) return { model: own, source: 'this GM' };
  const global = (cfg as Record<string, unknown>)[`${role}Model`];
  if (typeof global === 'string' && global) return { model: global, source: 'am config' };
  const def = profileDefaultModel(profile);
  return def ? { model: def, source: 'profile' } : { source: 'tool default' };
}

/** What goes on the command line: an explicit choice only; otherwise the tool applies the profile's own default. */
export function modelArg(c: ModelChoice): string | undefined {
  return c.source === 'this GM' || c.source === 'am config' ? c.model : undefined;
}

export function describeModel(c: ModelChoice): string {
  if (!c.model) return 'the tool default';
  return c.source === 'profile' ? `${c.model} (profile default)` : `${c.model} (set ${c.source === 'this GM' ? 'for this GM' : 'with am config'})`;
}

/** Which role's setting a task agent follows. */
export function agentRole(a: Pick<Agent, 'provider'>): ModelRole {
  return a.provider === 'codex' ? 'codexAgent' : 'agent';
}

/** 1M-context variants are marked "[1m]" in Claude Code model names. */
export function windowFor(model: string | undefined, fallback: number): number {
  return model && /\[1m\]/i.test(model) ? 1_000_000 : fallback;
}

export function modelsView(meta: SwarmMeta, cfg: SwarmConfig, gmProfile: Profile | undefined, team: Agent[], profileOf: (name: string) => Profile | undefined): ModelsView {
  const claude = team.find((a) => a.provider !== 'codex');
  const codex = team.find((a) => a.provider === 'codex');
  return {
    gm: resolveModel('gm', meta, cfg, gmProfile),
    tm: resolveModel('tm', meta, cfg, gmProfile),
    agent: resolveModel('agent', meta, cfg, claude ? profileOf(claude.profile) : gmProfile),
    codexAgent: codex ? resolveModel('codexAgent', meta, cfg, profileOf(codex.profile)) : undefined,
  };
}

/** One line per group, for `am start`, `am agent ls` and the GM's team list. */
export function modelsLines(v: ModelsView, gmName: string): string[] {
  const out = [
    `${gmName} runs on ${describeModel(v.gm)}`,
    `task manager on ${describeModel(v.tm)}`,
    `task agents on ${describeModel(v.agent)}`,
  ];
  if (v.codexAgent) out.push(`task agents on Codex on ${describeModel(v.codexAgent)}`);
  return out;
}

/** Turn a user-facing value into a stored one: empty, "default" or "profile" clears the setting. */
export function normalizeModelValue(raw: string | undefined): string | undefined {
  const v = (raw ?? '').trim();
  if (!v || v === 'default' || v === 'profile') return undefined;
  return v;
}
