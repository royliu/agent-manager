import {
  loadConfig, loadState, saveConfig, saveState, type Profile, type ProviderId,
} from './config.js';
import { getProvider } from '../providers/index.js';

export interface Rename {
  provider: ProviderId;
  from: string;
  to: string;
}

/** `short`, then `<name>-<short>`, then `<name>-2`, `<name>-3`, … */
function pickName(name: string, short: string, reserved: Set<string>): string {
  for (const candidate of [short, `${name}-${short}`]) {
    if (!reserved.has(candidate)) return candidate;
  }
  for (let n = 2; ; n += 1) {
    const candidate = `${name}-${n}`;
    if (!reserved.has(candidate)) return candidate;
  }
}

/** The name and label `am init` used to stamp on every account it adopted. */
function isAdoptedDefault(p: Profile): boolean {
  return p.name === 'default' && !p.managed && p.label === 'Existing install';
}

/**
 * Names used to be unique per tool, so `am init` called every adopted account
 * "default" and `am run default` had nothing to go on. Names are unique across
 * tools now: rename those once — after their tool, the way init names them
 * today — and carry the active-profile state across with them.
 */
export function migrateProfileNames(): Rename[] {
  const cfg = loadConfig();
  const reserved = new Set(cfg.profiles.map((p) => p.name));
  const renames: Rename[] = [];

  const rename = (profile: Profile, to: string): void => {
    renames.push({ provider: profile.provider, from: profile.name, to });
    profile.name = to;
    reserved.add(to);
  };

  for (const profile of cfg.profiles) {
    if (!isAdoptedDefault(profile)) continue;
    const short = getProvider(profile.provider).short;
    if (!reserved.has(short)) rename(profile, short);
  }

  // Anything still sharing a name — hand-written or from an older build.
  // Whichever was registered first keeps it.
  const seen = new Set<string>();
  for (const profile of cfg.profiles) {
    if (!seen.has(profile.name)) {
      seen.add(profile.name);
      continue;
    }
    rename(profile, pickName(profile.name, getProvider(profile.provider).short, reserved));
    seen.add(profile.name);
  }

  if (renames.length === 0) return [];
  saveConfig(cfg);

  const state = loadState();
  let touched = false;
  for (const r of renames) {
    if (state.active[r.provider] === r.from) {
      state.active[r.provider] = r.to;
      touched = true;
    }
  }
  if (touched) saveState(state);

  return renames;
}
