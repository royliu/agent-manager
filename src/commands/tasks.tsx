import React, { useEffect, useRef, useState } from 'react';
import { Box, render, Text, useApp, useInput } from 'ink';
import { spawn } from 'node:child_process';
import pc from 'picocolors';
import { openClient, type TmClient } from '../swarm/client.js';
import type { Agent, Question, Task } from '../swarm/model.js';
import { resolveSwarmName } from '../swarm/registry.js';
import { needsYou, statusLabel, type BoardSnapshot } from '../swarm/service.js';
import { bold, cyan, dim, padEnd, truncateVisible, usd, width } from '../ui/format.js';
import { noSwarm } from './gm.js';
import fs from 'node:fs';
import path from 'node:path';
import { AM_HOME } from '../core/paths.js';

const BOARD_PREFS = path.join(AM_HOME, 'board.json');
function loadPrefs(): { previewRows?: number; folded?: string[] } {
  try {
    return JSON.parse(fs.readFileSync(BOARD_PREFS, 'utf8')) as { previewRows?: number; folded?: string[] };
  } catch {
    return {};
  }
}
function savePrefs(p: { previewRows?: number; folded?: string[] }): void {
  try {
    fs.writeFileSync(BOARD_PREFS, JSON.stringify({ ...loadPrefs(), ...p }) + '\n');
  } catch {
    /* preferences are a convenience */
  }
}
/** `label [k]`: the key sits next to the thing it does. */
const k = (label: string, key: string) => `${dim(label)} ${dim('[')}${key}${dim(']')}`;

type Group = 'status' | 'agent' | 'eta';
type Sort = 'priority' | 'eta' | 'updated' | 'id';
type Mode = 'normal' | 'reply' | 'reject' | 'note' | 'filter' | 'confirm';

interface UiState {
  selId?: number;
  group: Group;
  sort: Sort;
  showDone: boolean;
  view: 'board' | 'detail';
  mode: Mode;
  input: string;
  filter: string;
  toast: string;
  scroll: number;
  /** Height of the description pane, in lines, including its divider. Drag the divider or press + / -. */
  previewRows: number;
  /** Folded sections in the list view, as `<grouping>:<key>`. */
  folded: string[];
  /** In the list view the cursor may rest on a section header instead of a task. */
  selHeader?: string;
}
interface Column {
  key: string;
  label: string;
  items: Task[];
}
interface Layout {
  kind: 'board' | 'list';
  cols: Column[];
  n: number;
  gap: number;
  cw: number;
  maxc: number;
  offsets: number[];
  firstCardRow: number;
  /** list view: line index → task id */
  lineTask: Map<number, number>;
  /** Screen row of the draggable divider above the description pane. */
  ruleRow: number;
  headerLines: number;
  /** list view: the cursor path, headers and visible tasks in order */
  listRows: Array<{ kind: 'header'; key: string } | { kind: 'task'; id: number }>;
  /** list view: line index → section key (for clicks on headers) */
  lineHeader: Map<number, string>;
}

const STATUS_COLS: Array<[string, string]> = [['open', 'OPEN'], ['plan', 'PLAN'], ['in_progress', 'IN PROGRESS'], ['blocked', 'BLOCKED'], ['review', 'REVIEW'], ['done', 'DONE']];
const ETA_COLS: Array<[string, string]> = [['past', 'PAST'], ['today', 'TODAY'], ['tomorrow', 'TOMORROW'], ['week', 'THIS WEEK'], ['later', 'LATER'], ['none', 'NO ETA']];

const fit = (s: string, w: number): string => {
  if (w <= 0) return '';
  const t = width(s) > w ? truncateVisible(s, w) : s;
  return padEnd(t, w);
};
const rep = (ch: string, n: number) => (n > 0 ? ch.repeat(n) : '');
const TZ = (() => {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
})();
const hm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
/** Clock time with the zone, e.g. 09:35 PDT. */
const hmz = (d: Date) => `${hm(d)}${TZ ? ` ${TZ}` : ''}`;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const dayName = (d: Date) => d.toLocaleDateString('en-US', { weekday: 'short' });
const dateLong = (d: Date) => `${dayName(d)} ${d.getDate()} ${d.toLocaleDateString('en-US', { month: 'short' })} ${hmz(d)}`;

function etaShort(t: Task): string {
  if (!t.eta) return pc.red('⚠ no eta');
  const d = new Date(t.eta);
  const days = Math.round((startOfDay(d).getTime() - startOfDay(new Date()).getTime()) / 864e5);
  if (days === 0) return `today ${hm(d)}`;
  if (days === 1) return `tomorrow ${hm(d)}`;
  if (days > 1 && days < 7) return dayName(d);
  if (days < 0) return `${d.getDate()} ${d.toLocaleDateString('en-US', { month: 'short' })}`;
  return `${d.getDate()} ${d.toLocaleDateString('en-US', { month: 'short' })}`;
}
function rel(ts: number): string {
  const ms = ts - Date.now();
  const past = ms < 0;
  const m = Math.round(Math.abs(ms) / 6e4);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  const s = d > 0 ? `${d}d ${h % 24}h` : h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
  return past ? `overdue ${s}` : `in ${s}`;
}
const active = (t: Task) => t.status !== 'done' && t.status !== 'cancelled';
const overdue = (t: Task) => !!t.eta && active(t) && t.eta < Date.now();
function bucket(t: Task): string {
  if (!t.eta) return 'none';
  const days = Math.round((startOfDay(new Date(t.eta)).getTime() - startOfDay(new Date()).getTime()) / 864e5);
  if (days < 0) return 'past';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days < 7) return 'week';
  return 'later';
}
/** 0-100 for the bars: the agent's own estimate when it gave one; otherwise a marked estimate from status and time. */
function progressOf(t: Task): { pct: number; estimated: boolean } {
  if (t.status === 'done') return { pct: 100, estimated: false };
  if (t.status === 'cancelled') return { pct: 0, estimated: false };
  if (t.progressPct !== undefined && (t.status === 'in_progress' || t.status === 'blocked' || t.status === 'review')) return { pct: t.progressPct, estimated: false };
  if (t.status === 'review') return { pct: 95, estimated: true };
  if (t.status === 'in_progress' || (t.status === 'blocked' && t.runs.length)) {
    const start = t.runs[0]?.startedAt ?? t.createdAt;
    if (t.eta && t.eta > start) return { pct: Math.max(5, Math.min(90, Math.round(((Date.now() - start) / (t.eta - start)) * 100))), estimated: true };
    return { pct: 10, estimated: true };
  }
  if (t.status === 'plan') return { pct: 5, estimated: true };
  return { pct: 0, estimated: true };
}
/** ○ ◔ ◑ ◕ ● for tight spaces. */
function pglyph(t: Task): string {
  const { pct, estimated } = progressOf(t);
  const g = pct >= 100 ? '●' : pct >= 75 ? '◕' : pct >= 50 ? '◑' : pct >= 25 ? '◔' : '○';
  const c = t.status === 'done' ? pc.green : t.status === 'blocked' ? pc.yellow : t.status === 'review' ? pc.magenta : pc.cyan;
  return `${c(g)} ${estimated ? dim(`~${pct}%`) : `${pct}%`}`;
}
function pbar(t: Task, w: number): string {
  const { pct, estimated } = progressOf(t);
  const f = Math.round((pct / 100) * w);
  const g = rep('█', f) + rep('░', w - f);
  const c = t.status === 'done' ? pc.green : t.status === 'blocked' ? pc.yellow : t.status === 'review' ? pc.magenta : pc.cyan;
  return `${c(g)} ${estimated ? dim(`~${pct}%`) : `${pct}%`}`;
}

