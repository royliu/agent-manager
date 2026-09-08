import type { ProviderId } from '../core/config.js';

export interface Identity {
  /** Account email or other stable handle. */
  account?: string;
  displayName?: string;
  /** Normalised plan label, e.g. "Max 20x", "Pro", "Plus". */
  plan?: string;
  organization?: string;
  /** How the account is billed, when knowable. */
  billing?: string;
  loggedIn: boolean;
}

export interface Window {
  /** 0–100 */
  usedPercent: number;
  windowMinutes: number;
  /** epoch ms */
  resetsAt?: number;
  label: string;
}

export interface UsageSnapshot {
  /** Quota windows, when the provider exposes them. */
  windows: Window[];
  /** Locally-derived token counts over the trailing 24h. */
  tokens24h?: TokenTotals;
  /** Locally-derived token counts over the trailing 7d. */
  tokens7d?: TokenTotals;
  /** Estimated pay-per-token cost of the trailing 24h, in USD. */
  estCost24h?: number;
  /** When the underlying data was last written by the tool. */
  lastActivity?: number;
  /** Where the numbers came from, for honesty in the UI. */
  source: 'local' | 'live' | 'mixed' | 'none';
  note?: string;
}

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  get total(): number;
}

export interface InstallInfo {
  installed: boolean;
  binPath?: string;
  version?: string;
  installHint: string;
}

export interface LaunchSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface Provider {
  id: ProviderId;
  displayName: string;
  /** Short word used in tables. */
  short: string;
  /** The directory the tool uses when no isolation is configured. */
  defaultHome: string;
  /** Env var that relocates the whole config+credential store, if any. */
  configEnvVar?: string;
  /** True when isolation is achieved by env var (CLI) rather than app flags. */
  isolationKind: 'env' | 'app-flag';

  detectInstall(): Promise<InstallInfo>;
  readIdentity(home: string): Promise<Identity>;
  readUsage(home: string): Promise<UsageSnapshot>;
  /** Build the command that launches this tool under the given profile home. */
  launch(home: string, args: string[], opts?: { keepApiKeys?: boolean }): LaunchSpec;
  /** Human instructions for signing this profile in. */
  loginHint(home: string, name: string): string;
}

export function makeTotals(
  input = 0,
  output = 0,
  cacheRead = 0,
  cacheWrite = 0,
): TokenTotals {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    get total() {
      return this.input + this.output + this.cacheRead + this.cacheWrite;
    },
  };
}

export const emptyUsage = (note?: string): UsageSnapshot => ({
  windows: [],
  source: 'none',
  note,
});
