import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
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

/** Where each session's transcript was found, so the projects folder is not searched on every call. */
const transcriptPaths = new Map<string, string>();

/** Claude Code writes `<home>/projects/<encoded cwd>/<sessionId>.jsonl`; the cwd encoding is lossy, so search. */
export function findClaudeTranscript(home: string, sessionId: string): string | undefined {
  const key = `${home}\0${sessionId}`;
  const known = transcriptPaths.get(key);
  if (known && fs.existsSync(known)) return known;
  const projects = path.join(home, 'projects');
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projects);
  } catch {
    return undefined;
  }
  for (const d of dirs) {
    const f = path.join(projects, d, `${sessionId}.jsonl`);
    if (fs.existsSync(f)) {
      transcriptPaths.set(key, f);
      return f;
    }
  }
  return undefined;
}

/** What has been read of one transcript so far; each call reads only what was appended since. */
interface Progress {
  offset: number;
  carry: string;
  decoder: StringDecoder;
  seen: Set<string>;
  totals: TokenTotals;
  byModel: Map<string, TokenTotals>;
  model?: string;
  contextTokens: number;
  firstContextTokens?: number;
  turns: number;
  recent: Array<{ at: number; text: string }>;
  lastText?: string;
}
const progress = new Map<string, Progress>();
const CHUNK = 8 * 1024 * 1024;

function freshProgress(): Progress {
  return { offset: 0, carry: '', decoder: new StringDecoder('utf8'), seen: new Set(), totals: makeTotals(), byModel: new Map(), contextTokens: 0, turns: 0, recent: [] };
}

function readLine(st: Progress, line: string): void {
  if (!line.includes('"usage"')) return;
  let rec: Rec;
  try {
    rec = JSON.parse(line) as Rec;
  } catch {
    return;
  }
  const u = rec.message?.usage;
  if (rec.type !== 'assistant' || !u) return;
  const at = rec.timestamp ? Date.parse(rec.timestamp) : Date.now();
  if (Array.isArray(rec.message?.content)) {
    for (const block of rec.message!.content as Array<{ type?: string; name?: string; input?: Record<string, unknown>; text?: string }>) {
      if (block.type === 'tool_use' && block.name) st.recent.push({ at, text: describeTool(block.name, block.input ?? {}) });
      else if (block.type === 'text' && block.text && block.text.trim()) st.lastText = block.text.trim().replace(/\s+/g, ' ').slice(0, 200);
    }
    if (st.recent.length > 32) st.recent.splice(0, st.recent.length - 8);
  }
  const key = rec.requestId ?? `${rec.timestamp}-${u.output_tokens}`;
  if (st.seen.has(key)) return;
  st.seen.add(key);
  st.turns += 1;
  st.model = rec.message?.model ?? st.model;
  const input = u.input_tokens ?? 0;
  const cr = u.cache_read_input_tokens ?? 0;
  const cw = u.cache_creation_input_tokens ?? 0;
  const out = u.output_tokens ?? 0;
  st.contextTokens = input + cr + cw;
  if (st.firstContextTokens === undefined) st.firstContextTokens = st.contextTokens;
  st.totals.input += input;
  st.totals.cacheRead += cr;
  st.totals.cacheWrite += cw;
  st.totals.output += out;
  const m = rec.message?.model ?? 'unknown';
  const bucket = st.byModel.get(m) ?? makeTotals();
  bucket.input += input;
  bucket.cacheRead += cr;
  bucket.cacheWrite += cw;
  bucket.output += out;
  st.byModel.set(m, bucket);
}

/**
 * A session's totals, context and recent actions. The first call reads the file in chunks; later calls
 * read only what was appended. (A GM transcript reached 527 MB on 28 Sep, and reading it whole on every
 * status request kept the board server at 2.6 GB and most of a core.)
 */
export function readClaudeSession(home: string, sessionId: string, contextWindow: number): SessionStats {
  const file = findClaudeTranscript(home, sessionId);
  const empty: SessionStats = { file, contextTokens: 0, contextPct: 0, totals: makeTotals(), usd: 0, turns: 0, recent: [] };
  if (!file) return empty;
  let size: number;
  let lastActivity: number | undefined;
  try {
    const stat = fs.statSync(file);
    size = stat.size;
    lastActivity = stat.mtimeMs;
  } catch {
    return empty;
  }
  let st = progress.get(file);
  if (!st || size < st.offset) st = freshProgress();
  progress.set(file, st);
  if (size > st.offset) {
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(Math.min(CHUNK, size - st.offset));
      while (st.offset < size) {
        const n = fs.readSync(fd, buf, 0, Math.min(buf.length, size - st.offset), st.offset);
        if (n <= 0) break;
        st.offset += n;
        const text = st.carry + st.decoder.write(buf.subarray(0, n));
        const lines = text.split('\n');
        st.carry = lines.pop() ?? '';
        for (const line of lines) readLine(st, line);
      }
    } catch {
      /* read what we could */
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  let usd = 0;
  for (const [m, t] of st.byModel) usd += estimateCost(m, t);
  const window = st.model && /\[1m\]/.test(st.model) ? 1_000_000 : contextWindow;
  return {
    file,
    model: st.model,
    contextTokens: st.contextTokens,
    contextPct: Math.min(100, Math.round((st.contextTokens / window) * 100)),
    firstContextPct: st.firstContextTokens === undefined ? undefined : Math.min(100, Math.round((st.firstContextTokens / window) * 100)),
    totals: { ...st.totals },
    usd,
    lastActivity,
    turns: st.turns,
    recent: st.recent.slice(-8).reverse(),
    lastText: st.lastText,
  };
}

/**
 * Only the context % of a session, from the last assistant reply near the end of the file: what the
 * board's header shows for the GM. It never reads more than the file's last 16 MB.
 */
export function readClaudeContextPct(home: string, sessionId: string, contextWindow: number): number | undefined {
  const file = findClaudeTranscript(home, sessionId);
  if (!file) return undefined;
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    for (let span = 1024 * 1024; ; span *= 4) {
      const len = Math.min(span, size);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= (len < size ? 1 : 0); i -= 1) {
        const line = lines[i]!;
        if (!line.includes('"usage"')) continue;
        try {
          const rec = JSON.parse(line) as Rec;
          const u = rec.message?.usage;
          if (rec.type !== 'assistant' || !u) continue;
          const tokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
          const window = rec.message?.model && /\[1m\]/.test(rec.message.model) ? 1_000_000 : contextWindow;
          return Math.min(100, Math.round((tokens / window) * 100));
        } catch {
          /* a torn line */
        }
      }
      if (len >= size || span >= 16 * 1024 * 1024) return 0;
    }
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
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