function colour(status: Task['status']): (s: string) => string {
  switch (status) {
    case 'plan': return pc.blue;
    case 'in_progress': return pc.cyan;
    case 'blocked': return pc.yellow;
    case 'review': return pc.magenta;
    case 'done': return pc.green;
    case 'cancelled': return pc.red;
    default: return pc.dim;
  }
}
const openQ = (t: Task): Question | undefined => [...t.questions].reverse().find((q) => !q.answer);
const who = (to: string, gm: string) => (to === 'tm' ? 'task manager' : to === 'gm' ? gm : 'you');
function bar(p: number, w = 8): string {
  const f = Math.round((Math.max(0, Math.min(100, p)) / 100) * w);
  const g = rep('█', f) + rep('░', w - f);
  return p >= 85 ? pc.red(g) : p >= 60 ? pc.yellow(g) : pc.cyan(g);
}
function wrap(text: string, w: number): string[] {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let cur = '';
  for (const word of words) {
    if ((cur + ' ' + word).trim().length > w) {
      if (cur) out.push(cur);
      cur = word;
    } else cur = cur ? `${cur} ${word}` : word;
  }
  if (cur) out.push(cur);
  return out;
}

function matches(t: Task, filter: string): boolean {
  const f = filter.trim().toLowerCase();
  if (!f) return true;
  if (f.startsWith('#')) return String(t.id) === f.slice(1) || `#${t.id}`.startsWith(f);
  return `${t.title} ${t.agent ?? ''} ${t.status}`.toLowerCase().includes(f);
}
function sorter(sort: Sort): (a: Task, b: Task) => number {
  const eta = (a: Task, b: Task) => (a.eta === b.eta ? 0 : a.eta === undefined ? 1 : b.eta === undefined ? -1 : a.eta - b.eta);
  if (sort === 'priority') return (a, b) => a.priority - b.priority || eta(a, b) || a.id - b.id;
  if (sort === 'eta') return (a, b) => eta(a, b) || a.id - b.id;
  if (sort === 'updated') return (a, b) => b.updatedAt - a.updatedAt;
  return (a, b) => a.id - b.id;
}
function groups(snap: BoardSnapshot, st: UiState): Column[] {
  const list = snap.tasks.filter((t) => (st.showDone || active(t)) && matches(t, st.filter)).sort(sorter(st.sort));
  if (st.group === 'status') return STATUS_COLS.map(([k, label]) => ({ key: k, label, items: list.filter((t) => t.status === k || (k === 'done' && t.status === 'cancelled')) }));
  if (st.group === 'agent') return [...snap.team.map((a) => a.name), 'queued'].map((n) => ({ key: n, label: n.toUpperCase(), items: list.filter((t) => (t.agent ?? 'queued') === n) }));
  return ETA_COLS.map(([k, label]) => ({ key: k, label, items: list.filter((t) => bucket(t) === k) }));
}
function locate(cols: Column[], id?: number): { c: number; r: number } | undefined {
  if (id === undefined) return undefined;
  for (let c = 0; c < cols.length; c += 1) {
    const r = cols[c]!.items.findIndex((t) => t.id === id);
    if (r >= 0) return { c, r };
  }
  return undefined;
}

/** "friday-3" → "3" on this GM's board; other names stay as they are. */
function shortAgent(name: string | undefined, gm: string): string {
  if (!name) return '⋯';
  return name.startsWith(`${gm}-`) ? name.slice(gm.length + 1) : name;
}

