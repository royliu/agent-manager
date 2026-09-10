import fs from 'node:fs';
import path from 'node:path';
import { makeTotals, type TokenTotals } from '../providers/types.js';
import { estimateCost } from '../usage/pricing.js';

export interface SessionStats {
  file?: string;
  model?: string;
  /** Input-side tokens of the latest request: what the context window holds now. */
  contextTokens: number;
  contextPct: number;
  /** Context use at the session's very first reply: the size of the brief itself, before any work. */
  firstContextPct?: number;
  totals: TokenTotals;
  usd: number;
  lastActivity?: number;
  turns: number;
  /** Recent tool actions, newest first, described in plain words. */
  recent: Array<{ at: number; text: string }>;
  /** The agent's most recent words, trimmed. */
  lastText?: string;
}

interface Rec {
  type?: string;
  requestId?: string;
  timestamp?: string;
  message?: {
    model?: string;
    content?: unknown;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

/** Claude Code writes `<home>/projects/<encoded cwd>/<sessionId>.jsonl`; the cwd encoding is lossy, so search. */
export function findClaudeTranscript(home: string, sessionId: string): string | undefined {
  const projects = path.join(home, 'projects');
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projects);
  } catch {
    return undefined;
  }
  for (const d of dirs) {
    const f = path.join(projects, d, `${sessionId}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return undefined;
}

export function readClaudeSession(home: string, sessionId: string, contextWindow: number): SessionStats {
  const file = findClaudeTranscript(home, sessionId);
  const empty: SessionStats = { file, contextTokens: 0, contextPct: 0, totals: makeTotals(), usd: 0, turns: 0, recent: [] };
  if (!file) return empty;
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return empty;
  }
  const seen = new Set<string>();
  const totals = makeTotals();
  const byModel = new Map<string, TokenTotals>();
  let model: string | undefined;
  let contextTokens = 0;
  let firstContextTokens: number | undefined;
  let turns = 0;
  const recent: Array<{ at: number; text: string }> = [];
  let lastText: string | undefined;
  for (const line of raw.split('\n')) {
    if (!line.includes('"usage"')) continue;
    let rec: Rec;
    try {
      rec = JSON.parse(line) as Rec;
    } catch {
      continue;
    }
    const u = rec.message?.usage;
    if (rec.type !== 'assistant' || !u) continue;
    const at = rec.timestamp ? Date.parse(rec.timestamp) : Date.now();
    if (Array.isArray(rec.message?.content)) {
      for (const block of rec.message!.content as Array<{ type?: string; name?: string; input?: Record<string, unknown>; text?: string }>) {
        if (block.type === 'tool_use' && block.name) recent.push({ at, text: describeTool(block.name, block.input ?? {}) });
        else if (block.type === 'text' && block.text && block.text.trim()) lastText = block.text.trim().replace(/\s+/g, ' ').slice(0, 200);
      }
    }
    const key = rec.requestId ?? `${rec.timestamp}-${u.output_tokens}`;
    if (seen.has(key)) continue;
    seen.add(key);
    turns += 1;
    model = rec.message?.model ?? model;
    const input = u.input_tokens ?? 0;
    const cr = u.cache_read_input_tokens ?? 0;
    const cw = u.cache_creation_input_tokens ?? 0;
    const out = u.output_tokens ?? 0;
    contextTokens = input + cr + cw;
    if (firstContextTokens === undefined) firstContextTokens = contextTokens;
    totals.input += input;
    totals.cacheRead += cr;
    totals.cacheWrite += cw;
    totals.output += out;
    const m = rec.message?.model ?? 'unknown';
    const bucket = byModel.get(m) ?? makeTotals();
    bucket.input += input;
    bucket.cacheRead += cr;
    bucket.cacheWrite += cw;
    bucket.output += out;
    byModel.set(m, bucket);
  }
  let usd = 0;
  for (const [m, t] of byModel) usd += estimateCost(m, t);
  const window = model && /\[1m\]/.test(model) ? 1_000_000 : contextWindow;
  let lastActivity: number | undefined;
  try {
    lastActivity = fs.statSync(file).mtimeMs;
  } catch {
    /* ignore */
  }
  return {
    file,
    model,
    contextTokens,
    contextPct: Math.min(100, Math.round((contextTokens / window) * 100)),
    firstContextPct: firstContextTokens === undefined ? undefined : Math.min(100, Math.round((firstContextTokens / window) * 100)),
    totals,
    usd,
    lastActivity,
    turns,
    recent: recent.slice(-8).reverse(),
    lastText,
  };
}

const short = (s: unknown, n = 70) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const rel = (p: unknown) => {
  const s = String(p ?? '');
  const home = process.env.HOME ?? '';
  return s.startsWith(home) ? `~${s.slice(home.length)}` : s;
};

/** One line a person can read for a tool call. */
export function describeTool(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Read': return `Reading ${rel(input.file_path)}`;
    case 'Edit': case 'MultiEdit': return `Editing ${rel(input.file_path)}`;
    case 'Write': return `Writing ${rel(input.file_path)}`;
    case 'Bash': return `Running: ${short(input.command)}`;
    case 'Grep': return `Searching for "${short(input.pattern, 40)}"${input.path ? ` in ${rel(input.path)}` : ''}`;
    case 'Glob': return `Looking for files ${short(input.pattern, 40)}`;
    case 'WebFetch': return `Fetching ${short(input.url, 60)}`;
    case 'WebSearch': return `Searching the web: ${short(input.query, 50)}`;
    case 'Task': return `Delegating: ${short(input.description, 50)}`;
    case 'TodoWrite': return 'Updating its to-do list';
    default: {
      const m = /^mcp__swarm__(.+)$/.exec(name);
      if (m) {
        const t = m[1]!;
        if (t === 'task_progress') return `Reporting progress${input.percent !== undefined ? ` (${input.percent}%)` : ''}: ${short(input.text, 60)}`;
        if (t === 'task_note') return `Writing a note: ${short(input.text, 60)}`;
        if (t === 'task_ask') return `Asking: ${short(input.question, 60)}`;
        if (t === 'task_report') return 'Reporting done';
        if (t === 'task_checkpoint') return 'Writing a checkpoint';
        if (t === 'task_eta') return `Setting the eta to ${short(input.eta, 20)}`;
        if (t === 'memory_update') return 'Refreshing its project memory';
        if (t === 'task_get') return 'Re-reading the task';
        return `Using ${t.replace(/_/g, ' ')}`;
      }
      return `Using ${name}`;
    }
  }
}

/**
 * Codex keeps one file per session at `sessions/<year>/<month>/<day>/rollout-<time>-<id>.jsonl`.
 * Finding it is how we tell a Codex session id from a Claude Code one: the same GM stores only one
 * id, so after a move between the two the stored id belongs to the other tool.
 */
export function findCodexRollout(home: string, sessionId: string): string | undefined {
  const tail = `-${sessionId}.jsonl`;
  return walkCodexSessions(home, (file, name) => (name.endsWith(tail) ? file : undefined));
}

/** The newest Codex session that ran in `cwd` and was written since `since`: the GM's own, just ended. */
export function newestCodexSession(home: string, cwd: string, since: number): string | undefined {
  let best: { id: string; at: number } | undefined;
  walkCodexSessions(home, (file, name) => {
    if (!name.startsWith('rollout-')) return undefined;
    let at: number;
    try {
      at = fs.statSync(file).mtimeMs;
    } catch {
      return undefined;
    }
    if (at < since || (best && at <= best.at)) return undefined;
    const meta = codexSessionMeta(file);
    if (meta && meta.cwd === cwd) best = { id: meta.id, at };
    return undefined;
  });
  return best?.id;
}

/** Every session file under a Codex home, three folders deep; the first answer that is not undefined wins. */
function walkCodexSessions(home: string, seen: (file: string, name: string) => string | undefined): string | undefined {
  const walk = (dir: string, depth: number): string | undefined => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth <= 0) continue;
        const hit = walk(full, depth - 1);
        if (hit) return hit;
        continue;
      }
      if (!e.name.endsWith('.jsonl')) continue;
      const hit = seen(full, e.name);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(path.join(home, 'sessions'), 3);
}

/** The session id and the folder it ran in, off the file's first line, without reading the whole session. */
function codexSessionMeta(file: string): { id: string; cwd: string } | undefined {
  let head: string;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(65536);
      head = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
  try {
    const payload = (JSON.parse(head.split('\n', 1)[0] ?? '') as { payload?: { session_id?: unknown; cwd?: unknown } }).payload;
    const id = typeof payload?.session_id === 'string' ? payload.session_id : undefined;
    const cwd = typeof payload?.cwd === 'string' ? payload.cwd : undefined;
    return id && cwd ? { id, cwd } : undefined;
  } catch {
    return undefined;
  }
}
