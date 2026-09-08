import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { profileByName } from '../core/config.js';
import { cyan, dim, yellow } from '../ui/format.js';
import { loadSwarmConfig } from './registry.js';
import { serviceRunning, TmClient } from './client.js';
import type { InboxItem } from './model.js';
import type { BoardSnapshot } from './service.js';

/**
 * The status line the GM session would have shown without us: the profile's own
 * statusLine, else the default config dir's, else claude-hud wherever it is installed.
 * Returns the command and the config dir it belongs to.
 */
function baseStatusLine(profileHome: string): { command: string; configDir: string } | undefined {
  const dirs = [profileHome, path.join(os.homedir(), '.claude')];
  for (const dir of dirs) {
    try {
      const st = (JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')) as { statusLine?: { type?: string; command?: string } }).statusLine;
      if (st?.type === 'command' && st.command && !/tm-hook|_hook/.test(st.command)) return { command: st.command, configDir: dir };
    } catch {
      /* no settings here */
    }
  }
  for (const dir of dirs) {
    const root = path.join(dir, 'plugins', 'cache', 'claude-hud', 'claude-hud');
    try {
      const versions = fs.readdirSync(root).filter((v) => fs.existsSync(path.join(root, v, 'dist', 'index.js')));
      versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      const v = versions[versions.length - 1];
      if (v) return { command: `"${process.execPath}" "${path.join(root, v, 'dist', 'index.js')}"`, configDir: dir };
    } catch {
      /* not installed here */
    }
  }
  return undefined;
}

function runBaseStatusLine(raw: string, profileHome: string): string {
  const base = baseStatusLine(profileHome);
  if (!base) return '';
  try {
    const out = execFileSync('/bin/sh', ['-c', base.command], {
      input: raw,
      env: { ...process.env, CLAUDE_CONFIG_DIR: base.configDir },
      timeout: 4000,
      stdio: ['pipe', 'pipe', 'ignore'],
    }).toString();
    return out.replace(/\s+$/, '');
  } catch {
    return '';
  }
}

/** Inbox kinds that should interrupt the GM; everything else is for awareness. */
const ACTIONABLE = new Set(['question', 'done', 'failed', 'stalled', 'quota', 'note']);

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d: string) => (s += d));
    process.stdin.on('end', () => resolve(s));
    setTimeout(() => resolve(s), 500);
  });
}

/**
 * Claude Code hooks for the GM session. They must be fast and quiet, so they
 * never start the service; if it is down there is nothing to say.
 */
export async function hookCommand(kind: 'inbox' | 'stop' | 'status', swarm: string): Promise<void> {
  const raw = await readStdin();
  let input: Record<string, unknown> = {};
  try {
    input = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    /* ignore */
  }
  if (!serviceRunning(swarm)) return;
  const c = new TmClient(swarm);
  try {
    await c.connect();
  } catch {
    return;
  }
  try {
    if (kind === 'inbox') {
      const items = await c.call<InboxItem[]>('inbox.read', { ack: true });
      if (items.length) {
        const act = items.filter((i) => ACTIONABLE.has(i.kind));
        const fyi = items.filter((i) => !ACTIONABLE.has(i.kind));
        const fmt = (list: InboxItem[]) => list.map((i) => `- [${i.kind}${i.taskId !== undefined ? ` #${i.taskId}` : ''}] ${i.text}`).join('\n');
        let msg = '';
        if (act.length) msg += `From the task manager, needs you (${act.length}):\n${fmt(act)}\n\nHandle these briefly, then return to the owner.\n`;
        if (fyi.length) msg += `${act.length ? '\n' : ''}For your awareness only, no action needed (${fyi.length}):\n${fmt(fyi)}\n\nMention these only if the owner would care.\n`;
        process.stdout.write(msg);
      }
      return;
    }
    if (kind === 'stop') {
      if (input.stop_hook_active === true) return;
      const items = (await c.call<InboxItem[]>('inbox.read', { ack: false })).filter((i) => ACTIONABLE.has(i.kind));
      if (items.length) {
        const summary = items.slice(0, 5).map((i) => `${i.kind}${i.taskId !== undefined ? ` on #${i.taskId}` : ''}`).join(', ');
        process.stdout.write(JSON.stringify({ decision: 'block', reason: `The task manager has ${items.length} item(s) that need you (${summary}). Read them with inbox_read, act on each briefly, then tell the owner in a line what you did.` }) + '\n');
      }
      return;
    }
    // status line: the profile's own HUD first (claude-hud when installed), then the swarm line.
    const cfg = loadSwarmConfig();
    if (cfg.hud) {
      const metaForHome = await c.call<BoardSnapshot>('snapshot');
      const prof = profileByName(metaForHome.meta.profile);
      const hud = prof ? runBaseStatusLine(raw, prof.home) : '';
      if (hud) process.stdout.write(hud + '\n');
    }
    const sid = typeof input.session_id === 'string' ? input.session_id : undefined;
    if (sid) await c.call('gm.session', { sessionId: sid }).catch(() => undefined);
    const snap = await c.call<BoardSnapshot>('snapshot');
    const cw = input.context_window as { used_percentage?: number } | undefined;
    const ctx = typeof cw?.used_percentage === 'number' ? Math.round(cw.used_percentage) : snap.gmContextPct;
    const parts = [cyan(snap.meta.name), dim(`· ${snap.meta.profile}${snap.quota?.plan ? ` ${snap.quota.plan}` : ''}`)];
    if (snap.quota && snap.quota.usedPercent >= 0) parts.push(dim(`· ${snap.quota.label} ${Math.round(snap.quota.usedPercent)}%`));
    if (ctx !== undefined) parts.push(dim(`· ctx ${ctx}%`));
    parts.push(snap.needYou ? yellow(`· ${snap.needYou} need you`) : dim('· nothing needs you'));
    if (snap.inboxUnread) parts.push(dim(`· inbox ${snap.inboxUnread}`));
    process.stdout.write(parts.join(' ') + '\n');
  } finally {
    c.close();
  }
}
