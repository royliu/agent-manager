import {
  getActive, loadConfig, profileByName, type Profile, type ProviderId,
} from '../core/config.js';
import { getProvider, PROVIDER_ORDER } from '../providers/index.js';
import { cyan, dim, listPhrase, red } from '../ui/format.js';
import { closePrompts, isInteractive, select, type Choice } from '../ui/prompt.js';

export interface ResolveOptions {
  /** Optional assertion: fail if the name belongs to a different tool. */
  provider?: ProviderId;
  /** The command being run, e.g. "am run" — used to print a copyable fix. */
  command: string;
  /** Ask when the answer is genuinely open. Off for machine-read output. */
  prompt?: boolean;
}

function reportUnknown(name: string): void {
  console.error(`${red('✗')} No profile named "${name}".`);
  const known = [...loadConfig().profiles].sort(
    (a, b) => PROVIDER_ORDER.indexOf(a.provider) - PROVIDER_ORDER.indexOf(b.provider),
  );
  if (known.length === 0) {
    console.error(`  ${dim('None registered yet —')} ${cyan('am init')}`);
    return;
  }
  console.error(
    `  ${dim('Registered:')} ` +
      known.map((k) => `${k.name} ${dim(`(${getProvider(k.provider).short})`)}`).join(', '),
  );
}

/**
 * Look up a profile by name. Names are unique across tools, so this never has
 * to guess — `--provider` is only an assertion that the caller got the right
 * tool.
 */
export function resolveProfile(name: string, opts: ResolveOptions): Profile | undefined {
  const profile = profileByName(name);
  if (!profile) {
    reportUnknown(name);
    process.exitCode = 1;
    return undefined;
  }
  if (opts.provider && profile.provider !== opts.provider) {
    console.error(
      `${red('✗')} "${name}" is a ${getProvider(profile.provider).displayName} profile, ` +
        `not ${getProvider(opts.provider).displayName}.`,
    );
    console.error(`  ${dim('Drop --provider:')} ${cyan(`${opts.command} ${name}`)}`);
    process.exitCode = 1;
    return undefined;
  }
  return profile;
}

/**
 * No name given: use the active profile. Each tool has its own active one, so
 * with several tools registered there is a real question to ask.
 */
export async function resolveActiveProfile(opts: ResolveOptions): Promise<Profile | undefined> {
  const { profiles } = loadConfig();
  const pool = opts.provider ? profiles.filter((p) => p.provider === opts.provider) : profiles;

  if (pool.length === 0) {
    console.error(
      opts.provider
        ? `${red('✗')} No profiles registered for ${getProvider(opts.provider).displayName}. ` +
            `Run ${cyan('am add')}.`
        : `${red('✗')} No profiles registered. Run ${cyan('am init')}.`,
    );
    process.exitCode = 1;
    return undefined;
  }

  const actives: Profile[] = [];
  for (const id of PROVIDER_ORDER) {
    const active = getActive(id);
    const hit = pool.find((p) => p.provider === id && p.name === active);
    if (hit) actives.push(hit);
  }

  if (actives.length === 1) return actives[0]!;
  if (actives.length === 0) {
    console.error(
      `${red('✗')} No active profile yet — name one: ${cyan(`${opts.command} <profile>`)}` +
        `${dim(', or set one with')} ${cyan('am use <profile>')}`,
    );
    process.exitCode = 1;
    return undefined;
  }

  if (opts.prompt !== false && isInteractive()) {
    const choices: Choice<Profile>[] = actives.map((p) => ({
      value: p,
      label: `${p.name}`,
      hint: [getProvider(p.provider).displayName, p.account, p.plan].filter(Boolean).join(' · '),
    }));
    console.log('');
    const chosen = await select('Which profile?', choices);
    // The caller hands the terminal to a child process next, so let go of stdin.
    closePrompts();
    console.log(`  ${dim('next time:')} ${cyan(`${opts.command} ${chosen.name}`)}`);
    console.log('');
    return chosen;
  }

  console.error(
    `${red('✗')} ${listPhrase(actives.map((p) => getProvider(p.provider).displayName))} ` +
      `each have an active profile — name the one you want:`,
  );
  for (const p of actives) {
    console.error(`    ${cyan(`${opts.command} ${p.name}`)}`);
  }
  process.exitCode = 1;
  return undefined;
}
