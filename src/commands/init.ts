import fs from 'node:fs';
import {
  loadConfig, setActive, uniqueProfileName, upsertProfile, type Profile, type ProviderId,
} from '../core/config.js';
import { detectHazards } from '../core/env.js';
import { accountKey } from '../core/duplicates.js';
import { ensureAmHome, tildify } from '../core/paths.js';
import { getProvider, PROVIDER_ORDER, readIdentitySafe } from '../providers/index.js';
import { bold, cyan, dim, green, red, yellow } from '../ui/format.js';
import { closePrompts, confirm, isInteractive } from '../ui/prompt.js';

/**
 * First-run setup. Adopts the accounts you are *already* signed into as
 * profiles named after their tool ("claude", "codex", …), pointing at the
 * tool's own directory. Names are unique across tools, so every adopted
 * account gets a name you can hand straight to `am run`. We register these by
 * reference and never move or rewrite them — an existing working install must
 * keep working exactly as before.
 */
export async function initCommand(opts: { yes?: boolean } = {}): Promise<void> {
  ensureAmHome();
  console.log('');
  console.log(bold('  agent-manager setup'));
  console.log(dim('  Registering the accounts you already have, without touching them.'));
  console.log('');

  const existing = loadConfig().profiles;
  const found: { provider: ProviderId; account?: string; plan?: string; home: string }[] = [];

  for (const id of PROVIDER_ORDER) {
    const provider = getProvider(id);
    const install = await provider.detectInstall();
    if (!install.installed) {
      console.log(
        `  ${dim('○')} ${bold(provider.displayName.padEnd(16))} ${dim('not installed')}  ${dim(install.installHint)}`,
      );
      continue;
    }

    const identity = await readIdentitySafe(provider, provider.defaultHome);
    const version = install.version ? dim(` v${install.version}`) : '';

    if (!identity.loggedIn) {
      console.log(
        `  ${yellow('○')} ${bold(provider.displayName.padEnd(16))}${version} ${dim('installed, not signed in')}`,
      );
      continue;
    }

    console.log(
      `  ${green('●')} ${bold(provider.displayName.padEnd(16))}${version} ${identity.account ?? 'signed in'}` +
        (identity.plan ? dim(`  ${identity.plan}`) : ''),
    );
    found.push({
      provider: id,
      account: identity.account,
      plan: identity.plan,
      home: provider.defaultHome,
    });
  }

  if (found.length === 0) {
    console.log('');
    console.log(dim('  Nothing signed in yet. Install a tool, sign in, then re-run `am init`.'));
    console.log(dim('  Or run `am add` to create an isolated profile and sign in through it.'));
    console.log('');
    closePrompts();
    return;
  }

  // Skip anything already registered - by directory, or by being the same
  // subscription as a profile that already exists (same tool, same account).
  const skipped: { name: string; as: string }[] = [];
  const toAdopt = found.filter((f) => {
    const already = existing.find(
      (p) =>
        p.provider === f.provider &&
        (p.home === f.home ||
          (accountKey(p.account) !== undefined && accountKey(p.account) === accountKey(f.account))),
    );
    if (already) {
      skipped.push({ name: getProvider(f.provider).displayName, as: already.name });
      return false;
    }
    return true;
  });

  for (const s of skipped) {
    console.log(dim(`  - ${s.name} is already registered as "${s.as}"`));
  }

  if (toAdopt.length === 0) {
    console.log('');
    console.log(dim('  All of these are already registered. Run `am status` to see them.'));
    console.log('');
    closePrompts();
    return;
  }

  console.log('');
  const proceed =
    opts.yes || !isInteractive()
      ? true
      : await confirm(`Register ${toAdopt.length} existing account(s)?`);
  if (!proceed) {
    closePrompts();
    return;
  }

  const named: string[] = [];
  for (const f of toAdopt) {
    // Name it after the tool: unique across providers, and it reads well as
    // `am run codex`.
    const name = uniqueProfileName(getProvider(f.provider).short, named);
    named.push(name);
    const profile: Profile = {
      name,
      provider: f.provider,
      home: f.home,
      label: 'Existing install',
      account: f.account,
      plan: f.plan,
      managed: false, // points at the tool's own directory — never relocate it
      createdAt: new Date().toISOString(),
    };
    upsertProfile(profile);
    setActive(f.provider, name);
  }

  console.log('');
  console.log(`  ${green('✓')} Registered ${toAdopt.length} profile(s): ${bold(named.join(', '))}`);

  const hazards = detectHazards();
  if (hazards.length > 0) {
    console.log('');
    console.log(`  ${red('⚠')} ${bold('Your shell has variables that override subscription billing:')}`);
    for (const h of hazards) {
      console.log(`    ${red(h.variable)} — ${h.explanation}`);
    }
    console.log(dim('    `am run` strips the critical ones automatically. See `am doctor`.'));
  }

  console.log('');
  console.log('  Next:');
  console.log(`    ${cyan('am add')}     create a second, isolated profile and sign in`);
  console.log(`    ${cyan('am status')}  see plan, quota and consumption for every account`);
  console.log('');
  closePrompts();
}

/** Used by `am add` to warn when a directory is already populated. */
export function dirIsPopulated(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

export { tildify };
