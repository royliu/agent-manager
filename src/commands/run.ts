import { type ProviderId } from '../core/config.js';
import { runForeground } from '../core/exec.js';
import { getProvider, readIdentitySafe } from '../providers/index.js';
import { closePrompts } from '../ui/prompt.js';
import { bold, red, yellow } from '../ui/format.js';
import { resolveActiveProfile, resolveProfile } from './resolve.js';

interface RunOptions {
  provider?: ProviderId;
  keepApiKeys?: boolean;
}

/**
 * Launch a tool under a profile. Everything after `--` goes to the tool
 * untouched, so `am run work -- --resume` behaves like the tool itself.
 */
export async function runCommand(
  nameArg: string | undefined,
  passthrough: string[],
  opts: RunOptions = {},
): Promise<void> {
  const resolveOpts = { provider: opts.provider, command: 'am run' };
  const profile = nameArg
    ? resolveProfile(nameArg, resolveOpts)
    : await resolveActiveProfile(resolveOpts);
  if (!profile) return;

  const impl = getProvider(profile.provider);
  const install = await impl.detectInstall();
  if (!install.installed) {
    console.error(`${red('✗')} ${impl.displayName} is not installed: ${install.installHint}`);
    process.exitCode = 1;
    return;
  }

  const identity = await readIdentitySafe(impl, profile.home);
  if (!identity.loggedIn) {
    console.error('');
    console.error(
      `  ${yellow('!')} Profile ${bold(profile.name)} is not signed in yet — ` +
        `launching so you can sign in.`,
    );
    console.error('');
  }

  // The child takes over the terminal; nothing of ours may still hold stdin.
  closePrompts();
  const spec = impl.launch(profile.home, passthrough, { keepApiKeys: opts.keepApiKeys });
  const code = await runForeground(spec);
  process.exitCode = code;
}
