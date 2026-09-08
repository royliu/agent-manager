import React, { useEffect, useState } from 'react';
import { Box, render, Text, useApp, useInput } from 'ink';
import { takeSnapshot, type Snapshot } from '../core/snapshot.js';
import { findDuplicateAccounts, redundantMember } from '../core/duplicates.js';
import { getProvider } from '../providers/index.js';
import type { ProviderId } from '../core/config.js';
import { toRows, type Row } from '../ui/rows.js';
import {
  bar, bold, cyan, dim, listPhrase, padEnd, pct, red, relTime, tokens, truncateVisible, untilTime,
  usd, width, yellow,
} from '../ui/format.js';

interface Options {
  watch?: boolean;
  json?: boolean;
  interval?: number;
  provider?: ProviderId;
  live?: boolean;
}

/** Column widths, computed from content so long emails don't wrap. */
function layout(rows: Row[]) {
  return {
    name: Math.max(7, ...rows.map((r) => r.name.length)),
    provider: Math.max(4, ...rows.map((r) => r.provider.length)),
    plan: Math.max(4, ...rows.map((r) => r.plan.length)),
    account: Math.min(34, Math.max(7, ...rows.map((r) => r.account.length))),
  };
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function renderLines(snapshot: Snapshot, term = process.stdout.columns || 100): string[] {
  const rows = toRows(snapshot);
  if (rows.length === 0) {
    return [
      dim('No profiles yet.'),
      '',
      `  Run ${cyan('am add')} to set one up, or ${cyan('am init')} to register`,
      '  the accounts you are already signed into.',
    ];
  }

  const w = layout(rows);
  const quotaCell = (r: Row): string =>
    r.windows.length > 0
      ? r.windows
          .map((win) => `${dim(win.label)} ${bar(win.usedPercent, 8)} ${pct(win.usedPercent)}`)
          .join('  ')
      : dim(r.loggedIn ? '—' : 'not signed in');
  const quotaW = Math.max(14, ...rows.map((r) => width(quotaCell(r)))) + 2;

  // Quota is the reason this view exists, so shed the softer columns first
  // when the terminal is narrow rather than letting the table wrap.
  const fixed = 2 + w.name + 2 + w.provider + 2 + w.plan + 2 + quotaW;
  let accountW = w.account;
  let showTokens = true;
  let showLast = true;

  const total = () => fixed + (accountW ? accountW + 2 : 0) + (showTokens ? 8 : 0) + (showLast ? 9 : 0);
  if (total() > term) showLast = false;
  if (total() > term) showTokens = false;
  if (total() > term) accountW = Math.max(0, term - (total() - accountW - 2) - 2);
  if (accountW < 8) accountW = 0;

  const out: string[] = [];
  out.push(
    '  ' +
      padEnd(dim('PROFILE'), w.name + 2) +
      padEnd(dim('TOOL'), w.provider + 2) +
      padEnd(dim('PLAN'), w.plan + 2) +
      (accountW ? padEnd(dim('ACCOUNT'), accountW + 2) : '') +
      padEnd(dim('QUOTA'), quotaW) +
      (showTokens ? padEnd(dim('24H'), 8) : '') +
      (showLast ? dim('LAST USE') : ''),
  );

  const indent = ' '.repeat(w.name + 4);
  /** Annotation lines are free-form prose, so clamp them to the terminal too. */
  const note = (body: string, colour: (v: string) => string): string => {
    const room = Math.max(10, term - indent.length - 2);
    return indent + colour(body.length > room ? `${body.slice(0, room - 1)}…` : body);
  };
  for (const r of rows) {
    const marker = r.active ? cyan('●') : ' ';
    out.push(
      `${marker} ` +
        padEnd(r.loggedIn ? bold(r.name) : dim(r.name), w.name + 2) +
        padEnd(r.provider, w.provider + 2) +
        padEnd(r.loggedIn ? r.plan : dim(r.plan), w.plan + 2) +
        (accountW ? padEnd(truncate(r.account, accountW), accountW + 2) : '') +
        padEnd(quotaCell(r), quotaW) +
        (showTokens ? padEnd(r.tokens24h > 0 ? tokens(r.tokens24h) : dim('—'), 8) : '') +
        (showLast ? dim(relTime(r.lastActivity)) : ''),
    );

    if (r.cost24h > 0) {
      out.push(
        note(`↳ ${usd(r.cost24h)} of list-price usage absorbed by this subscription in 24h`, dim),
      );
    }
    if (r.note && r.windows.length === 0 && r.loggedIn) {
      out.push(note(`↳ ${r.note}`, dim));
    }
    if (r.hazard) {
      out.push(note(`⚠ ${r.hazard} is set — this profile would bill per-token`, red));
    }
  }

  // Same tool + same account = one subscription registered twice. Every number
  // above it is that one plan, counted once per profile.
  const duplicates = findDuplicateAccounts(
    snapshot.profiles.map((s) => ({
      name: s.profile.name,
      provider: s.profile.provider,
      account: s.identity.account ?? s.profile.account,
      active: s.active,
    })),
  );
  for (const dup of duplicates) {
    const names = dup.members.map((m) => m.name);
    const spare = redundantMember(dup);
    out.push('');
    out.push(
      yellow(
        `⚠ ${listPhrase(names)} are one ${getProvider(dup.provider).displayName} ` +
          `subscription (${dup.account}).`,
      ),
    );
    out.push(
      dim(`  One quota pool, counted ${names.length}× above. Drop the spare: `) +
        cyan(`am rm ${spare.name}`),
    );
  }

  const nextReset = rows
    .flatMap((r) => r.windows.map((win) => ({ name: r.name, win })))
    .filter((x) => x.win.resetsAt)
    .sort((a, b) => (a.win.resetsAt ?? 0) - (b.win.resetsAt ?? 0))[0];
  if (nextReset) {
    out.push('');
    out.push(
      dim(
        `Next quota reset: ${nextReset.name} ${nextReset.win.label} ${untilTime(nextReset.win.resetsAt)}`,
      ),
    );
  }
  // Final guarantee: nothing we emit is ever wider than the terminal.
  return out.map((line) => truncateVisible(line, term));
}

const Dashboard: React.FC<{ interval: number; provider?: ProviderId; live?: boolean }> = ({
  interval,
  provider,
  live,
}) => {
  const [snapshot, setSnapshot] = useState<Snapshot | undefined>();
  const [tick, setTick] = useState(0);
  const [columns, setColumns] = useState(process.stdout.columns || 100);
  const { exit } = useApp();

  useEffect(() => {
    const onResize = () => setColumns(process.stdout.columns || 100);
    process.stdout.on('resize', onResize);
    return () => {
      process.stdout.off('resize', onResize);
    };
  }, []);

  useInput((input, key) => {
    if (input === 'q' || key.escape || (key.ctrl && input === 'c')) exit();
    if (input === 'r') setTick((t) => t + 1);
  });

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      takeSnapshot({ provider, live }).then((s) => {
        if (!cancelled) setSnapshot(s);
      });
    };
    refresh();
    const timer = setInterval(refresh, interval);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [interval, provider, live, tick]);

  if (!snapshot) return <Text dimColor>Reading profiles…</Text>;

  return (
    <Box flexDirection="column">
      <Text>
        {bold('agent-manager')} {dim(`· ${new Date(snapshot.takenAt).toLocaleTimeString()}`)}
      </Text>
      <Text> </Text>
      {renderLines(snapshot, columns).map((line, i) => (
        <Text key={i} wrap="truncate">
          {line}
        </Text>
      ))}
      <Text> </Text>
      <Text dimColor>q quit · r refresh</Text>
    </Box>
  );
};

export async function statusCommand(opts: Options): Promise<void> {
  if (opts.watch) {
    const { waitUntilExit } = render(
      <Dashboard
        interval={(opts.interval ?? 10) * 1000}
        provider={opts.provider}
        live={opts.live}
      />,
    );
    await waitUntilExit();
    return;
  }

  const snapshot = await takeSnapshot({ provider: opts.provider, live: opts.live });
  if (opts.json) {
    console.log(JSON.stringify({ takenAt: snapshot.takenAt, profiles: toRows(snapshot) }, null, 2));
    return;
  }
  console.log('');
  for (const line of renderLines(snapshot)) console.log(line);
  console.log('');
}
