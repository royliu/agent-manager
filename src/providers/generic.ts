import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildEnv } from '../core/env.js';
import type { ProviderId } from '../core/config.js';
import type { Identity, InstallInfo, LaunchSpec, Provider, UsageSnapshot } from './types.js';
import { emptyUsage } from './types.js';
import { tryVersion, which } from './util.js';

export interface GenericSpec {
  id: ProviderId;
  displayName: string;
  short: string;
  bin: string;
  /** Directory the tool uses by default, relative to home. */
  homeDirName: string;
  installHint: string;
  loginCmd?: string;
  /** Files that, if present in a profile home, mean "signed in". */
  credentialFiles: string[];
}

/**
 * Provider for CLIs that have no documented config-directory variable. We
 * isolate them by relocating HOME, which works but is coarser than a dedicated
 * variable — the tool sees an otherwise-empty home directory.
 */
export function makeGenericProvider(spec: GenericSpec): Provider {
  const defaultHome = path.join(os.homedir(), spec.homeDirName);

  return {
    id: spec.id,
    displayName: spec.displayName,
    short: spec.short,
    defaultHome,
    isolationKind: 'env',

    async detectInstall(): Promise<InstallInfo> {
      const binPath = await which(spec.bin);
      return {
        installed: Boolean(binPath),
        binPath,
        version: binPath ? await tryVersion(spec.bin) : undefined,
        installHint: spec.installHint,
      };
    },

    async readIdentity(home: string): Promise<Identity> {
      // Under HOME redirection the tool's dotfiles live one level deeper.
      const roots =
        path.resolve(home) === path.resolve(defaultHome)
          ? [home]
          : [path.join(home, spec.homeDirName), home];
      for (const root of roots) {
        for (const file of spec.credentialFiles) {
          if (fs.existsSync(path.join(root, file))) {
            return { loggedIn: true, account: 'signed in (account not readable)' };
          }
        }
      }
      return { loggedIn: false };
    },

    async readUsage(): Promise<UsageSnapshot> {
      return emptyUsage('no local usage data for this tool');
    },

    launch(home: string, args: string[], opts = {}): LaunchSpec {
      return { command: spec.bin, args, env: buildEnv(spec.id, home, process.env, opts) };
    },

    loginHint(home: string): string {
      return `HOME=${home} ${spec.loginCmd ?? spec.bin}`;
    },
  };
}

export const gemini = makeGenericProvider({
  id: 'gemini',
  displayName: 'Gemini CLI',
  short: 'gemini',
  bin: 'gemini',
  homeDirName: '.gemini',
  installHint: 'npm install -g @google/gemini-cli',
  credentialFiles: ['oauth_creds.json', 'google_accounts.json'],
});

export const cursor = makeGenericProvider({
  id: 'cursor',
  displayName: 'Cursor Agent',
  short: 'cursor',
  bin: 'cursor-agent',
  homeDirName: '.cursor',
  installHint: 'curl https://cursor.com/install -fsS | bash',
  credentialFiles: ['auth.json', 'cli-config.json'],
});
