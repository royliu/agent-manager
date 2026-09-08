import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CACHE_DIR, ensureDir } from '../core/paths.js';
import type { Profile } from '../core/config.js';
import type { Window } from '../providers/types.js';

const pexec = promisify(execFile);

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
/**
 * Anthropic's OAuth usage endpoint rate-limits aggressively — polling it at UI
 * refresh rates gets you 429s within a few calls. So we cache hard and back off
 * hard, and the dashboard treats live data as a bonus on top of local parsing.
 */
const FRESH_MS = 5 * 60_000;
const MIN_BACKOFF_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;

interface CacheEntry {
  fetchedAt: number;
  windows: Window[];
  /** Epoch ms before which we must not call the endpoint again. */
  blockedUntil?: number;
  lastError?: string;
}

function cacheFile(profile: Profile): string {
  ensureDir(CACHE_DIR);
  return path.join(CACHE_DIR, `live-${profile.provider}-${profile.name}.json`);
}

function readCache(profile: Profile): CacheEntry | undefined {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(profile), 'utf8')) as CacheEntry;
  } catch {
    return undefined;
  }
}

function writeCache(profile: Profile, entry: CacheEntry): void {
  try {
    fs.writeFileSync(cacheFile(profile), JSON.stringify(entry), { mode: 0o600 });
  } catch {
    /* cache is best-effort */
  }
}

/**
 * Locate the profile's OAuth access token. Claude Code stores it in the macOS
 * Keychain for the default install and in a file inside the config directory
 * when CLAUDE_CONFIG_DIR relocates it. The token is only ever passed to
 * Anthropic and is never logged or persisted by us.
 */
async function readAccessToken(profile: Profile): Promise<string | undefined> {
  const fromFile = (() => {
    try {
      const raw = fs.readFileSync(path.join(profile.home, '.credentials.json'), 'utf8');
      const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } };
      return parsed.claudeAiOauth?.accessToken;
    } catch {
      return undefined;
    }
  })();
  if (fromFile) return fromFile;

  if (process.platform !== 'darwin' || profile.managed) return undefined;
  try {
    const { stdout } = await pexec(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', os.userInfo().username, '-w'],
      { timeout: 5000 },
    );
    const parsed = JSON.parse(stdout.trim()) as { claudeAiOauth?: { accessToken?: string } };
    return parsed.claudeAiOauth?.accessToken;
  } catch {
    return undefined;
  }
}

function labelFor(key: string): string {
  if (/five_?hour/i.test(key)) return '5h';
  if (/seven_?day|week/i.test(key)) return '7d';
  if (/month/i.test(key)) return '30d';
  if (/opus/i.test(key)) return 'opus';
  return key.replace(/_/g, ' ');
}

function minutesFor(label: string): number {
  if (label === '5h') return 300;
  if (label === '7d') return 10080;
  if (label === '30d') return 43200;
  return 0;
}

/**
 * The payload shape is not part of any published contract, so parse tolerantly:
 * accept any object that carries a percentage-ish number, under any of the
 * field names the endpoint has been observed to use.
 */
function parseWindows(payload: unknown): Window[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const out: Window[] = [];

  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const v = value as Record<string, unknown>;
    const raw =
      typeof v.utilization === 'number'
        ? v.utilization
        : typeof v.used_percent === 'number'
          ? v.used_percent
          : typeof v.percent_used === 'number'
            ? v.percent_used
            : undefined;
    if (raw === undefined) continue;

    // Some fields report 0–1, others 0–100.
    const usedPercent = raw <= 1 ? raw * 100 : raw;
    const resetsRaw = v.resets_at ?? v.reset_at ?? v.resets_at_utc;
    let resetsAt: number | undefined;
    if (typeof resetsRaw === 'number') resetsAt = resetsRaw > 1e12 ? resetsRaw : resetsRaw * 1000;
    else if (typeof resetsRaw === 'string') {
      const t = Date.parse(resetsRaw);
      if (Number.isFinite(t)) resetsAt = t;
    }

    const label = labelFor(key);
    const windowMinutes = minutesFor(label);
    // The payload also carries non-quota objects that happen to have numeric
    // fields, so keep only entries we recognise as a window or that carry a
    // reset time. Anything else is not something we can honestly display.
    if (windowMinutes === 0 && resetsAt === undefined) continue;
    out.push({ usedPercent, windowMinutes, resetsAt, label });
  }

  return out.sort((a, b) => a.windowMinutes - b.windowMinutes);
}

export interface LiveResult {
  windows: Window[];
  fetchedAt: number;
  stale: boolean;
  error?: string;
}

/**
 * Fetch quota utilisation for a Claude Code profile. Returns cached data when
 * it is fresh or when we are backing off, so callers can poll freely.
 */
export async function fetchLiveUsage(profile: Profile): Promise<LiveResult | undefined> {
  if (profile.provider !== 'claude-code') return undefined;

  const now = Date.now();
  const cached = readCache(profile);

  if (cached && now - cached.fetchedAt < FRESH_MS && cached.windows.length > 0) {
    return { windows: cached.windows, fetchedAt: cached.fetchedAt, stale: false };
  }
  if (cached?.blockedUntil && now < cached.blockedUntil) {
    return {
      windows: cached.windows,
      fetchedAt: cached.fetchedAt,
      stale: true,
      error: cached.lastError ?? 'rate limited; using cached data',
    };
  }

  const token = await readAccessToken(profile);
  if (!token) {
    return cached
      ? { windows: cached.windows, fetchedAt: cached.fetchedAt, stale: true, error: 'no token' }
      : { windows: [], fetchedAt: 0, stale: true, error: 'could not read this profile’s login' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'agent-manager',
      },
      signal: controller.signal,
    });

    if (res.status === 429) {
      const previous = cached?.blockedUntil ? cached.blockedUntil - cached.fetchedAt : 0;
      const backoff = Math.min(MAX_BACKOFF_MS, Math.max(MIN_BACKOFF_MS, previous * 2));
      const entry: CacheEntry = {
        fetchedAt: cached?.fetchedAt ?? 0,
        windows: cached?.windows ?? [],
        blockedUntil: now + backoff,
        lastError: `rate limited; retrying in ${Math.round(backoff / 60000)}m`,
      };
      writeCache(profile, entry);
      return { windows: entry.windows, fetchedAt: entry.fetchedAt, stale: true, error: entry.lastError };
    }

    if (!res.ok) {
      const entry: CacheEntry = {
        fetchedAt: cached?.fetchedAt ?? 0,
        windows: cached?.windows ?? [],
        blockedUntil: now + MIN_BACKOFF_MS,
        lastError: `usage endpoint returned ${res.status}`,
      };
      writeCache(profile, entry);
      return { windows: entry.windows, fetchedAt: entry.fetchedAt, stale: true, error: entry.lastError };
    }

    const windows = parseWindows(await res.json());
    const entry: CacheEntry = { fetchedAt: now, windows };
    writeCache(profile, entry);
    return { windows, fetchedAt: now, stale: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'request failed';
    return {
      windows: cached?.windows ?? [],
      fetchedAt: cached?.fetchedAt ?? 0,
      stale: true,
      error: message,
    };
  } finally {
    clearTimeout(timer);
  }
}
