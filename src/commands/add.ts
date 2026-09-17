import fs from 'node:fs';
import {
  loadConfig, profileByName, ProviderIdSchema, setActive, uniqueProfileName, upsertProfile,
  type Profile, type ProviderId,
} from '../core/config.js';
import { accountKey } from '../core/duplicates.js';
import { writeHarness, type HarnessSetup } from '../core/harness.js';
import { ensureAmHome, ensureDir, profileHome, tildify } from '../core/paths.js';
import { runForeground } from '../core/exec.js';
import { desktopProfileHome, getProvider, PROVIDER_ORDER, readIdentitySafe } from '../providers/index.js';
import { keyHint, openRouterIdentity } from '../providers/openrouter.js';
import { bold, cyan, dim, green, red, yellow } from '../ui/format.js';
import { ask, closePrompts, confirm, isInteractive, select, type Choice } from '../ui/prompt.js';
import { chooseHarness, describeSetup } from './modelsetup.js';

interface AddOptions {
  provider?: string;
  label?: string;
  home?: string;
  yes?: boolean;
  /** The model the profile runs: a native id, or an OpenRouter id with `openrouter`. */
  model?: string;
  /** Reach models through OpenRouter with an API key instead of the tool's own login. */
  openrouter?: boolean;
}

function homeFor(provider: ProviderId, name: string): string {
  return provider === 'claude-desktop' ? desktopProfileHome(name) : profileHome(provider, name);
}

/**
 * A profile is a subscription: tool + account. Signing a second profile into an
 * account this tool already has buys nothing - same quota pool, counted twice.
 */
function warnIfSameSubscription(name: string, provider: ProviderId, account?: string): void {
  const key = accountKey(account);
  if (!key) return;
  const twin = loadConfig().profiles.find(
    (p) => p.name !== name && p.provider === provider && accountKey(p.account) === key,
  );
  if (!twin) return;
  console.log(`  ${yellow('!')} ${bold(twin.name)} is signed into the same account.`);
  console.log(
    `    ${dim('One subscription, two profiles - the quota is shared and usage double-counts.')}`,
  );
  console.log(`    ${dim('Sign this one into another account, or drop it:')} ${cyan(`am profile rm ${name}`)}`);
  console.log('');
}

