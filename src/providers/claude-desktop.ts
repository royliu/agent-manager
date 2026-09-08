import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Identity, InstallInfo, LaunchSpec, Provider, UsageSnapshot } from './types.js';
import { emptyUsage } from './types.js';
import { readJsonFile } from './util.js';

const APP_SUPPORT = path.join(os.homedir(), 'Library', 'Application Support');
const DEFAULT_HOME = path.join(APP_SUPPORT, 'Claude');
const APP_PATH = '/Applications/Claude.app';

/**
 * The Claude desktop app is Electron, so a profile is just a separate
 * `--user-data-dir`. This is the mechanism behind the widely-shared
 * `open -n -a Claude --args --user-data-dir=...` trick.
 */
export const claudeDesktop: Provider = {
  id: 'claude-desktop',
  displayName: 'Claude Desktop',
  short: 'desktop',
  defaultHome: DEFAULT_HOME,
  isolationKind: 'app-flag',

  async detectInstall(): Promise<InstallInfo> {
    const installed = fs.existsSync(APP_PATH);
    let version: string | undefined;
    if (installed) {
      const plist = readJsonFile<Record<string, unknown>>(
        path.join(APP_PATH, 'Contents', 'Resources', 'app-update.yml'),
      );
      void plist; // best-effort only; the plist is XML, not JSON
    }
    return {
      installed,
      binPath: installed ? APP_PATH : undefined,
      version,
      installHint: 'Download from https://claude.ai/download',
    };
  },

  async readIdentity(home: string): Promise<Identity> {
    // The desktop app keeps its session in an Electron partition rather than a
    // readable credentials file, so we can only report whether the profile has
    // been signed into at least once.
    const marker = path.join(home, 'Local Storage');
    const initialised = fs.existsSync(marker);
    return {
      loggedIn: initialised,
      account: initialised ? 'signed in (account not readable)' : undefined,
    };
  },

  async readUsage(): Promise<UsageSnapshot> {
    return emptyUsage('desktop app does not expose local usage data');
  },

  launch(home: string, args: string[]): LaunchSpec {
    return {
      command: 'open',
      args: ['-n', '-a', APP_PATH, '--args', `--user-data-dir=${home}`, ...args],
      env: { ...process.env, AGENT_MANAGER_PROFILE_HOME: home },
    };
  },

  loginHint(home: string, name: string): string {
    return `am run ${name} -- (launches the app; sign in once, then quit)`;
  },
};

/** Where desktop profiles live — alongside the app's own support directory. */
export function desktopProfileHome(name: string): string {
  return path.join(APP_SUPPORT, `Claude-${name}`);
}
