import {
  findProfile, getActive, loadConfig, setActive, upsertProfile, type ProviderId,
} from '../core/config.js';
import { buildEnv, CONFIG_ENV_VAR, hazardVarsFor } from '../core/env.js';
import { shellQuote } from '../core/exec.js';
import { getProvider, readIdentitySafe } from '../providers/index.js';
import { bold, cyan, dim, green, yellow } from '../ui/format.js';
import { tildify } from '../core/paths.js';
import { resolveProfile } from './resolve.js';

export async function useCommand(
  name: string,
  opts: { provider?: ProviderId } = {},
): Promise<void> {
  const profile = resolveProfile(name, { provider: opts.provider, command: 'am profile use' });
  if (!profile) return;

  setActive(profile.provider, profile.name);

  const impl = getProvider(profile.provider);
  const identity = await readIdentitySafe(impl, profile.home);
  if (identity.loggedIn) {
    upsertProfile({ ...profile, account: identity.account, plan: identity.plan });
  }

  console.log('');
  console.log(
    `  ${green('✓')} ${impl.displayName} → ${bold(profile.name)}` +
      (identity.account ? dim(`  (${identity.account}${identity.plan ? `, ${identity.plan}` : ''})`) : ''),
  );
  if (!identity.loggedIn) {
    console.log(`    ${dim('not signed in yet:')} ${cyan(impl.loginHint(profile.home, profile.name))}`);
  }
  console.log('');
  if (process.env.AGENT_MANAGER_SHELL) {
    // The shell hook is active, so it has already exported the profile here.
    console.log(dim('  This shell now uses that profile.'));
    console.log('');
    return;
  }

  // Without the hook we can only record the preference — a child process
  // cannot change its parent shell. Say so loudly: silently doing nothing to
  // the current shell is the single most confusing thing this tool can do.
  console.log(
    `  ${yellow('!')} ${bold('This shell is unchanged')} — running \`${impl.short}\` here still uses ` +
      `whatever profile it used before.`,
  );
  console.log(`    ${dim('am profile use only records the preference; it cannot export into the parent shell.')}`);
  console.log('');
  const run = `am run ${profile.name}`;
  const evalEnv = `eval "$(am shell env ${profile.name})"`;
  const pad = Math.max(run.length, evalEnv.length) + 2;
  console.log(`  ${bold('Use the profile now:')}`);
  console.log(`    ${cyan(run)}${' '.repeat(pad - run.length)}${dim('no setup needed')}`);
  console.log(`    ${cyan(evalEnv)}${' '.repeat(pad - evalEnv.length)}${dim('switch just this shell')}`);
  console.log('');
  console.log(`  ${bold('Make `am profile use` work everywhere (once):')}`);
  console.log(`    ${cyan('am shell hook >> ~/.zshrc && exec zsh')}   ${dim('(am init offers this too)')}`);
  console.log('');
}

/**
 * Print `export`/`unset` lines for a profile so a shell function can eval them.
 * This is what makes `am use` affect the current shell rather than just our
 * own state file.
 */
export function envCommand(name: string, opts: { provider?: ProviderId } = {}): void {
  // Output is eval'd by the shell, so errors go to stderr as comments.
  const profile = loadConfig().profiles.find(
    (p) => p.name === name && (opts.provider ? p.provider === opts.provider : true),
  );
  if (!profile) {
    console.error(`# agent-manager: no profile named "${name}"`);
    process.exitCode = 1;
    return;
  }

  const impl = getProvider(profile.provider);
  if (impl.isolationKind === 'app-flag') {
    console.error(`# agent-manager: ${impl.displayName} profiles are launched, not exported`);
    process.exitCode = 1;
    return;
  }

  const env = buildEnv(profile.provider, profile.home, {});
  const varName = CONFIG_ENV_VAR[profile.provider];
  const keys = varName ? [varName] : ['HOME', 'XDG_CONFIG_HOME'];

  for (const key of keys) {
    const value = env[key];
    if (value) console.log(`export ${key}=${shellQuote(value)}`);
  }
  console.log(`export AGENT_MANAGER_PROFILE=${shellQuote(profile.name)}`);
  console.log(`export AGENT_MANAGER_PROFILE_HOME=${shellQuote(profile.home)}`);
  for (const hazard of hazardVarsFor(profile.provider)) {
    console.log(`unset ${hazard}`);
  }
}

export function whichCommand(): void {
  const { profiles } = loadConfig();
  if (profiles.length === 0) {
    console.log(dim('No profiles registered. Run `am init` or `am profile add`.'));
    return;
  }
  const seen = new Set<ProviderId>();
  console.log('');
  for (const p of profiles) {
    if (seen.has(p.provider)) continue;
    seen.add(p.provider);
    const active = getActive(p.provider);
    const impl = getProvider(p.provider);
    console.log(
      `  ${bold(impl.displayName.padEnd(16))} ${active ? cyan(active) : dim('none selected')}`,
    );
  }
  const shellProfile = process.env.AGENT_MANAGER_PROFILE;
  console.log('');
  console.log(
    shellProfile
      ? `  ${dim('this shell:')} ${cyan(shellProfile)} ${dim(`(${tildify(process.env.AGENT_MANAGER_PROFILE_HOME ?? '')})`)}`
      : `  ${dim('this shell: no profile exported — `am run` still applies the active one')}`,
  );
  console.log('');
}

export { findProfile };
