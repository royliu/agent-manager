import type { ProviderId } from './config.js';

export interface AccountMember {
  name: string;
  provider: ProviderId;
  /** Live account if known, else whatever the registry cached. */
  account?: string;
  active?: boolean;
}

export interface AccountDuplicate {
  provider: ProviderId;
  /** The account as it should be shown, not the comparison key. */
  account: string;
  members: AccountMember[];
}

/**
 * Comparable form of an account handle, or undefined when the tool only told
 * us *that* it is signed in ("signed in (account not readable)"). Two unknowns
 * are not evidence of the same subscription.
 */
export function accountKey(account: string | undefined): string | undefined {
  const value = account?.trim().toLowerCase();
  if (!value) return undefined;
  return /\s/.test(value) ? undefined : value;
}

/**
 * A profile is one subscription: tool + account. Two profiles that agree on
 * both are the same plan behind two directories — their quota is one pool and
 * their usage double-counts.
 */
export function findDuplicateAccounts(members: AccountMember[]): AccountDuplicate[] {
  const groups = new Map<string, AccountDuplicate>();
  for (const member of members) {
    const key = accountKey(member.account);
    if (!key) continue;
    const id = `${member.provider} ${key}`;
    const group = groups.get(id) ?? {
      provider: member.provider,
      account: member.account!.trim(),
      members: [],
    };
    group.members.push(member);
    groups.set(id, group);
  }
  return [...groups.values()].filter((g) => g.members.length > 1);
}

/** The one to suggest dropping: never the active profile. */
export function redundantMember(dup: AccountDuplicate): AccountMember {
  return dup.members.find((m) => !m.active) ?? dup.members[dup.members.length - 1]!;
}
