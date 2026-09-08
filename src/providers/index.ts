import type { ProviderId } from '../core/config.js';
import { claudeCode } from './claude-code.js';
import { claudeDesktop } from './claude-desktop.js';
import { codex } from './codex.js';
import { cursor, gemini } from './generic.js';
import { emptyUsage, type Identity, type Provider, type UsageSnapshot } from './types.js';

export const PROVIDERS: Record<ProviderId, Provider> = {
  'claude-code': claudeCode,
  codex,
  'claude-desktop': claudeDesktop,
  gemini,
  cursor,
};

/** Display order: the two first-class CLI providers lead. */
export const PROVIDER_ORDER: ProviderId[] = [
  'claude-code',
  'codex',
  'claude-desktop',
  'gemini',
  'cursor',
];

export function getProvider(id: ProviderId): Provider {
  return PROVIDERS[id];
}

/**
 * Identity/usage reads touch the filesystem and parse third-party formats, so
 * a malformed or half-written file must degrade rather than crash the command.
 */
export async function readIdentitySafe(provider: Provider, home: string): Promise<Identity> {
  try {
    return await provider.readIdentity(home);
  } catch {
    return { loggedIn: false };
  }
}

export async function readUsageSafe(provider: Provider, home: string): Promise<UsageSnapshot> {
  try {
    return await provider.readUsage(home);
  } catch {
    return emptyUsage('could not read usage data');
  }
}

export { desktopProfileHome } from './claude-desktop.js';
export * from './types.js';
