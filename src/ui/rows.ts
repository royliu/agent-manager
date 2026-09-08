import type { ProfileSnapshot, Snapshot } from '../core/snapshot.js';
import { tildify } from '../core/paths.js';
import { getProvider } from '../providers/index.js';

export interface WindowCell {
  label: string;
  usedPercent: number;
  resetsAt?: number;
}

export interface Row {
  name: string;
  provider: string;
  plan: string;
  account: string;
  loggedIn: boolean;
  active: boolean;
  windows: WindowCell[];
  tokens24h: number;
  tokens7d: number;
  cost24h: number;
  lastActivity?: number;
  note?: string;
  hazard?: string;
  home: string;
}

export function toRow(s: ProfileSnapshot): Row {
  const provider = getProvider(s.profile.provider);
  const critical = s.hazards.filter((h) => h.severity === 'critical');
  return {
    name: s.profile.name,
    provider: provider.short,
    plan: s.identity.plan ?? s.profile.plan ?? (s.identity.loggedIn ? '—' : 'not signed in'),
    account: s.identity.account ?? s.profile.account ?? '—',
    loggedIn: s.identity.loggedIn,
    active: s.active,
    windows: s.usage.windows.map((w) => ({
      label: w.label,
      usedPercent: w.usedPercent,
      resetsAt: w.resetsAt,
    })),
    tokens24h: s.usage.tokens24h?.total ?? 0,
    tokens7d: s.usage.tokens7d?.total ?? 0,
    cost24h: s.usage.estCost24h ?? 0,
    lastActivity: s.usage.lastActivity,
    note: s.usage.note,
    hazard: critical.length > 0 ? critical.map((h) => h.variable).join(', ') : undefined,
    home: tildify(s.profile.home),
  };
}

export function toRows(snapshot: Snapshot): Row[] {
  return snapshot.profiles.map(toRow);
}