function agentState(a: Agent, snap: BoardSnapshot, narrow = false): { text: string; next?: Task } {
  const gm = snap.meta.name;
  const t = a.taskId !== undefined ? snap.tasks.find((x) => x.id === a.taskId) : undefined;
  const label = narrow ? shortAgent(a.name, gm) : a.name;
  const ctx = (extra = '') => (a.contextPct >= snap.config.compactAt ? pc.yellow(`${narrow ? '' : 'ctx '}${a.contextPct}%${extra}`) : dim(`${narrow ? '' : 'ctx '}${a.contextPct}%${extra}`));
  if ((a.state === 'working' || a.state === 'compacting') && t) {
    const glyph = a.state === 'compacting' ? pc.yellow('●') : pc.cyan('●');
    const tail = a.state === 'compacting' ? (narrow ? pc.yellow(`${a.contextPct}%↻`) : pc.yellow(`ctx ${a.contextPct}% ↻ compacting`)) : ctx();
    return { text: narrow ? `${glyph}${label} #${t.id} ${tail}` : `${label} ${glyph} #${t.id} ${tail}` };
  }
  if (a.state === 'waiting') {
    const w = snap.tasks.find((x) => x.agent === a.name && x.status === 'blocked' && x.blockedOn?.kind === 'question');
    const to = w?.blockedOn?.kind === 'question' ? w.blockedOn.to : 'tm';
    const onYou = to === 'user';
    const tail = narrow ? (onYou ? pc.yellow('→you') : dim(`→${to === 'tm' ? 'tm' : gm}`)) : onYou ? pc.yellow('waiting on you') : dim(`waiting on ${who(to, gm)}`);
    return { text: narrow ? `${pc.yellow('⏸')}${label}${w ? ` #${w.id}` : ''} ${tail}` : `${label} ${pc.yellow('⏸')} ${w ? `#${w.id} ` : ''}${tail}` };
  }
  if (a.state === 'paused') return { text: narrow ? dim(`‖${label}`) : `${label} ${dim('‖ paused')}` };
  if (a.state === 'stalled') return { text: narrow ? pc.red(`!${label}`) : `${label} ${pc.red('! stalled')}` };
  const next = snap.tasks.filter((x) => x.agent === a.name && (x.status === 'open' || x.status === 'plan')).sort(sorter('priority'))[0];
  if (narrow) return { text: dim(`○${label}`) + (next ? dim(` #${next.id}`) : ''), next };
  return { text: `${label} ${dim('· idle')}${next ? dim(next.status === 'plan' && next.awaitingPlanApproval ? `, #${next.id} when you approve` : `, #${next.id} next`) : ''}`, next };
}

function statusGlyph(t: Task): string {
  switch (t.status) {
    case 'open': return '○';
    case 'plan': return '◇';
    case 'in_progress': return '●';
    case 'blocked': return t.blockedOn?.kind === 'question' ? '?' : '⏸';
    case 'review': return '✓';
    case 'done': return '✔';
    default: return '⊘';
  }
}

// ------------------------------------------------------------------ rendering
/** Left and right parts on one line; the right part is dropped in steps until it fits. */
function twoSided(left: string, rights: string[], W: number): string {
  for (const right of rights) {
    const gap = W - width(left) - width(right);
    if (gap >= 2) return left + rep(' ', gap) + right;
  }
  return truncateVisible(left, W);
}

/** Pack cells into as few lines as fit, separated by three spaces; never truncate a cell mid-word. */
function pack(cells: string[], W: number, indent: string, maxLines: number): string[] {
  const lines: string[] = [];
  let cur = indent;
  for (const c of cells) {
    const candidate = cur === indent ? cur + c : `${cur}   ${c}`;
    if (width(candidate) <= W || cur === indent) cur = candidate;
    else {
      lines.push(cur);
      cur = rep(' ', width(indent)) + c;
    }
  }
  lines.push(cur);
  if (lines.length > maxLines) {
    const hidden = cells.length - maxLines;
    return [...lines.slice(0, maxLines - 1), truncateVisible(lines[maxLines - 1]!, W - 8) + dim(` +${hidden}`)];
  }
  return lines;
}

function header(snap: BoardSnapshot, st: UiState, W: number): string[] {
  const gm = snap.meta.name;
  const ws = snap.workspace;
  const narrow = W < 110;
  const home = process.env.HOME ?? '';
  const dir = ws?.dir ?? snap.meta.dir;
  const place = narrow ? dir.split('/').filter(Boolean).pop() ?? dir : dir.replace(home, '~');
  const left = ` ${bold(gm)}${dim(` · ${place}${ws?.branch ? ` · ${ws.branch}` : ''}`)}`;
  const q = snap.quota;
  const quotaFull = q ? `${q.profile} ${dim(q.label)} ${q.usedPercent >= 0 ? `${bar(q.usedPercent)} ${Math.round(q.usedPercent)}%` : dim('no quota data')}` : snap.meta.profile;
  const sessions = dim(` · ${snap.team.length + 1} sessions${snap.gmContextPct !== undefined ? ` · ${gm} ctx ${snap.gmContextPct}%` : ''} `);
  const quotaShort = q && q.usedPercent >= 0 ? `${bar(q.usedPercent, 6)} ${Math.round(q.usedPercent)}% ` : `${snap.meta.profile} `;
  const l1 = twoSided(left, [quotaFull + sessions, quotaFull + ' ', quotaShort, ''], W);
  const strip = pack(snap.team.map((a) => agentState(a, snap, narrow).text), W, narrow ? ' ' : ` ${dim('team ')}`, narrow ? 2 : 1);
  const groupTabs = (['status', 'agent', 'eta'] as Group[]).map((g) => (g === st.group ? cyan(bold(`[${g}]`)) : dim(` ${g} `))).join('');
  const filterCell = st.mode === 'filter' ? `${st.filter}▏` : st.filter ? cyan(st.filter) : dim('—');
  const tabs = narrow
    ? ` ${k('', 'g')}${groupTabs} ${k('', 's')}${dim(st.sort)} ${k('', 'd')}${dim(st.showDone ? 'done' : 'no done')} ${k('', '/')}${filterCell}`
    : ` ${k('group', 'g')} ${groupTabs}   ${k('sort', 's')} ${st.sort}   ${k('done', 'd')} ${dim(st.showDone ? 'shown' : 'hidden')}   ${k('filter', '/')} ${filterCell}`;
  const total = snap.tasks.reduce((n, t) => n + t.usage.usd, 0);
  const need = snap.needYou ? pc.yellow(narrow ? `⚑ ${snap.needYou}` : `${snap.needYou} need you`) : dim(narrow ? '○' : 'nothing needs you');
  const l3 = narrow
    ? twoSided(tabs, [need + dim(` · ${snap.tasks.length} `), need + ' ', ''], W)
    : twoSided(tabs, [need + dim(` · ${gm} inbox ${snap.inboxUnread} · ${snap.tasks.length} tasks · ${usd(total)} `), need + dim(` · ${snap.tasks.length} tasks `), need + ' ', ''], W);
  return [l1, ...strip, l3, ''];
}

function preview(sel: Task | undefined, snap: BoardSnapshot, W: number, rows: number): string[] {
  const gm = snap.meta.name;
  const narrow = W < 110;
  const out: string[] = [];
  const handle = narrow ? dim(' ⇕ ') : dim(' ⇕ drag or [+/-] ');
  const ruleFor = (label: string) => {
    const left = pc.dim('──') + bold(label);
    const room = Math.max(0, W - width(left) - width(handle) - 2);
    return left + pc.dim(rep('─', room)) + handle + pc.dim('──');
  };
  if (!sel) {
    out.push(ruleFor(' '));
    out.push('');
    out.push(dim(snap.tasks.length ? '  no tasks match the filter · clear it [esc]' : `  no tasks yet · talk to ${gm} and they appear here`));
    while (out.length < rows) out.push('');
    return out.slice(0, rows);
  }
  out.push(ruleFor(` #${sel.id} `));
  const ag = snap.team.find((a) => a.name === sel.agent);
  const q = openQ(sel);
  const b = sel.blockedOn;

  // Title and status on one line (or two when narrow).
  const status = colour(sel.status)(`${statusGlyph(sel)} ${statusLabel(sel, gm)}`);
  if (narrow) {
    out.push(` ${bold(fit(sel.title, W - 2))}`);
    out.push(`  ${status}`);
  } else out.push(twoSided(` ${bold(sel.title)}`, [`${status} `, ''], W));

  // HUD: the numbers and the keys, pinned to the bottom of the pane.
  const hudParts: string[] = [];
  const hint: string[] = [];
  if (sel.status === 'in_progress' || (sel.status === 'blocked' && sel.runs.length) || sel.status === 'review') hudParts.push(narrow ? pglyph(sel) : pbar(sel, 14));
  else if (sel.status === 'done') hudParts.push(pc.green('● 100%'));
  else if (sel.status === 'plan') hudParts.push(pc.blue('◇ plan'));
  else hudParts.push(dim('○ not started'));
  hudParts.push(sel.eta ? `${dim('eta')} ${narrow ? rel(sel.eta) : `${dateLong(new Date(sel.eta))} ${dim(`(${rel(sel.eta)})`)}`}` : pc.red('⚠ no eta'));
  if (sel.agent) hudParts.push(`${sel.agent}${ag ? dim(` ctx ${ag.contextPct}%`) : ''}`);
  else hudParts.push(dim(sel.dispatchRequested ? 'queued for the next free agent' : 'no agent yet'));
  if (sel.usage.usd) hudParts.push(usd(sel.usage.usd));
  if (sel.runs.length > 1) hudParts.push(dim(`run ${sel.runs.length}`));
  if (sel.status === 'blocked' && b?.kind === 'question') hint.push(b.to === 'user' ? `${k('context', '⏎')} · ${k('reply', 'r')}` : dim(`waiting on ${who(b.to, gm)}`));
  else if (sel.status === 'blocked' && b?.kind === 'dependency') hint.push(`${dim(`waiting on #${b.taskId}`)} · ${k('assign', 'm')}`);
  else if (sel.status === 'blocked') hint.push(k('cancel', 'c'));
  else if (sel.status === 'review') hint.push(sel.reviewStage === 'user' ? `${k('approve', 'a')} · ${k('send back', 'x')}` : `${dim(`${gm} reviewing`)} · ${k('accept anyway', 'a')}`);
  else if (sel.status === 'plan' && sel.awaitingPlanApproval) hint.push(`${k('approve plan', 'a')} · ${k('send back', 'x')}`);
  else if (sel.status === 'in_progress') hint.push(`${k('stop', 'x')} · ${k('log', 't')}${sel.worktree ? ` · ${k('worktree', 'o')}` : ''}`);
  const hud = twoSided(' ' + hudParts.join(dim(' · ')), [hint.length ? hint.join(' · ') + ' ' : '', ''], W);

  // Live: what is happening right now. Timeline: what has been recorded.
  const live: string[] = [];
  if (sel.status === 'blocked' && b?.kind === 'question' && q) {
    for (const l of wrap(`? ${q.from} asks: ${q.question}`, W - 6).slice(0, 2)) live.push(`   ${pc.yellow(l)}`);
    live.push(`   ${dim(`if no answer: ${q.default}`)}`);
  } else if (sel.status === 'review' && sel.report) {
    for (const l of wrap(`✓ ${sel.agent ?? 'agent'}: ${sel.report.changed}`, W - 6).slice(0, 2)) live.push(`   ${pc.magenta(l)}`);
    live.push(`   ${dim(fit(`verified: ${sel.report.verified} · left: ${sel.report.left}`, W - 5))}`);
  } else if (sel.status === 'plan' && sel.awaitingPlanApproval) {
    const plan = [...sel.notes].reverse().find((n) => n.kind === 'plan');
    for (const l of wrap(`◇ plan by ${plan?.author ?? gm}: ${plan?.text ?? '(no plan note yet)'}`, W - 6).slice(0, 3)) live.push(`   ${pc.blue(l)}`);
  } else if (sel.status === 'in_progress' || sel.status === 'blocked') {
    for (const a of sel.activity.slice(0, 2)) live.push(`   ${dim(hmz(new Date(a.at)))}  ${fit(a.text, W - 16)}`);
    if (sel.progress) live.push(`   ${pc.cyan(fit(`${sel.agent ?? 'agent'}: ${sel.progress}`, W - 5))}${sel.progressAt ? dim(` ${hmz(new Date(sel.progressAt))}`) : ''}`);
    if (!live.length) live.push(`   ${dim('starting…')}`);
  } else if (sel.status === 'done' && sel.report) {
    live.push(`   ${pc.green(fit(`✔ ${sel.report.changed}`, W - 5))}`);
  }
  const timeline = [...sel.notes].reverse().map((n) => `   ${dim(hmz(new Date(n.at)))}  ${n.author === 'you' ? cyan(n.author) : n.author} ${(n.kind === 'checkpoint' ? pc.yellow : pc.dim)(n.kind)}  ${fit(n.text, W - 22 - n.author.length - n.kind.length)}`);

  // Fit: title (done) + description (2) + live (+header) + timeline (+header) + hud.
  const budget = rows - out.length - 1; // minus the hud
  const dl = wrap(sel.description || '(no description)', W - 4);
  const descRows = Math.min(dl.length, 2, Math.max(1, budget - 2));
  for (let i = 0; i < descRows; i += 1) out.push(`  ${i === descRows - 1 && dl.length > descRows ? truncateVisible(dl[i]!, W - 12) + dim(` ${k('full', '⏎')}`) : dl[i]!}`);
  let left = rows - out.length - 1;
  if (live.length && left >= 2) {
    out.push(dim(' live'));
    left -= 1;
    for (const l of live.slice(0, Math.max(1, Math.min(live.length, left - (timeline.length ? 2 : 0))))) {
      out.push(l);
      left -= 1;
    }
  }
  if (timeline.length && left >= 2) {
    out.push(dim(' timeline'));
    left -= 1;
    for (const l of timeline.slice(0, left)) out.push(l);
  }
  while (out.length < rows - 1) out.push('');
  out.push(hud);
  return out.slice(0, rows);
}

function footer(st: UiState, snap: BoardSnapshot, W: number, sel?: Task): string {
  const gm = snap.meta.name;
  if (st.mode === 'reply') return pc.yellow(`  reply to ${openQ(sel!)?.from ?? 'agent'} on #${sel?.id} › `) + `${st.input}▏` + dim('   ⏎ send · esc cancel');
  if (st.mode === 'reject') return sel && (sel.status === 'in_progress' || sel.status === 'blocked')
    ? pc.magenta(`  stop #${sel.id} · what should ${sel.agent ?? 'the agent'} do instead? › `) + `${st.input}▏` + dim('   ⏎ alone just stops · esc cancel')
    : pc.magenta(`  send #${sel?.id} back with feedback › `) + `${st.input}▏` + dim('   ⏎ send · esc cancel');
  if (st.mode === 'note') return cyan(`  note on #${sel?.id} › `) + `${st.input}▏` + dim('   ⏎ save · esc cancel');
  if (st.mode === 'filter') return cyan('  filter › ') + `${st.filter}▏` + dim('   text or #id · ⏎ keep · esc clear');
  if (st.mode === 'confirm') return pc.red(`  ${st.input}  `) + dim('y confirm · any other key aborts');
  const narrow = W < 110;
  const sep = narrow ? ' · ' : '  ';
  if (st.view === 'detail') {
    const keys = narrow
      ? [k('reply', 'r'), k('approve', 'a'), k('back', 'x'), k('note', 'n'), k('cancel', 'c'), k('close', 'esc')]
      : [k('reply', 'r'), k('approve', 'a'), k('stop / send back', 'x'), k('note', 'n'), k('reassign', 'm'), k('priority', 'p'), k('log', 't'), k('worktree', 'o'), k('cancel', 'c'), k('scroll', '↑↓'), k('back', 'esc')];
    return '  ' + keys.join(sep);
  }
  const keys = narrow
    ? [k('open/fold', '⏎'), k('sections', '←→'), k('reply', 'r'), k('approve', 'a'), k('stop', 'x'), k('note', 'n'), k('quit', 'q')]
    : [k('move', '↑↓←→'), k('open', '⏎'), k('reply', 'r'), k('approve', 'a'), k('stop / send back', 'x'), k('note', 'n'), k('priority', 'p'), k('cancel', 'c'), k('pane', '+/-'), k('pause all', 'K'), k('quit', 'q')];
  return '  ' + keys.join(sep) + (snap.inboxUnread && !narrow ? dim(`  · ${gm} has ${snap.inboxUnread} unread`) : '');
}

/** Pane height clamped to what the screen can give: never less than 4 lines, never starving the task list. */
function paneRows(st: UiState, H: number, headerLines: number, W: number): number {
  const avail = H - headerLines - 3; // rows left for list + pane once the header, toast and footer are placed
  // Narrow terminals keep at least half of the room for the list; wide ones at least 40%.
  const max = Math.max(4, Math.floor(avail * (W < 110 ? 0.5 : 0.6)));
  return Math.max(4, Math.min(max, st.previewRows));
}

function renderBoard(snap: BoardSnapshot, st: UiState, W: number, H: number): { lines: string[]; layout: Layout } {
  const cols = groups(snap, st);
  const pos = locate(cols, st.selId);
  const sel = snap.tasks.find((t) => t.id === st.selId);
  const lines = header(snap, st, W);
  const headerLines = lines.length;
  const firstCardRow = headerLines + 2;
  const n = cols.length;
  const gap = 2;
  const cw = Math.floor((W - 2 - gap * (n - 1)) / n);
  const previewRows = paneRows(st, H, headerLines, W);
  const maxc = Math.max(2, Math.floor((H - headerLines - 2 - 1 - previewRows - 2) / 2));
  const offsets = cols.map((_, c) => (pos && pos.c === c && pos.r >= maxc ? pos.r - maxc + 1 : 0));
  let hdr = '  ';
  let und = '  ';
  cols.forEach((col, c) => {
    if (c) {
      hdr += rep(' ', gap);
      und += rep(' ', gap);
    }
    const cnt = String(col.items.length);
    const lab = fit(col.label, cw - cnt.length);
    hdr += (pos?.c === c ? bold(lab) : dim(lab)) + dim(cnt);
    und += pc.dim(rep('─', cw));
  });
  lines.push(hdr, und);
  for (let row = 0; row < maxc; row += 1) {
    for (let half = 0; half < 2; half += 1) {
      let line = '  ';
      cols.forEach((col, c) => {
        if (c) line += rep(' ', gap);
        const idx = row + offsets[c]!;
        const t = col.items[idx];
        const isSel = !!t && pos?.c === c && pos.r === idx;
        const more = idx === offsets[c]! + maxc - 1 && col.items.length > offsets[c]! + maxc;
        if (!t) {
          line += rep(' ', cw);
          return;
        }
        if (half === 0) {
          const body = fit(`#${t.id} ${t.title}`, cw - 1);
          line += colour(t.status)(t.status === 'cancelled' ? '⊘' : '▎') + (isSel ? pc.inverse(bold(body)) : body);
        } else if (more && !isSel) {
          line += dim(fit(`  +${col.items.length - (offsets[c]! + maxc - 1)} more`, cw));
        } else {
          const b = t.blockedOn;
          const pre = t.status === 'blocked' && b?.kind === 'question' ? pc.yellow('? ') : overdue(t) ? pc.red('! ') : t.status === 'review' ? pc.magenta('✓ ') : t.status === 'plan' && t.awaitingPlanApproval ? pc.blue('◇ ') : '  ';
          const who = t.agent ? `@${shortAgent(t.agent, snap.meta.name)}` : '⋯';
          if (t.status === 'in_progress' || t.status === 'review' || (t.status === 'blocked' && t.runs.length)) {
            const prog = cw >= 34 ? pbar(t, Math.min(8, cw - 26)) : pglyph(t);
            line += pre + prog + dim(fit(` · ${who} · ${etaShort(t)}`, cw - 2 - width(prog)));
          } else line += pre + dim(fit(`${who} · ${etaShort(t)}`, cw - 2));
        }
      });
      lines.push(line);
    }
  }
  lines.push('');
  const ruleRow = lines.length;
  lines.push(...preview(sel, snap, W, previewRows));
  return { lines, layout: { kind: 'board', cols, n, gap, cw, maxc, offsets, firstCardRow, lineTask: new Map(), ruleRow, headerLines, listRows: [], lineHeader: new Map() } };
}

const foldKey = (st: UiState, key: string) => `${st.group}:${key}`;

function renderList(snap: BoardSnapshot, st: UiState, W: number, H: number): { lines: string[]; layout: Layout } {
  const cols = groups(snap, st);
  const sel = snap.tasks.find((t) => t.id === st.selId);
  const lines = header(snap, st, W);
  const lineTask = new Map<number, number>();
  const lineHeader = new Map<number, string>();
  const body: string[] = [];
  const rows: Layout['listRows'] = [];
  let selLine = -1;
  for (const col of cols) {
    const folded = st.folded.includes(foldKey(st, col.key));
    const onHeader = st.selHeader === col.key;
    const glyph = folded ? '▸' : '▾';
    const label = ` ${glyph} ${col.label} ${dim(String(col.items.length))}${folded && col.items.length ? dim(`  ${col.items.map((t) => `#${t.id}`).join(' ')}`) : ''}`;
    if (onHeader) selLine = body.length;
    body.push(onHeader ? pc.inverse(fit(label, W - 1)) : label);
    rows.push({ kind: 'header', key: col.key });
    if (folded) continue;
    for (const t of col.items) {
      const isSel = !st.selHeader && t.id === st.selId;
      const bar = t.status === 'in_progress' || t.status === 'review' || (t.status === 'blocked' && t.runs.length) ? (W >= 100 ? pbar(t, 10) : pglyph(t)) + ' ' : '';
      const meta = `${t.agent ? `@${shortAgent(t.agent, snap.meta.name)}` : '⋯'} · ${etaShort(t)}`;
      const title = fit(`#${t.id} ${t.title}`, W - 6 - width(meta) - width(bar) - 2);
      const line = '  ' + colour(t.status)('▎') + (isSel ? pc.inverse(bold(title)) : title) + '  ' + bar + dim(meta);
      if (isSel) selLine = body.length;
      body.push(line);
      rows.push({ kind: 'task', id: t.id });
    }
  }
  const headerLines = lines.length;
  const previewRows = paneRows(st, H, headerLines, W);
  const room = Math.max(3, H - headerLines - previewRows - 3);
  let start = 0;
  if (selLine >= room) start = selLine - room + 1;
  const slice = body.slice(start, start + room);
  slice.forEach((_, i) => {
    const r = rows[start + i];
    if (r?.kind === 'task') lineTask.set(lines.length + i, r.id);
    else if (r?.kind === 'header') lineHeader.set(lines.length + i, r.key);
  });
  lines.push(...slice);
  while (lines.length < headerLines + room) lines.push('');
  lines.push('');
  const ruleRow = lines.length;
  if (st.selHeader) {
    const col = cols.find((c) => c.key === st.selHeader);
    lines.push(...sectionPane(col, snap, st, W, previewRows));
  } else lines.push(...preview(sel, snap, W, previewRows));
  return { lines, layout: { kind: 'list', cols, n: 1, gap: 0, cw: W, maxc: room, offsets: [start], firstCardRow: headerLines, lineTask, ruleRow, headerLines, listRows: rows, lineHeader } };
}

/** The pane when the cursor rests on a section header: what is in it, and how to fold it. */
function sectionPane(col: Column | undefined, snap: BoardSnapshot, st: UiState, W: number, rows: number): string[] {
  const out: string[] = [];
  const handle = W < 110 ? dim(' ⇕ ') : dim(' ⇕ drag or [+/-] ');
  const left = pc.dim('──') + bold(` ${col?.label ?? ''} `);
  out.push(left + pc.dim(rep('─', Math.max(0, W - width(left) - width(handle) - 2))) + handle + pc.dim('──'));
  if (!col) return out.concat(Array(Math.max(0, rows - 1)).fill(''));
  const folded = st.folded.includes(foldKey(st, col.key));
  out.push(` ${bold(col.label)}  ${dim(`${col.items.length} task${col.items.length === 1 ? '' : 's'}`)}${folded ? dim('  · folded') : ''}`);
  if (!col.items.length) out.push(dim('   nothing here right now'));
  for (const t of col.items.slice(0, Math.max(0, rows - 4))) out.push(`   ${dim(`#${t.id}`)} ${fit(t.title, W - 40)} ${dim(`${t.agent ? `@${shortAgent(t.agent, snap.meta.name)}` : '⋯'} · ${etaShort(t)}`)}`);
  while (out.length < rows - 1) out.push('');
  out.push(twoSided(` ${dim(`${col.items.reduce((n, t) => n + t.usage.usd, 0) ? usd(col.items.reduce((n, t) => n + t.usage.usd, 0)) + ' · ' : ''}${col.items.filter(needsYou).length ? pc.yellow(`${col.items.filter(needsYou).length} need you`) : dim('nothing needs you')}`)}`, [`${k(folded ? 'unfold' : 'fold', '⏎')} · ${k('sections', '←→')} · ${k('tasks', '↑↓')} `, ''], W));
  return out.slice(0, rows);
}

function renderDetail(t: Task, snap: BoardSnapshot, W: number): string[] {
  const gm = snap.meta.name;
  const L: string[] = [];
  const ag = snap.team.find((a) => a.name === t.agent);
  const head = ` ${dim('← esc')}  ${bold(`#${t.id} ${t.title}`)}`;
  const stl = colour(t.status)(bold(statusLabel(t, gm)));
  L.push(head + rep(' ', Math.max(1, W - width(head) - width(stl) - 2)) + stl);
  L.push(pc.dim(rep('─', W)));
  L.push(dim(` P${t.priority} · ${t.eta ? `eta ${dateLong(new Date(t.eta))} (${rel(t.eta)})` : 'no eta'} · created ${hmz(new Date(t.createdAt))} by ${t.createdBy}${t.ask ? ' from the ask: ' : ''}`) + (t.ask ? fit(`“${t.ask}”`, Math.max(10, W - 60)) : ''));
  if (t.parentId !== undefined) {
    const p = snap.tasks.find((x) => x.id === t.parentId);
    if (p) L.push(dim(` part of #${p.id} ${p.title}${p.ask ? ' · ask: ' : ''}`) + (p.ask ? fit(`“${p.ask}”`, Math.max(10, W - 50)) : ''));
  }
  L.push(t.agent ? ` ${t.agent}${ag ? ` · ${ag.provider === 'codex' ? 'Codex' : 'Claude Code'}${(ag.effectiveModel ?? ag.model) ? ` · ${ag.effectiveModel ?? ag.model}` : ''} · profile ${ag.profile}` : ''}${t.runs.length ? ` · run ${t.runs.length}` : ''} · ${t.usage.tokens.toLocaleString()} tokens · ${usd(t.usage.usd)} list-price${ag ? ` · ctx ${ag.contextPct}%${ag.state === 'compacting' ? ' ↻ compacting' : ''}` : ''}` : dim(' no agent yet'));
  if (t.branch) L.push(dim(` branch ${t.branch} · worktree ${t.worktree}`));
  L.push('');
  L.push(dim(' DESCRIPTION'));
  for (const l of wrap(t.description || '(none)', W - 6)) L.push(`   ${l}`);
  L.push(dim(' DISPATCH'));
  const node = (prefix: string, x: Task) => {
    const a = snap.team.find((y) => y.name === x.agent);
    return `${prefix}${fit(`#${x.id} ${x.title}`, Math.min(58, W - 60))}${dim(fit(x.agent ? `${x.agent}${a ? ` · ctx ${a.contextPct}%` : ''}` : 'queued', 24))}${colour(x.status)(statusLabel(x, gm))}`;
  };
  L.push(node('   ', t));
  const kids = snap.tasks.filter((k) => k.parentId === t.id);
  kids.forEach((k, i) => L.push(node(`     ${i === kids.length - 1 ? '└─ ' : '├─ '}`, k)));
  for (const d of t.dependsOn) {
    const x = snap.tasks.find((y) => y.id === d);
    if (x) L.push(`     ${dim('waits for   ')}${fit(`#${x.id} ${x.title}`, Math.min(48, W - 70))}${dim(fit(x.agent ?? 'queued', 24))}${colour(x.status)(statusLabel(x, gm))}`);
  }
  for (const x of snap.tasks.filter((y) => y.dependsOn.includes(t.id))) L.push(`     ${dim('unblocks    ')}${fit(`#${x.id} ${x.title}`, Math.min(48, W - 70))}${dim(fit(x.agent ?? 'queued', 24))}${colour(x.status)(statusLabel(x, gm))}`);
  for (const r of t.runs) {
    const ex = r.exit ? `${r.exit}${r.exitNote ? ` · ${r.exitNote}` : ''}` : 'working';
    L.push(`   ${dim(`run ${r.n}  `)}${hm(new Date(r.startedAt))} → ${r.endedAt ? hm(new Date(r.endedAt)) : 'now'}  ${dim(fit(`${r.agent}${r.sessionId ? ` · session ${r.sessionId.slice(0, 8)}` : ''}`, 34))}${(r.exit === 'done' ? pc.green : r.exit ? pc.yellow : pc.cyan)(fit(ex, 44))}${dim(`${usd(r.usd)}${r.contextPct !== undefined ? ` · ctx ${r.contextPct}%` : ''}`)}`);
  }
  if (!t.runs.length && !kids.length) L.push(dim('   not started'));
  if (t.runs.length || t.progressPct !== undefined) {
    L.push(dim(' PROGRESS'));
    L.push(`   ${pbar(t, 30)}${t.eta ? dim(` · eta ${dateLong(new Date(t.eta))} (${rel(t.eta)})`) : ''}${t.progressAt ? dim(` · last update ${hmz(new Date(t.progressAt))}`) : ''}`);
    if (t.progress) L.push(`   ${pc.cyan(fit(`${t.agent ?? 'agent'}: ${t.progress}`, W - 5))}`);
    if (t.activity.length) {
      L.push(dim(' ACTIVITY') + dim('  what the agent has been doing, newest first'));
      for (const a of t.activity.slice(0, 6)) L.push(`   ${dim(hmz(new Date(a.at)))}  ${fit(a.text, W - 16)}`);
    }
  }
  L.push(dim(' NOTES'));
  if (!t.notes.length) L.push(dim('   none yet · n to add'));
  for (const n of t.notes.slice(-6)) L.push(`   ${dim(hmz(new Date(n.at)))}  ${n.author === 'you' ? cyan(fit(n.author, 13)) : fit(n.author, 13)}${(n.kind === 'checkpoint' ? pc.yellow : pc.dim)(fit(n.kind, 12))}${fit(n.text, W - 36)}`);
  const q = openQ(t);
  if (q) {
    L.push(dim(' QUESTION') + dim(`  from ${q.from} · ${hm(new Date(q.askedAt))} · went to task manager${q.path.map((h) => ` → ${who(h.to, gm)}`).join('')}`));
    const lab = (k: string, txt: string, c: (s: string) => string = (s) => s) => {
      wrap(txt, W - 26).slice(0, 3).forEach((l, i) => L.push(`   ${dim(fit(i ? '' : k, 20))}${c(fit(l, W - 26))}`));
    };
    lab('About', q.about);
    lab('Known', q.known);
    lab('Question', q.question, pc.yellow);
    if (q.options.length) lab('Options', q.options.join('   '));
    lab('If no answer', q.default);
    for (const h of q.path) if (h.note) lab(h.to === 'user' ? `${gm}'s view` : who(h.to, gm), h.note);
    L.push(`   ${fit('', 20)}${pc.yellow(t.blockedOn?.kind === 'question' && t.blockedOn.to === 'user' ? 'r reply' : `waiting on ${who(q.to, gm)}`)}`);
  }
  for (const x of t.questions.filter((y) => y.answer).slice(-2)) L.push(`   ${dim(hm(new Date(x.askedAt)))}  ${fit(`${x.from} asked: ${x.question}`, Math.min(70, W - 50))}${pc.green(fit(`→ ${x.answeredBy} answered: ${x.answer}`, W - 84))}`);
  if (t.report) L.push(dim(' REPORT') + `  ${fit(`changed: ${t.report.changed} · verified: ${t.report.verified} · left: ${t.report.left}${t.report.watch ? ` · watch: ${t.report.watch}` : ''}`, W - 9)}`);
  return L;
}

// ------------------------------------------------------------------ component
const ALT_ON = '\x1b[?1049h\x1b[H';
const ALT_OFF = '\x1b[?1049l';
const MOUSE_ON = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';
const MOUSE_OFF = '\x1b[?1006l\x1b[?1002l\x1b[?1000l';

/** Terminal size, with an override for hosts that report the wrong one (AM_BOARD_SIZE=cols x rows or --size). */
function termSize(override?: { W: number; H: number }): { W: number; H: number } {
  if (override) return override;
  // Ask the terminal directly: `rows`/`columns` are cached and only refresh on a resize signal, which some hosts never send.
  try {
    const [cols, rows] = process.stdout.getWindowSize();
    if (cols > 0 && rows > 0) return { W: cols, H: rows };
  } catch {
    /* not a tty */
  }
  return { W: process.stdout.columns || 120, H: process.stdout.rows || 40 };
}

const Board: React.FC<{ swarm: string; group: Group; sizeOverride?: { W: number; H: number } }> = ({ swarm, group, sizeOverride }) => {
  const { exit } = useApp();
  const [snap, setSnap] = useState<BoardSnapshot>();
  const [st, setSt] = useState<UiState>({ group, sort: 'priority', showDone: true, view: 'board', mode: 'normal', input: '', filter: '', toast: '', scroll: 0, previewRows: loadPrefs().previewRows ?? Math.max(8, Math.round((process.stdout.rows || 40) * 0.35)), folded: loadPrefs().folded ?? [] });
  const dragging = useRef(false);
  const setPane = (rows: number) => {
    const H = (process.stdout.rows || 40) - 1;
    const clamped = Math.max(4, Math.min(H - 10, rows));
    setSt((p) => ({ ...p, previewRows: clamped }));
    savePrefs({ previewRows: clamped });
  };
  const [size, setSize] = useState(termSize(sizeOverride));
  const [events, setEvents] = useState<Array<{ at: number; actor: string; text: string }>>([]);
  const client = useRef<TmClient>();
  const layout = useRef<Layout>();
  const lastNeed = useRef(0);
  const toastTimer = useRef<NodeJS.Timeout>();
  const lastClick = useRef<{ at: number; id: number }>();

  const toast = (msg: string) => {
    setSt((s) => ({ ...s, toast: msg }));
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setSt((s) => ({ ...s, toast: '' })), 4000);
  };

  const reconnecting = useRef(false);
  const refresh = async () => {
    const c = client.current;
    if (!c) return;
    try {
      const s = await c.call<BoardSnapshot>('snapshot');
      setSnap(s);
      if (s.needYou > lastNeed.current) process.stdout.write('\x07');
      lastNeed.current = s.needYou;
    } catch {
      // The task manager went away (am stop, a crash): bring it back and resubscribe.
      if (reconnecting.current) return;
      reconnecting.current = true;
      try {
        c.close();
        const n = await openClient(swarm);
        await n.call('subscribe');
        n.onPush(() => void refresh());
        client.current = n;
        toast('task manager restarted');
      } catch {
        toast(pc.red('task manager unreachable; retrying'));
      } finally {
        reconnecting.current = false;
      }
    }
  };

  useEffect(() => {
    let alive = true;
    process.stdout.write(ALT_ON + MOUSE_ON);
    const onResize = () => {
      process.stdout.write('\x1b[2J\x1b[H');
      setSize(termSize(sizeOverride));
    };
    // Some hosts never send a resize event; notice a changed size anyway.
    const sizePoll = setInterval(() => {
      const now = termSize(sizeOverride);
      setSize((prev) => (prev.W === now.W && prev.H === now.H ? prev : (process.stdout.write('\x1b[2J\x1b[H'), now)));
    }, 1000);
    process.stdout.on('resize', onResize);
    let debounce: NodeJS.Timeout | undefined;
    (async () => {
      const c = await openClient(swarm);
      if (!alive) return c.close();
      client.current = c;
      await c.call('subscribe');
      c.onPush(() => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => void refresh(), 120);
      });
      await refresh();
    })().catch((e) => {
      process.stdout.write(MOUSE_OFF + ALT_OFF);
      console.error(`${pc.red('✗')} ${e instanceof Error ? e.message : String(e)}`);
      exit();
    });
    const poll = setInterval(() => void refresh(), 10_000);
    // Mouse: wheel scrolls, click selects, double-click opens.
    const onData = (chunk: Buffer | string) => {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const re = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(s))) {
        const b = Number(m[1]);
        const x = Number(m[2]) - 1;
        const y = Number(m[3]) - 1;
        const lay = layout.current;
        // Divider drag: press on the rule, move with the button held, release anywhere.
        if (m[4] === 'm') {
          dragging.current = false;
          continue;
        }
        if (b === 0 && lay && stRef.current.view === 'board' && Math.abs(y - lay.ruleRow) <= 0) {
          dragging.current = true;
          continue;
        }
        if (b === 32 && dragging.current) {
          const H = (process.stdout.rows || 40) - 1;
          setPane(H - 2 - y);
          continue;
        }
        if (b === 64 || b === 65) {
          const t = taskAt(x, y);
          setSt((prev) => (prev.view === 'detail' ? { ...prev, scroll: Math.max(0, prev.scroll + (b === 65 ? 2 : -2)) } : prev));
          if (t) setSt((prev) => ({ ...prev, selId: t }));
          moveSel(0, b === 65 ? 1 : -1);
        } else if (b === 0) {
          const hk = layout.current?.kind === 'list' ? layout.current.lineHeader.get(y) : undefined;
          if (hk !== undefined) {
            setSt((prev) => ({ ...prev, selHeader: hk }));
            toggleFold(hk);
            continue;
          }
          const t = taskAt(x, y);
          if (t !== undefined) {
            const now = Date.now();
            const dbl = lastClick.current && lastClick.current.id === t && now - lastClick.current.at < 400;
            lastClick.current = { at: now, id: t };
            setSt((prev) => ({ ...prev, selId: t, selHeader: undefined, view: dbl ? 'detail' : prev.view, scroll: 0 }));
          }
        }
      }
    };
    process.stdin.on('data', onData);
    return () => {
      alive = false;
      clearInterval(poll);
      clearInterval(sizePoll);
      process.stdout.off('resize', onResize);
      process.stdin.off('data', onData);
      client.current?.close();
      process.stdout.write(MOUSE_OFF + ALT_OFF);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const snapRef = useRef<BoardSnapshot>();
  snapRef.current = snap;
  const stRef = useRef(st);
  stRef.current = st;

  function taskAt(x: number, y: number): number | undefined {
    const lay = layout.current;
    if (!lay || stRef.current.view !== 'board') return undefined;
    if (lay.kind === 'list') return lay.lineTask.get(y);
    const cx = x - 2;
    const r = y - lay.firstCardRow;
    if (cx < 0 || r < 0 || r >= lay.maxc * 2) return undefined;
    const ci = Math.floor(cx / (lay.cw + lay.gap));
    if (cx - ci * (lay.cw + lay.gap) >= lay.cw) return undefined;
    const col = lay.cols[ci];
    return col?.items[Math.floor(r / 2) + (lay.offsets[ci] ?? 0)]?.id;
  }

  function moveSel(dc: number, dr: number): void {
    const s = snapRef.current;
    if (!s) return;
    setSt((prev) => {
      const cols = groups(s, prev);
      let pos = locate(cols, prev.selId);
      if (!pos && layout.current?.kind !== 'list') {
        const c = cols.findIndex((k) => k.items.length);
        return c >= 0 ? { ...prev, selId: cols[c]!.items[0]!.id } : prev;
      }
      if (!pos) pos = { c: 0, r: 0 };
      if (layout.current?.kind === 'list') {
        const rows = layout.current.listRows;
        let i = prev.selHeader ? rows.findIndex((r) => r.kind === 'header' && r.key === prev.selHeader) : rows.findIndex((r) => r.kind === 'task' && r.id === prev.selId);
        if (i < 0) i = 0;
        if (dr) {
          const j = Math.max(0, Math.min(rows.length - 1, i + dr));
          const r = rows[j]!;
          return r.kind === 'header' ? { ...prev, selHeader: r.key } : { ...prev, selHeader: undefined, selId: r.id };
        }
        if (dc) {
          // ← / → walk the section headers
          let j = i;
          do j += dc;
          while (j >= 0 && j < rows.length && rows[j]!.kind !== 'header');
          if (j < 0 || j >= rows.length) return prev;
          return { ...prev, selHeader: (rows[j] as { key: string }).key };
        }
      }
      if (dr) {
        const col = cols[pos.c]!;
        pos = { c: pos.c, r: Math.max(0, Math.min(col.items.length - 1, pos.r + dr)) };
      }
      if (dc) {
        let c = pos.c;
        do c += dc;
        while (c >= 0 && c < cols.length && !cols[c]!.items.length);
        if (c < 0 || c >= cols.length) return prev;
        pos = { c, r: Math.min(pos.r, cols[c]!.items.length - 1) };
      }
      return { ...prev, selId: cols[pos.c]!.items[pos.r]!.id };
    });
  }

  function toggleFold(key: string): void {
    setSt((p) => {
      const fk = foldKey(p, key);
      const folded = p.folded.includes(fk) ? p.folded.filter((x) => x !== fk) : [...p.folded, fk];
      savePrefs({ folded });
      return { ...p, folded };
    });
  }

  async function act(fn: (c: TmClient, sel: Task) => Promise<string>): Promise<void> {
    const c = client.current;
    const sel = snapRef.current?.tasks.find((t) => t.id === stRef.current.selId);
    if (!c || !sel) return;
    try {
      toast(await fn(c, sel));
    } catch (e) {
      toast(pc.red(e instanceof Error ? e.message : String(e)));
    }
    await refresh();
  }

  function submit(): void {
    const s = stRef.current;
    const text = s.input.trim();
    setSt((p) => ({ ...p, mode: 'normal', input: '' }));
    const selNow = snapRef.current?.tasks.find((t) => t.id === s.selId);
    if (s.mode === 'reject' && !text && selNow && (selNow.status === 'in_progress' || selNow.status === 'blocked')) {
      void act(async (c, sel) => { await c.call<Task>('task.reject', { id: sel.id, feedback: '', by: 'you' }); return `stopped ${sel.agent ?? 'the agent'} on #${sel.id} · on hold · its files stay in place`; });
      return;
    }
    if (!text) return;
    if (s.mode === 'reply') void act(async (c, sel) => { const t = await c.call<Task>('task.answer', { id: sel.id, answer: text, by: 'you' }); return `answer saved as a note on #${t.id} · ${t.agent ?? 'the agent'} continues with it`; });
    if (s.mode === 'reject') void act(async (c, sel) => { const t = await c.call<Task>('task.reject', { id: sel.id, feedback: text, by: 'you' }); return sel.status === 'review' || sel.status === 'plan' ? `#${t.id} sent back · ${t.agent ?? 'the agent'} continues with your feedback` : `stopped and redirected ${t.agent ?? 'the agent'} on #${t.id}`; });
    if (s.mode === 'note') void act(async (c, sel) => { await c.call('task.note', { id: sel.id, author: 'you', kind: 'context', text }); return `note added to #${sel.id}`; });
  }

  useInput((input, key) => {
    const s = stRef.current;
    const sel = snapRef.current?.tasks.find((t) => t.id === s.selId);
    const gm = snapRef.current?.meta.name ?? 'gm';
    // Mouse sequences arrive here too; ignore anything that is not a real key.
    if (input.length > 1 && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow && !key.return && !key.escape) return;
    if (s.mode === 'filter') {
      if (key.escape) setSt((p) => ({ ...p, filter: '', mode: 'normal' }));
      else if (key.return) setSt((p) => ({ ...p, mode: 'normal' }));
      else if (key.backspace || key.delete) setSt((p) => ({ ...p, filter: p.filter.slice(0, -1) }));
      else if (input && !key.ctrl && !key.meta) setSt((p) => ({ ...p, filter: p.filter + input }));
      return;
    }
    if (s.mode === 'reply' || s.mode === 'reject' || s.mode === 'note') {
      if (key.escape) setSt((p) => ({ ...p, mode: 'normal', input: '' }));
      else if (key.return) submit();
      else if (key.backspace || key.delete) setSt((p) => ({ ...p, input: p.input.slice(0, -1) }));
      else if (input && !key.ctrl && !key.meta) setSt((p) => ({ ...p, input: p.input + input }));
      return;
    }
    if (s.mode === 'confirm') {
      setSt((p) => ({ ...p, mode: 'normal', input: '' }));
      if (input === 'y') {
        if (s.input.startsWith('pause')) void act(async (c) => { await c.call('team.pause', { resume: false }); return 'every agent paused · K again to resume'; });
        else void act(async (c, x) => { await c.call('task.cancel', { id: x.id, by: 'you' }); return `#${x.id} cancelled`; });
      } else toast('not done');
      return;
    }
    if (key.escape) {
      if (s.view === 'detail') setSt((p) => ({ ...p, view: 'board', scroll: 0 }));
      else if (s.filter) setSt((p) => ({ ...p, filter: '' }));
      return;
    }
    if (key.upArrow) return s.view === 'detail' ? setSt((p) => ({ ...p, scroll: Math.max(0, p.scroll - 1) })) : moveSel(0, -1);
    if (key.downArrow) return s.view === 'detail' ? setSt((p) => ({ ...p, scroll: p.scroll + 1 })) : moveSel(0, 1);
    if (key.leftArrow) return s.view === 'board' ? moveSel(-1, 0) : undefined;
    if (key.rightArrow) return s.view === 'board' ? moveSel(1, 0) : undefined;
    if ((key.return || input === ' ') && s.view === 'board' && s.selHeader) return toggleFold(s.selHeader);
    if (key.return) return sel && s.view === 'board' ? setSt((p) => ({ ...p, view: 'detail', scroll: 0 })) : undefined;
    switch (input) {
      case 'q':
        if (s.view === 'detail') return setSt((p) => ({ ...p, view: 'board' }));
        return exit();
      case 'g': return setSt((p) => ({ ...p, group: p.group === 'status' ? 'agent' : p.group === 'agent' ? 'eta' : 'status' }));
      case 's': return setSt((p) => ({ ...p, sort: p.sort === 'priority' ? 'eta' : p.sort === 'eta' ? 'updated' : p.sort === 'updated' ? 'id' : 'priority' }));
      case 'd': return setSt((p) => ({ ...p, showDone: !p.showDone }));
      case '/': return s.view === 'board' ? setSt((p) => ({ ...p, mode: 'filter' })) : undefined;
      case 'r':
        if (!sel) return;
        if (sel.status === 'blocked' && sel.blockedOn?.kind === 'question') {
          if (sel.blockedOn.to === 'user') return setSt((p) => ({ ...p, mode: 'reply', input: '' }));
          return toast(`#${sel.id} is waiting on ${who(sel.blockedOn.to, gm)}; it reaches you only if they cannot answer`);
        }
        return toast(`no open question on #${sel.id}`);
      case 'a':
        if (!sel) return;
        return void act(async (c, x) => { const t = await c.call<Task>('task.approve', { id: x.id, by: 'you' }); return `#${t.id} → ${statusLabel(t, gm)}`; });
      case 'x':
        if (!sel) return;
        if (sel.status === 'review' || (sel.status === 'plan' && sel.awaitingPlanApproval) || sel.status === 'in_progress' || sel.status === 'blocked') return setSt((p) => ({ ...p, mode: 'reject', input: '' }));
        return toast(`#${sel.id} is ${sel.status.replace('_', ' ')}; nothing running to stop`);
      case 'n': return sel ? setSt((p) => ({ ...p, mode: 'note', input: '' })) : undefined;
      case 'p':
        if (!sel) return;
        return void act(async (c, x) => { const t = await c.call<Task>('task.update', { id: x.id, priority: (x.priority + 1) % 4, by: 'you' }); return `#${t.id} priority P${t.priority}`; });
      case 'c':
        if (!sel || !active(sel)) return toast(sel ? `#${sel.id} is already ${sel.status}` : '');
        return setSt((p) => ({ ...p, mode: 'confirm', input: `cancel #${sel.id}? the agent stops and the worktree is kept` }));
      case 'K': {
        const paused = snapRef.current?.team.every((a) => a.paused);
        if (paused) return void act(async (c) => { await c.call('team.pause', { resume: true }); return 'every agent resumed'; });
        return setSt((p) => ({ ...p, mode: 'confirm', input: 'pause every agent? running work stops and waits' }));
      }
      case 'm': {
        if (!sel || !snapRef.current) return;
        const team = snapRef.current.team;
        const i = team.findIndex((a) => a.name === sel.agent);
        const next = team[(i + 1) % team.length];
        if (!next) return;
        return void act(async (c, x) => { const t = await c.call<Task>('task.reassign', { id: x.id, agent: next.name, by: 'you' }); return `#${t.id} → ${t.agent}`; });
      }
      case 't': {
        const run = sel ? [...sel.runs].reverse()[0] : undefined;
        return toast(run?.log ? `log: ${run.log}  ·  open with: less ${run.log}` : 'no run yet');
      }
      case 'o': {
        if (!sel?.worktree) return toast('this task works in the shared folder; no worktree of its own');
        const ed = process.env.VISUAL || process.env.EDITOR || 'open';
        try {
          spawn(ed, [sel.worktree], { detached: true, stdio: 'ignore' }).unref();
          return toast(`opened ${sel.worktree} with ${ed}`);
        } catch {
          return toast(`could not open ${sel.worktree}`);
        }
      }
      case 'R': return void refresh();
      case '+': case '=': return setPane(s.previewRows + 1);
      case '-': case '_': return setPane(s.previewRows - 1);
      default:
        return;
    }
  });

  if (!snap) return <Text dimColor>Connecting to the task manager…</Text>;
  // One column short of the terminal: a line that exactly fills the width makes the terminal wrap it,
  // and the redraw then leaves the previous frame behind.
  const W = Math.max(40, size.W - 1);
  const H = size.H - 1;
  let lines: string[];
  const sel = snap.tasks.find((t) => t.id === st.selId);
  if (st.view === 'detail' && sel) {
    const all = renderDetail(sel, snap, W);
    const room = H - 3;
    const scroll = Math.max(0, Math.min(st.scroll, Math.max(0, all.length - room)));
    lines = all.slice(scroll, scroll + room);
    if (all.length > room) lines.push(dim(`  ↓ ${all.length - room - scroll} more lines`));
  } else {
    const r = W >= 110 ? renderBoard(snap, st, W, H) : renderList(snap, st, W, H);
    layout.current = r.layout;
    lines = r.lines;
    if (!st.selHeader && (!st.selId || !snap.tasks.some((t) => t.id === st.selId))) {
      const first = r.layout.cols.find((c) => c.items.length)?.items[0];
      if (first) setTimeout(() => setSt((p) => ({ ...p, selId: first.id })), 0);
    }
  }
  while (lines.length < H - 2) lines.push('');
  lines = lines.slice(0, H - 2);
  lines.push(st.toast ? pc.green(`  ${st.toast}`) : '');
  lines.push(footer(st, snap, W, sel));
  if (process.env.AM_BOARD_DEBUG) {
    try {
      fs.appendFileSync(process.env.AM_BOARD_DEBUG, JSON.stringify({ at: Date.now(), size, W, H, lines: lines.length, previewRows: st.previewRows, stdoutRows: process.stdout.rows, layoutRule: layout.current?.ruleRow }) + '\n');
    } catch {
      /* debug only */
    }
  }
  return (
    <Box flexDirection="column">
      {lines.map((l, i) => (
        <Text key={i} wrap="truncate">
          {/* an empty Text has no height in Ink, so a blank row must hold a space */}
          {truncateVisible(l, W) || ' '}
        </Text>
      ))}
    </Box>
  );
};

export async function tasksCommand(name: string | undefined, opts: { json?: boolean; group?: string; size?: string }): Promise<void> {
  const meta = resolveSwarmName(name);
  if (!meta) return noSwarm(name);
  if (opts.json) {
    const c = await openClient(meta.name);
    try {
      const snap = await c.call<BoardSnapshot>('snapshot');
      console.log(JSON.stringify({ ...snap, needYouTasks: snap.tasks.filter(needsYou).map((t) => t.id) }, null, 2));
    } finally {
      c.close();
    }
    return;
  }
  const group = (['status', 'agent', 'eta'] as Group[]).includes(opts.group as Group) ? (opts.group as Group) : 'status';
  const sizeArg = opts.size ?? process.env.AM_BOARD_SIZE;
  const m = sizeArg ? /^(\d+)\s*x\s*(\d+)$/i.exec(sizeArg) : null;
  const sizeOverride = m ? { W: Number(m[1]), H: Number(m[2]) } : undefined;
  const { waitUntilExit } = render(<Board swarm={meta.name} group={group} sizeOverride={sizeOverride} />, { exitOnCtrlC: true });
  await waitUntilExit();
}
