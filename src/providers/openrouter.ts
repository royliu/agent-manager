import type { Identity } from './types.js';

/**
 * OpenRouter, reached from Claude Code or Codex with an API key instead of a subscription login.
 * Claude Code speaks the Anthropic Messages API, which OpenRouter serves under /api; Codex speaks
 * the Responses API under /api/v1. Verified against Claude Code 2.1 and Codex 0.155.
 */
export const OPENROUTER_API = 'https://openrouter.ai/api/v1';
export const OPENROUTER_ANTHROPIC_BASE = 'https://openrouter.ai/api';
export const OPENROUTER_KEYS_URL = 'https://openrouter.ai/keys';

export interface OpenRouterModel {
  id: string;
  name: string;
  contextLength?: number;
  /** Takes tool calls, which both tools need for every edit and command. */
  tools: boolean;
  created: number;
}

export type KeyCheck =
  | { ok: true; label?: string; limitRemaining?: number | null }
  | { ok: false; rejected: boolean; error: string };

export function isOpenRouterUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return host === 'openrouter.ai' || host.endsWith('.openrouter.ai');
  } catch {
    return false;
  }
}

/** Enough of a key to tell two apart, never enough to use: "…a1b2". */
export function keyHint(key: string | undefined): string | undefined {
  const k = key?.trim();
  return k && k.length >= 8 ? `…${k.slice(-4)}` : undefined;
}

/**
 * What `am status`, `am doctor` and `am gm start` show for an OpenRouter profile. The account carries a
 * space on purpose: several profiles on one key (one per model) are not one subscription counted twice.
 */
export function openRouterIdentity(hint: string | undefined): Identity {
  return { loggedIn: true, account: hint ? `key ${hint}` : 'API key', plan: 'OpenRouter', billing: 'pay-per-token' };
}

/** The status line under an OpenRouter profile, which has no quota window to show; undefined for any other. */
export function openRouterNote(h: { backend: string; model?: string }): string | undefined {
  return h.backend === 'openrouter' ? `${h.model ?? 'no model set'} on OpenRouter, billed per token` : undefined;
}

async function getJson(url: string, key?: string, timeoutMs = 10_000): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'agent-manager', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      signal: controller.signal,
    });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/** The public model catalog, newest first; undefined when OpenRouter cannot be reached. */
export async function fetchOpenRouterModels(): Promise<OpenRouterModel[] | undefined> {
  try {
    const { status, body } = await getJson(`${OPENROUTER_API}/models`);
    const data = (body as { data?: unknown[] } | undefined)?.data;
    if (status !== 200 || !Array.isArray(data)) return undefined;
    return data
      .map((raw) => {
        const m = raw as { id?: string; name?: string; context_length?: number; created?: number; supported_parameters?: string[] };
        return {
          id: m.id ?? '',
          name: m.name ?? m.id ?? '',
          contextLength: m.context_length,
          tools: Array.isArray(m.supported_parameters) && m.supported_parameters.includes('tools'),
          created: m.created ?? 0,
        };
      })
      .filter((m) => m.id)
      .sort((a, b) => b.created - a.created);
  } catch {
    return undefined;
  }
}

/** Ask OpenRouter whether it knows the key. A network failure is not a verdict on the key. */
export async function checkOpenRouterKey(key: string): Promise<KeyCheck> {
  try {
    const { status, body } = await getJson(`${OPENROUTER_API}/key`, key);
    if (status === 200) {
      const data = (body as { data?: { label?: string; limit_remaining?: number | null } } | undefined)?.data;
      return { ok: true, label: data?.label, limitRemaining: data?.limit_remaining };
    }
    const message = (body as { error?: { message?: string } } | undefined)?.error?.message;
    return { ok: false, rejected: status === 401 || status === 403, error: message ? `${status} ${message}` : `OpenRouter returned ${status}` };
  } catch (error) {
    return { ok: false, rejected: false, error: error instanceof Error ? error.message : 'request failed' };
  }
}
