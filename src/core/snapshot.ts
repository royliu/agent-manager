import {
  getActive, loadConfig, upsertProfile, type Profile, type ProviderId,
} from './config.js';
import { detectHazards, type EnvHazard } from './env.js';
import { getProvider, PROVIDER_ORDER, readIdentitySafe, readUsageSafe } from '../providers/index.js';
import type { Identity, UsageSnapshot } from '../providers/types.js';
import { fetchLiveUsage } from '../usage/live.js';

export interface ProfileSnapshot {
  profile: Profile;
  identity: Identity;
  usage: UsageSnapshot;
  active: boolean;
  /** Hazards in the *current* shell that would affect this profile. */
  hazards: EnvHazard[];
}

export interface Snapshot {
  profiles: ProfileSnapshot[];
  takenAt: number;
}

export interface SnapshotOptions {
  provider?: ProviderId;
  /**
   * Additionally poll the provider's usage endpoint for authoritative quota
   * percentages. Off by default: it costs a network round trip and the
   * Anthropic endpoint rate-limits hard.
   */
  live?: boolean;
}

export async function takeSnapshot(opts: SnapshotOptions = {}): Promise<Snapshot> {
  const filter = opts.provider;
  const { profiles } = loadConfig();
  const selected = filter ? profiles.filter((p) => p.provider === filter) : profiles;

  const results = await Promise.all(
    selected.map(async (profile): Promise<ProfileSnapshot> => {
      const provider = getProvider(profile.provider);
      const [identity, usage] = await Promise.all([
        readIdentitySafe(provider, profile.home),
        readUsageSafe(provider, profile.home),
      ]);
      let merged = usage;
      if (opts.live) {
        const live = await fetchLiveUsage(profile);
        if (live && live.windows.length > 0) {
          merged = {
            ...usage,
            windows: live.windows,
            source: usage.tokens24h ? 'mixed' : 'live',
            note: live.stale ? (live.error ?? 'cached quota data') : undefined,
          };
        } else if (live?.error) {
          merged = { ...usage, note: `live quota unavailable: ${live.error}` };
        }
      }

      return {
        profile,
        identity,
        usage: merged,
        active: getActive(profile.provider) === profile.name,
        hazards: detectHazards(process.env, profile.provider),
      };
    }),
  );

  // Keep the registry honest. A profile can be signed into a different account
  // behind our back, and both `am ls` and the duplicate-subscription check read
  // these cached values.
  for (const result of results) {
    const { account, plan } = result.identity;
    if (!result.identity.loggedIn || (!account && !plan)) continue;
    if (account === result.profile.account && plan === result.profile.plan) continue;
    const refreshed = {
      ...result.profile,
      account: account ?? result.profile.account,
      plan: plan ?? result.profile.plan,
    };
    upsertProfile(refreshed);
    result.profile = refreshed;
  }

  results.sort((a, b) => {
    const byProvider =
      PROVIDER_ORDER.indexOf(a.profile.provider) - PROVIDER_ORDER.indexOf(b.profile.provider);
    return byProvider !== 0 ? byProvider : a.profile.name.localeCompare(b.profile.name);
  });

  return { profiles: results, takenAt: Date.now() };
}
