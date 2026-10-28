import type { Window } from '../providers/types.js';

/**
 * ═══ TASK AGENTS LEAVE A PROFILE THAT IS NEARLY SPENT ═══ (28 Oct 2026)
 *
 * The owner's ask: when the profile the agents run on passes 95% of its quota, keep their context and memory and move
 * them to another working profile. The task manager watches the profile(s) its task agents are on — not only its own —
 * and when the shortest or the weekly window reaches `limits.auto-switch` it picks another logged-in Claude Code
 * profile, asks each running agent for a checkpoint, and continues every task there. This file is the arithmetic of
 * that choice; the service does the moving.
 */

/** A target must be under this in every window it reports: a profile at 81% would be left again within the hour. */
export const SWITCH_TARGET_UNDER = 80;
/** No agent keeps running on a profile past this, checkpoint or not: the limit is a few minutes away. */
export const SWITCH_HARD_LINE = 98;
/** How long a running agent gets to write its own checkpoint before the task manager writes one and moves it. */
export const SWITCH_CHECKPOINT_WAIT_MS = 3 * 60_000;
const WEEK_MINUTES = 7 * 24 * 60;

/** What the task manager knows of one Claude Code profile's subscription, from the live usage poll. */
export interface ProfileUsage {
  profile: string;
  loggedIn: boolean;
  /** Billed per token (OpenRouter): no quota window, so never a target and never a trigger. */
  metered: boolean;
  windows: Window[];
}

/** A window whose reset has passed is spent from zero again, whatever the cached figure says. */
function current(w: Window, now: number): Window {
  return w.resetsAt !== undefined && w.resetsAt <= now ? { ...w, usedPercent: 0 } : w;
}

/** The windows that trigger a move: the shortest one (5h) and the weekly one(s). */
export function watchedWindows(windows: Window[], now: number): Window[] {
  const timed = windows.filter((w) => w.windowMinutes > 0);
  const shortest = Math.min(...timed.map((w) => w.windowMinutes));
  return timed.filter((w) => w.windowMinutes === shortest || w.windowMinutes === WEEK_MINUTES).map((w) => current(w, now));
}

/** The fullest watched window, which is the one that decides. */
export function peakWindow(windows: Window[], now: number): Window | undefined {
  return watchedWindows(windows, now).sort((a, b) => b.usedPercent - a.usedPercent)[0];
}

/** When a window resets, or, when the provider did not say, one window's length from now. */
export function resetOf(w: Window, now: number): number {
  return w.resetsAt ?? now + Math.max(w.windowMinutes, 60) * 60_000;
}

export type TargetChoice =
  | { to: string; peak: number }
  | { to?: undefined; why: string };

/**
 * The profile to move to: another logged-in Claude Code profile with a quota window, under `under` in every window it
 * reports, and not one the agents left this window (`leftUntil`: profile → when its window resets). Lowest peak wins.
 */
export function chooseTarget(from: string, usage: ProfileUsage[], opts: { now: number; under?: number; leftUntil?: Map<string, number> }): TargetChoice {
  const under = opts.under ?? SWITCH_TARGET_UNDER;
  const said: string[] = [];
  let best: { to: string; peak: number } | undefined;
  for (const u of usage) {
    if (u.profile === from) continue;
    if (!u.loggedIn) { said.push(`${u.profile} is not logged in`); continue; }
    if (u.metered) { said.push(`${u.profile} is billed per token`); continue; }
    if (!u.windows.length) { said.push(`${u.profile}'s usage could not be read`); continue; }
    const left = opts.leftUntil?.get(u.profile) ?? 0;
    if (left > opts.now) { said.push(`${u.profile} was left this window (resets ${new Date(left).toLocaleTimeString()})`); continue; }
    const windows = u.windows.map((w) => current(w, opts.now));
    const peak = Math.max(...windows.map((w) => w.usedPercent));
    if (peak >= under) {
      const w = windows.find((x) => x.usedPercent === peak)!;
      said.push(`${u.profile} is at ${Math.round(peak)}% of its ${w.label} window`);
      continue;
    }
    if (!best || peak < best.peak) best = { to: u.profile, peak };
  }
  if (best) return best;
  return { why: said.length ? said.join('; ') : 'there is no other Claude Code profile' };
}
