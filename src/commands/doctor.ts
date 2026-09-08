import fs from 'node:fs';
import { getActive, loadConfig } from '../core/config.js';
import { detectHazards } from '../core/env.js';
import {
  findDuplicateAccounts, redundantMember, type AccountMember,
} from '../core/duplicates.js';
import { AM_HOME, tildify } from '../core/paths.js';
import { getProvider, PROVIDER_ORDER, readIdentitySafe } from '../providers/index.js';
import { bold, cyan, dim, green, listPhrase, red, yellow } from '../ui/format.js';
import { serviceRunning } from '../swarm/client.js';
import { listSwarms, loadSwarmConfig } from '../swarm/registry.js';

interface Finding {
  level: 'ok' | 'warn' | 'error';
  title: string;
  detail?: string;
  fix?: string;
}

export async function doctorCommand(): Promise<void> {
  const findings: Finding[] = [];

  // 1. Billing-override variables in the current shell — the failure mode most
  //    likely to silently cost real money.
  const hazards = detectHazards();
  if (hazards.length === 0) {
    findings.push({ level: 'ok', title: 'No billing-override variables in this shell' });
  } else {
    for (const h of hazards) {
      findings.push({
        level: h.severity === 'critical' ? 'error' : 'warn',
        title: `${h.variable} is set`,
        detail: h.explanation,
        fix: h.fix,
      });
    }
  }

  // 2. Installed tools.
  for (const id of PROVIDER_ORDER) {
    const provider = getProvider(id);
    const install = await provider.detectInstall();
    findings.push(
      install.installed
        ? { level: 'ok', title: `${provider.displayName} installed`, detail: install.version }
        : {
            level: 'warn',
            title: `${provider.displayName} not installed`,
            fix: install.installHint,
          },
    );
  }

  // 3. Profiles.
  const { profiles } = loadConfig();
  if (profiles.length === 0) {
    findings.push({
      level: 'warn',
      title: 'No profiles registered',
      fix: 'am init   (adopt existing logins)   or   am add   (create a new one)',
    });
  }

  const seenHomes = new Map<string, string>();
  const members: AccountMember[] = [];
  for (const p of profiles) {
    const provider = getProvider(p.provider);
    const key = fs.existsSync(p.home) ? fs.realpathSync(p.home) : p.home;
    const clash = seenHomes.get(key);
    if (clash) {
      findings.push({
        level: 'error',
        title: `Profiles "${clash}" and "${p.name}" share one directory`,
        detail: tildify(p.home),
        fix: 'Give each profile its own directory, or they will overwrite each other’s login.',
      });
    }
    seenHomes.set(key, p.name);

    if (!fs.existsSync(p.home)) {
      findings.push({
        level: 'error',
        title: `Profile "${p.name}" directory is missing`,
        detail: tildify(p.home),
        fix: `am rm ${p.name}   then re-add it`,
      });
      continue;
    }

    const identity = await readIdentitySafe(provider, p.home);
    members.push({
      name: p.name,
      provider: p.provider,
      account: identity.account ?? p.account,
      active: getActive(p.provider) === p.name,
    });
    findings.push(
      identity.loggedIn
        ? {
            level: 'ok',
            title: `${p.name} (${provider.short}) signed in`,
            detail: [identity.account, identity.plan].filter(Boolean).join(' · '),
          }
        : {
            level: 'warn',
            title: `${p.name} (${provider.short}) not signed in`,
            fix: provider.loginHint(p.home, p.name),
          },
    );
  }

  // 3b. One subscription must not be registered twice: same tool, same
  //     account means one quota pool reported as two.
  for (const dup of findDuplicateAccounts(members)) {
    const names = dup.members.map((m) => m.name);
    findings.push({
      level: 'error',
      title: `${listPhrase(names.map((n) => `"${n}"`))} are one ${getProvider(dup.provider).displayName} subscription`,
      detail: `${dup.account} - one plan, ${names.length} profiles, so quota and usage are counted ${names.length}x`,
      fix: `am rm ${redundantMember(dup).name}   (or sign it into a different account)`,
    });
  }

  // 4. Shell integration.
  const hooked = Boolean(process.env.AGENT_MANAGER_SHELL);
  findings.push(
    hooked
      ? { level: 'ok', title: 'Shell integration active' }
      : {
          level: 'warn',
          title: 'Shell integration not installed',
          detail: '`am use` will not change the current shell without it',
          fix: 'am shell-init >> ~/.zshrc && exec zsh',
        },
  );

  // 5. General Managers and their teams.
  const swarms = listSwarms();
  const swarmCfg = loadSwarmConfig();
  if (swarms.length === 0) {
    findings.push({ level: 'ok', title: 'No General Managers yet', fix: 'am start <profile> gm [name]   (in a project folder)' });
  } else {
    for (const s of swarms) {
      const running = serviceRunning(s.name);
      findings.push({
        level: 'ok',
        title: `${s.name}: ${running ? 'team running' : 'stopped'}`,
        detail: `${s.profile} · ${tildify(s.dir)}`,
        fix: running ? undefined : `am gm ${s.name}   (or am start in ${tildify(s.dir)})`,
      });
    }
  }
  findings.push({
    level: 'warn',
    title: `Agents checkpoint and get a fresh context at ${swarmCfg.compactAt}%`,
    detail: `am also sets ${swarmCfg.compactEnv}=${swarmCfg.compactAt} for Claude Code agents; whether the current release honours that variable is not verified, so the task manager drives the checkpoint itself either way`,
  });

  // ---- report -------------------------------------------------------------
  console.log('');
  console.log(`  ${bold('agent-manager doctor')}  ${dim(tildify(AM_HOME))}`);
  console.log('');
  for (const f of findings) {
    const icon = f.level === 'ok' ? green('✓') : f.level === 'warn' ? yellow('!') : red('✗');
    console.log(`  ${icon} ${f.title}${f.detail ? dim(`  ${f.detail}`) : ''}`);
    if (f.fix) console.log(`      ${dim('→')} ${cyan(f.fix)}`);
  }

  const errors = findings.filter((f) => f.level === 'error').length;
  const warns = findings.filter((f) => f.level === 'warn').length;
  console.log('');
  console.log(
    errors > 0
      ? `  ${red(`${errors} problem(s)`)}${warns ? dim(`, ${warns} warning(s)`) : ''}`
      : warns > 0
        ? `  ${yellow(`${warns} warning(s)`)}, nothing broken`
        : `  ${green('All good.')}`,
  );
  console.log('');
  if (errors > 0) process.exitCode = 1;
}
