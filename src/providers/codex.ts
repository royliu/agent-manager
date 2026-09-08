import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildEnv } from '../core/env.js';
import type { Identity, InstallInfo, LaunchSpec, Provider, UsageSnapshot, Window } from './types.js';
import { emptyUsage, makeTotals } from './types.js';
import { collectFiles, decodeJwtPayload, readJsonFile, readTail, tryVersion, which } from './util.js';

const DEFAULT_HOME = path.join(os.homedir(), '.codex');

interface AuthFile {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: { id_token?: string; account_id?: string };
  last_refresh?: string;
}

interface RateLimitWindow {
  used_percent?: number;
  window_minutes?: number;
  /** epoch seconds */
  resets_at?: number;
}

interface RateLimits {
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
  plan_type?: string;
  credits?: { has_credits?: boolean; unlimited?: boolean; balance?: string };
}

function windowLabel(minutes?: number): string {
  if (!minutes) return 'window';
  if (minutes % 10080 === 0) return `${minutes / 10080}w`;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function toWindow(w: RateLimitWindow | null | undefined): Window | undefined {
  if (!w || typeof w.used_percent !== 'number') return undefined;
  return {
    usedPercent: w.used_percent,
    windowMinutes: w.window_minutes ?? 0,
    resetsAt: w.resets_at ? w.resets_at * 1000 : undefined,
    label: windowLabel(w.window_minutes),
  };
}

export const codex: Provider = {
  id: 'codex',
  displayName: 'Codex CLI',
  short: 'codex',
  defaultHome: DEFAULT_HOME,
  configEnvVar: 'CODEX_HOME',
  isolationKind: 'env',

  async detectInstall(): Promise<InstallInfo> {
    const binPath = await which('codex');
    return {
      installed: Boolean(binPath),
      binPath,
      version: binPath ? await tryVersion('codex') : undefined,
      installHint: 'npm install -g @openai/codex',
    };
  },

  async readIdentity(home: string): Promise<Identity> {
    const auth = readJsonFile<AuthFile>(path.join(home, 'auth.json'));
    if (!auth) return { loggedIn: false };

    if (auth.auth_mode === 'apikey' || (auth.OPENAI_API_KEY && !auth.tokens)) {
      return { loggedIn: true, account: 'API key', billing: 'pay-per-token' };
    }

    const claims = auth.tokens?.id_token ? decodeJwtPayload(auth.tokens.id_token) : undefined;
    if (!claims) return { loggedIn: Boolean(auth.tokens), account: 'unknown' };

    const openai = claims['https://api.openai.com/auth'] as
      | { chatgpt_plan_type?: string; chatgpt_account_id?: string }
      | undefined;
    const plan = openai?.chatgpt_plan_type;

    return {
      loggedIn: true,
      account: typeof claims.email === 'string' ? claims.email : undefined,
      displayName: typeof claims.name === 'string' ? claims.name : undefined,
      plan: plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : undefined,
      billing: 'chatgpt_subscription',
    };
  },

  /**
   * Codex writes its authoritative quota numbers into every session rollout as
   * a `token_count` event, so the live percentages are available locally with
   * no API call. We read the newest rollout that carries one.
   */
  async readUsage(home: string): Promise<UsageSnapshot> {
    const sessions = path.join(home, 'sessions');
    if (!fs.existsSync(sessions)) return emptyUsage('no sessions yet');

    const now = Date.now();
    const weekAgo = now - 7 * 864e5;
    const dayAgo = now - 864e5;
    const files = collectFiles(sessions, (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'), {
      maxFiles: 800,
    });
    if (files.length === 0) return emptyUsage('no sessions yet');

    let windows: Window[] = [];
    let lastActivity = 0;
    const d24 = makeTotals();
    const d7 = makeTotals();

    for (const file of files) {
      let mtime: number;
      try {
        mtime = fs.statSync(file).mtimeMs;
      } catch {
        continue;
      }
      const inWeek = mtime >= weekAgo;
      // Once we have quota windows and are past the 7d token horizon, stop.
      if (!inWeek && windows.length > 0) break;

      // `total_token_usage` is cumulative per session, so the last event in a
      // file is that session's total — take it once rather than summing.
      let sessionTotals: {
        input_tokens?: number;
        cached_input_tokens?: number;
        cache_write_input_tokens?: number;
        output_tokens?: number;
      } | undefined;
      let sessionLimits: RateLimits | undefined;

      for (const line of readTail(file).split('\n')) {
        if (!line.includes('token_count')) continue;
        let rec: {
          payload?: {
            type?: string;
            info?: { total_token_usage?: typeof sessionTotals };
            rate_limits?: RateLimits;
          };
        };
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        if (rec.payload?.type !== 'token_count') continue;
        if (rec.payload.info?.total_token_usage) sessionTotals = rec.payload.info.total_token_usage;
        if (rec.payload.rate_limits) sessionLimits = rec.payload.rate_limits;
      }

      if (windows.length === 0 && sessionLimits) {
        windows = [toWindow(sessionLimits.primary), toWindow(sessionLimits.secondary)]
          .filter((w): w is Window => w !== undefined)
          .sort((a, b) => a.windowMinutes - b.windowMinutes);
        if (mtime > lastActivity) lastActivity = mtime;
      }

      if (inWeek && sessionTotals) {
        const inp = sessionTotals.input_tokens ?? 0;
        const cached = sessionTotals.cached_input_tokens ?? 0;
        const cw = sessionTotals.cache_write_input_tokens ?? 0;
        const out = sessionTotals.output_tokens ?? 0;
        // input_tokens includes the cached portion; split it out so we don't
        // price cached reads at the full input rate.
        const fresh = Math.max(0, inp - cached);

        d7.input += fresh; d7.output += out; d7.cacheRead += cached; d7.cacheWrite += cw;
        if (mtime >= dayAgo) {
          d24.input += fresh; d24.output += out; d24.cacheRead += cached; d24.cacheWrite += cw;
        }
        if (mtime > lastActivity) lastActivity = mtime;
      }
    }

    return {
      windows,
      tokens24h: d24,
      tokens7d: d7,
      lastActivity: lastActivity || undefined,
      source: 'local',
      note: windows.length === 0 ? 'no quota data cached yet' : undefined,
    };
  },

  launch(home: string, args: string[], opts = {}): LaunchSpec {
    return { command: 'codex', args, env: buildEnv('codex', home, process.env, opts) };
  },

  loginHint(home: string): string {
    return `CODEX_HOME=${home} codex login`;
  },
};
