import fs from 'node:fs';
import { removeProfile, type ProviderId } from '../core/config.js';
import { PROFILES_DIR, tildify } from '../core/paths.js';
import { shellQuote } from '../core/exec.js';
import { bold, cyan, dim, green, yellow } from '../ui/format.js';
import { closePrompts, confirm, isInteractive } from '../ui/prompt.js';
import { resolveProfile } from './resolve.js';

export async function removeCommand(
  name: string,
  opts: { provider?: ProviderId; purge?: boolean; yes?: boolean } = {},
): Promise<void> {
  const profile = resolveProfile(name, { provider: opts.provider, command: 'am rm' });
  if (!profile) return;

  removeProfile(profile.name, profile.provider);
  console.log('');
  console.log(`  ${green('✓')} Unregistered ${bold(profile.name)} (${profile.provider})`);

  if (!opts.purge) {
    console.log(`    ${dim('Its data is untouched at')} ${tildify(profile.home)}`);
    // `am rm --purge` cannot be re-run: the registry entry is gone already.
    if (profile.managed) {
      const short = tildify(profile.home);
      const target = /^[~A-Za-z0-9_./:-]+$/.test(short) ? short : shellQuote(profile.home);
      console.log(`    ${dim('Delete it too with')} ${cyan(`rm -rf ${target}`)}`);
    }
    console.log('');
    return;
  }

  // Refuse to delete a directory we did not create — an unmanaged profile
  // points at the tool's real install (~/.claude, ~/.codex).
  if (!profile.managed) {
    console.log('');
    console.log(`  ${yellow('!')} Refusing to delete ${bold(tildify(profile.home))}.`);
    console.log(`    That is the tool's own install directory, not one agent-manager created.`);
    console.log(`    Delete it yourself if you really mean to sign out of your main account.`);
    console.log('');
    return;
  }
  if (!profile.home.startsWith(PROFILES_DIR) && !profile.home.includes('Claude-')) {
    console.log('');
    console.log(`  ${yellow('!')} ${tildify(profile.home)} is outside the profiles directory.`);
    console.log(`    Refusing to delete it automatically.`);
    console.log('');
    return;
  }

  const ok =
    opts.yes ||
    (isInteractive()
      ? await confirm(`Permanently delete ${tildify(profile.home)} and its login?`, false)
      : false);
  closePrompts();

  if (!ok) {
    console.log(`    ${dim('Kept')} ${tildify(profile.home)}`);
    console.log('');
    return;
  }

  fs.rmSync(profile.home, { recursive: true, force: true });
  console.log(`    ${dim('Deleted')} ${tildify(profile.home)}`);
  console.log('');
}
