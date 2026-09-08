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
import { detectShell, HOOK_MARKER, rcFileFor, rcPathFor, shellHookBody } from './shell.js';

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
    console.log(dim('  Or run `am profile add` to create an isolated profile and sign in through it.'));
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
    await offerShellHook(opts.yes);
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

  await offerShellHook(opts.yes);
  console.log('');
  console.log('  Next:');
  console.log(`    ${cyan('am profile add')}                create a second, isolated profile and sign in`);
  console.log(`    ${cyan('am status')}                     plan, quota and consumption for every account`);
  console.log(`    ${cyan('am gm start <profile> [name]')}  in a project folder: start a General Manager and its team`);
  console.log('');
  closePrompts();
}

/** Put the shell hook in the rc file, once, with consent; it is what lets `am profile use` change the current shell. */
async function offerShellHook(yes?: boolean): Promise<void> {
  if (process.env.AGENT_MANAGER_SHELL === '2') return;
  const shell = detectShell();
  const rc = rcFileFor(shell);
  let current = '';
  try {
    current = fs.readFileSync(rcPathFor(shell), 'utf8');
  } catch {
    /* no rc file yet */
  }
  if (current.includes(HOOK_MARKER)) {
    const isCurrent = /AGENT_MANAGER_SHELL[= ]2/.test(current);
    console.log('');
    console.log(dim(isCurrent ? `  The shell hook is in ${rc}; open a new terminal for it to take effect.` : `  The shell hook in ${rc} is from an older version and handles only "am use". Replace that block with the output of: am shell hook`));
    return;
  }
  console.log('');
  const ok = yes || (isInteractive() && (await confirm(`Add the shell hook to ${rc}, so "am profile use" changes this shell?`)));
  if (!ok) {
    console.log(dim(`  Skipped. Later: am shell hook >> ${rc} && exec ${shell}`));
    return;
  }
  fs.appendFileSync(rcPathFor(shell), `\n${shellHookBody(shell)}\n`);
  console.log(`  ${green('✓')} Shell hook added to ${rc}. ${dim(`Open a new terminal, or run: exec ${shell}`)}`);
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
