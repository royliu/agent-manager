import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildEnv } from '../core/env.js';
import { estimateCost } from '../usage/pricing.js';
import type { Identity, InstallInfo, LaunchSpec, Provider, UsageSnapshot } from './types.js';
import { emptyUsage, makeTotals } from './types.js';
import { collectFiles, readJsonFile, readTail, tryVersion, which } from './util.js';

const DEFAULT_HOME = path.join(os.homedir(), '.claude');

/**
 * Claude Code keeps its settings blob next to the config dir for the default
 * install (~/.claude.json), but *inside* the directory when CLAUDE_CONFIG_DIR
 * relocates it. Verified empirically against Claude Code 2.x.
 */
function configJsonPath(home: string): string {
  const inside = path.join(home, '.claude.json');
  if (fs.existsSync(inside)) return inside;
  if (path.resolve(home) === path.resolve(DEFAULT_HOME)) {
    return path.join(os.homedir(), '.claude.json');
  }
  return inside;
}

/** default_claude_max_20x -> "Max 20x" */
function planLabel(tier?: string | null, orgType?: string | null): string | undefined {
  const raw = tier ?? undefined;
  if (raw) {
    const m = /max_(\d+)x/.exec(raw);
    if (m) return `Max ${m[1]}x`;
    if (/pro/.test(raw)) return 'Pro';
    if (/team/.test(raw)) return 'Team';
    if (/enterprise/.test(raw)) return 'Enterprise';
    if (/free/.test(raw)) return 'Free';
    return raw.replace(/^default_claude_/, '').replace(/_/g, ' ');
  }
  if (orgType === 'claude_max') return 'Max';
  if (orgType === 'claude_pro') return 'Pro';
  return undefined;
}

interface OAuthAccount {
  emailAddress?: string;
  displayName?: string;
  organizationName?: string;
  organizationRateLimitTier?: string | null;
  userRateLimitTier?: string | null;
  organizationType?: string | null;
  billingType?: string | null;
}

interface UsageRecord {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export const claudeCode: Provider = {
  id: 'claude-code',
  displayName: 'Claude Code',
  short: 'claude',
  defaultHome: DEFAULT_HOME,
  configEnvVar: 'CLAUDE_CONFIG_DIR',
  isolationKind: 'env',

  async detectInstall(): Promise<InstallInfo> {
    const binPath = await which('claude');
    return {
      installed: Boolean(binPath),
      binPath,
      version: binPath ? await tryVersion('claude') : undefined,
      installHint: 'curl -fsSL https://claude.ai/install.sh | bash',
    };
  },

  async readIdentity(home: string): Promise<Identity> {
    const cfg = readJsonFile<{ oauthAccount?: OAuthAccount }>(configJsonPath(home));
    const oa = cfg?.oauthAccount;
    if (!oa?.emailAddress) return { loggedIn: false };
    return {
      loggedIn: true,
      account: oa.emailAddress,
      displayName: oa.displayName,
      organization: oa.organizationName,
      plan: planLabel(oa.organizationRateLimitTier ?? oa.userRateLimitTier, oa.organizationType),
      billing: oa.billingType ?? undefined,
    };
  },

  async readUsage(home: string): Promise<UsageSnapshot> {
    const projects = path.join(home, 'projects');
    if (!fs.existsSync(projects)) return emptyUsage('no transcripts yet');

    const now = Date.now();
    const weekAgo = now - 7 * 864e5;
    const dayAgo = now - 864e5;
    const files = collectFiles(projects, (n) => n.endsWith('.jsonl'), {
      newerThan: weekAgo,
      maxFiles: 1500,
    });
    if (files.length === 0) return emptyUsage('no activity in the last 7 days');

    const d24 = makeTotals();
    const d7 = makeTotals();
    const seen = new Set<string>();
    let lastActivity = 0;
    const costByModel = new Map<string, ReturnType<typeof makeTotals>>();

    for (const file of files) {
      for (const line of readTail(file).split('\n')) {
        if (line.length < 2 || !line.includes('"usage"')) continue;
        let rec: {
          type?: string;
          timestamp?: string;
          requestId?: string;
          message?: { id?: string; model?: string; usage?: UsageRecord };
        };
        try {
          rec = JSON.parse(line);
        } catch {
          continue; // tail-truncated first line, or a partial write
        }
        const usage = rec.message?.usage;
        if (rec.type !== 'assistant' || !usage) continue;

        // One API response can appear on several lines; dedupe on the pair
        // that uniquely identifies a billed request.
        const key = `${rec.requestId ?? ''}|${rec.message?.id ?? ''}`;
        if (key !== '|' && seen.has(key)) continue;
        seen.add(key);

        const ts = rec.timestamp ? Date.parse(rec.timestamp) : NaN;
        if (!Number.isFinite(ts) || ts < weekAgo) continue;
        if (ts > lastActivity) lastActivity = ts;

        const inp = usage.input_tokens ?? 0;
        const out = usage.output_tokens ?? 0;
        const cr = usage.cache_read_input_tokens ?? 0;
        const cw = usage.cache_creation_input_tokens ?? 0;

        d7.input += inp; d7.output += out; d7.cacheRead += cr; d7.cacheWrite += cw;
        if (ts >= dayAgo) {
          d24.input += inp; d24.output += out; d24.cacheRead += cr; d24.cacheWrite += cw;
          const model = rec.message?.model ?? 'unknown';
          const acc = costByModel.get(model) ?? makeTotals();
          acc.input += inp; acc.output += out; acc.cacheRead += cr; acc.cacheWrite += cw;
          costByModel.set(model, acc);
        }
      }
    }

    let estCost24h = 0;
    for (const [model, t] of costByModel) estCost24h += estimateCost(model, t);

    return {
      windows: [],
      tokens24h: d24,
      tokens7d: d7,
      estCost24h,
      lastActivity: lastActivity || undefined,
      source: 'local',
      note: 'quota % needs --live',
    };
  },

  launch(home: string, args: string[], opts = {}): LaunchSpec {
    return {
      command: 'claude',
      args,
      env: buildEnv('claude-code', home, process.env, opts),
    };
  },

  loginHint(home: string): string {
    return `CLAUDE_CONFIG_DIR=${home} claude   # then run /login`;
  },
};