export async function addCommand(nameArg: string | undefined, opts: AddOptions): Promise<void> {
  ensureAmHome();

  // ---- provider -----------------------------------------------------------
  let provider: ProviderId;
  if (opts.provider) {
    const parsed = ProviderIdSchema.safeParse(opts.provider);
    if (!parsed.success) {
      console.error(
        `${red('✗')} Unknown provider "${opts.provider}". Valid: ${PROVIDER_ORDER.join(', ')}`,
      );
      process.exitCode = 1;
      return;
    }
    provider = parsed.data;
  } else if (!isInteractive()) {
    console.error(`${red('✗')} --provider is required when not running interactively.`);
    process.exitCode = 1;
    return;
  } else {
    const choices: Choice<ProviderId>[] = [];
    for (const id of PROVIDER_ORDER) {
      const p = getProvider(id);
      const install = await p.detectInstall();
      choices.push({
        value: id,
        label: p.displayName,
        hint: install.installed
          ? p.isolationKind === 'env'
            ? `isolates via ${p.configEnvVar ?? 'HOME'}`
            : 'isolates via --user-data-dir'
          : undefined,
        disabled: install.installed ? undefined : `not installed · ${install.installHint}`,
      });
    }
    console.log('');
    provider = await select('Which tool is this profile for?', choices);
  }

  const impl = getProvider(provider);
  const install = await impl.detectInstall();
  if (!install.installed) {
    console.log('');
    console.log(`${yellow('!')} ${impl.displayName} is not installed. Install it with:`);
    console.log(`    ${cyan(install.installHint)}`);
    console.log('');
    closePrompts();
    process.exitCode = 1;
    return;
  }

  // ---- name ---------------------------------------------------------------
  let name = nameArg;
  if (!name) {
    if (!isInteractive()) {
      console.error(`${red('✗')} A profile name is required.`);
      process.exitCode = 1;
      return;
    }
    name = await ask('Profile name?', uniqueProfileName('work'));
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    console.error(`${red('✗')} Invalid name "${name}" — use letters, digits, dot, underscore, dash.`);
    process.exitCode = 1;
    return;
  }
  // Names are unique across tools, not per tool — `am run <name>` has to mean
  // exactly one thing.
  const clash = profileByName(name);
  if (clash) {
    console.error(
      `${red('✗')} Profile "${name}" already exists for ${getProvider(clash.provider).displayName}. ` +
        `Names are unique across tools — try ${cyan(uniqueProfileName(name))}.`,
    );
    process.exitCode = 1;
    return;
  }

  // ---- backend and model --------------------------------------------------
  // Asked before anything is written, so a rejected key or an unknown model leaves no half-made profile.
  const tool = provider === 'claude-code' || provider === 'codex' ? provider : undefined;
  let setup: HarnessSetup | undefined;
  if (tool) {
    setup = await chooseHarness(tool, { model: opts.model, openrouter: opts.openrouter, yes: opts.yes });
    if (!setup) {
      closePrompts();
      process.exitCode = 1;
      return;
    }
  } else if (opts.model || opts.openrouter) {
    console.error(`${red('✗')} --model and --openrouter are for Claude Code and Codex profiles; ${impl.displayName} is set up in the app.`);
    process.exitCode = 1;
    return;
  }

  // ---- home ---------------------------------------------------------------
  const home = opts.home ? opts.home : homeFor(provider, name);
  if (fs.existsSync(home) && fs.readdirSync(home).length > 0) {
    const reuse =
      opts.yes ||
      !isInteractive() ||
      (await confirm(`${tildify(home)} already has data. Register it as-is?`, true));
    if (!reuse) {
      closePrompts();
      return;
    }
  }
  ensureDir(home);
  if (tool && setup && (setup.backend === 'openrouter' || setup.model)) writeHarness(tool, home, setup);
  const onOpenRouter = setup?.backend === 'openrouter';

  const profile: Profile = {
    name,
    provider,
    home,
    label: opts.label,
    ...(onOpenRouter ? { account: openRouterIdentity(keyHint(setup!.key)).account, plan: 'OpenRouter' } : {}),
    managed: true,
    createdAt: new Date().toISOString(),
  };
  upsertProfile(profile);

  console.log('');
  console.log(`  ${green('✓')} Created profile ${bold(name)} for ${impl.displayName}`);
  console.log(`    ${dim('config dir')}  ${tildify(home)}`);
  if (impl.configEnvVar) {
    console.log(`    ${dim('isolation ')}  ${impl.configEnvVar}=${tildify(home)}`);
  } else if (impl.isolationKind === 'app-flag') {
    console.log(`    ${dim('isolation ')}  --user-data-dir=${tildify(home)}`);
  } else {
    console.log(
      `    ${dim('isolation ')}  HOME=${tildify(home)} ${dim('(this tool has no config-dir variable)')}`,
    );
  }
  if (setup) console.log(`    ${dim('model     ')}  ${describeSetup(setup)}`);

  // ---- ready: OpenRouter needs no sign-in ---------------------------------
  if (onOpenRouter) {
    const lines: [string, string][] = [
      [`am run ${name}`, `open ${impl.displayName} on it`],
      [`am gm start ${name} [gm-name]`, 'in a project folder: a General Manager and its team on it'],
    ];
    const pad = Math.max(...lines.map(([c]) => c.length)) + 2;
    console.log('');
    console.log(`  ${bold('Ready, no sign-in needed:')}`);
    for (const [command, what] of lines) console.log(`    ${cyan(command)}${' '.repeat(pad - command.length)}${dim(what)}`);
    console.log('');
    setActive(provider, name);
    closePrompts();
    return;
  }

  // ---- sign in ------------------------------------------------------------
  console.log('');
  console.log(`  ${bold('Sign in to this profile:')}`);
  console.log(`    ${cyan(impl.loginHint(home, name))}`);
  console.log('');
  console.log(dim(`  Or just run it through agent-manager, which sets everything for you:`));
  console.log(`    ${cyan(`am run ${name}`)}`);
  console.log('');

  const identity = await readIdentitySafe(impl, home);
  if (!identity.loggedIn && isInteractive() && !opts.yes) {
    const now = await confirm('Launch it now to sign in?', true);
    if (now) {
      closePrompts();
      const spec = impl.launch(home, []);
      await runForeground(spec);
      const after = await readIdentitySafe(impl, home);
      if (after.loggedIn) {
        upsertProfile({ ...profile, account: after.account, plan: after.plan });
        console.log('');
        console.log(`  ${green('✓')} ${name} is signed in as ${bold(after.account ?? 'unknown')}`);
        if (after.plan) console.log(`    ${dim('plan')} ${after.plan}`);
        console.log('');
        warnIfSameSubscription(name, provider, after.account);
      }
      setActive(provider, name);
      return;
    }
  }

  setActive(provider, name);
  closePrompts();
}
