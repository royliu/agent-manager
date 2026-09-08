import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { buildEnv } from '../core/env.js';
import type { Question, Task, Workspace } from './model.js';
import { readClaudeSession } from './transcript.js';

export interface TriageContext {
  task: Task;
  root?: Task;
  parent?: Task;
  /** Decisions and acceptance notes recorded on other tasks, most recent first. */
  decisionsElsewhere: Array<{ taskId: number; title: string; text: string }>;
  /** The owner's original asks across the board, so intent is visible even when this task has none. */
  asks: Array<{ taskId: number; ask: string }>;
  activeTasks: Array<{ id: number; title: string; status: string; agent?: string }>;
  workspace?: Workspace;
  gmName: string;
}

export type TriageResult =
  | { answer: string; reasoning: string; basis: string }
  | { escalate: true; why?: string };

export interface TmSession {
  sessionId?: string;
  /** Called when the task manager starts a new conversation (first use, or after its context filled up). */
  onNewSession: (id: string) => void;
}

function notes(t: Task | undefined, label: string): string {
  if (!t) return '';
  const body = t.notes.map((n) => `- [${n.kind}] ${n.author}: ${n.text}`).join('\n');
  return `${label}\n${body || '(none)'}\n`;
}

const RULES_MOST = (gm: string) => `You are the task manager of ${gm}'s team, working for the owner of this project. ${gm} talks with the owner, plans and reviews; you answer the team's questions so ${gm} can stay in that conversation. Decide the way ${gm} would: reason from the owner's intent as written down (their asks, the project brief, the notes and decisions, the workspace conventions), think it through, and answer. You may read files in the workspace to check facts before answering; you cannot change anything.

Answering is the default. Most questions should be settled here:
- When the material spells it out, say so and cite it.
- When it does not, choose what best serves the owner's evident intent, keeping to the conventions already in use, and say why in one or two sentences. The agent's own default is often right; approve it when it is.
- Be concrete: the agent should be able to act on your answer without asking again.

Escalate only for the rare judgment call: the choice would materially change scope, cost or what "done" means AND the owner's intent is genuinely unknown; it touches secrets, money, deleting data, pushing or merging, or anything hard to undo; or the notes contradict each other or the ask.`;

const RULES_NOTES = (gm: string) => `You are the task manager of ${gm}'s team. Answer ONLY if a note, the description, the owner's ask, the workspace notes or a recorded decision settles the question directly, and quote what you relied on. Otherwise escalate.`;

/**
 * The task manager's answer to an agent's question: one turn of its own persistent
 * conversation, with read-only access to the workspace. Nothing here writes to the board;
 * the service records the answer.
 */
export function triageQuestion(
  profileHome: string,
  model: string | undefined,
  policy: 'notes' | 'most',
  ctx: TriageContext,
  q: Question,
  session: TmSession,
  contextWindow = 200_000,
  compactAt = 90,
  timeoutMs = 180_000,
): Promise<TriageResult | undefined> {
  const { task } = ctx;
  const ws = ctx.workspace;
  const prompt = `${policy === 'most' ? RULES_MOST(ctx.gmName) : RULES_NOTES(ctx.gmName)}

Reply with JSON only, no prose around it:
{"answer": "<plain-English answer the agent can act on, one to four sentences>", "reasoning": "<one or two sentences: what you relied on and why>", "basis": "<ask | brief | note | decision | workspace | code | judgment>"}
or
{"escalate": true, "why": "<one sentence>"}

PROJECT BRIEF (kept by ${ctx.gmName})
${ws?.brief || '(none yet)'}

WORKSPACE
folder ${ws?.dir ?? '?'}${ws?.branch ? ` · branch ${ws.branch}` : ''}${ws?.notes ? `\nconventions: ${ws.notes}` : ''}

THE OWNER'S ASKS
${ctx.asks.length ? ctx.asks.map((a) => `- #${a.taskId}: "${a.ask}"`).join('\n') : '(none recorded)'}

THE BOARD (active tasks)
${ctx.activeTasks.map((t) => `- #${t.id} ${t.title} · ${t.status}${t.agent ? ` · ${t.agent}` : ''}`).join('\n') || '(empty)'}

TASK #${task.id} "${task.title}"
${task.description || '(no description)'}
${notes(task, 'NOTES ON THIS TASK')}
${ctx.parent ? notes(ctx.parent, `NOTES ON THE PARENT TASK #${ctx.parent.id} "${ctx.parent.title}"`) : ''}
${ctx.decisionsElsewhere.length ? `DECISIONS RECORDED ON OTHER TASKS\n${ctx.decisionsElsewhere.map((d) => `- #${d.taskId} ${d.title}: ${d.text}`).join('\n')}\n` : ''}
QUESTION from ${q.from}
about: ${q.about}
known: ${q.known}
question: ${q.question}
options: ${q.options.join(' | ') || '(none)'}
default: ${q.default}`;

  // Keep one conversation so answers stay consistent; start over when it fills up.
  let resume = false;
  if (session.sessionId) {
    const stats = readClaudeSession(profileHome, session.sessionId, contextWindow);
    resume = !!stats.file && stats.contextPct < compactAt;
  }
  const sid = resume ? session.sessionId! : randomUUID();
  if (!resume) session.onNewSession(sid);
  const args = ['-p', prompt, '--output-format', 'json', '--strict-mcp-config', '--permission-mode', 'plan', '--allowedTools', 'Read', 'Grep', 'Glob'];
  if (model) args.push('--model', model); // unset: the profile's own default model applies
  args.push(resume ? '--resume' : '--session-id', sid);

  return new Promise((resolve) => {
    const child = spawn('claude', args, {
      cwd: ws?.dir && isDir(ws.dir) ? ws.dir : process.cwd(),
      env: buildEnv('claude-code', profileHome),
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    const timer = setTimeout(() => {
      child.kill();
      resolve(undefined);
    }, timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on('exit', () => {
      clearTimeout(timer);
      try {
        const env = JSON.parse(out) as { result?: string };
        const m = /\{[\s\S]*\}/.exec(env.result ?? '');
        if (!m) return resolve(undefined);
        const j = JSON.parse(m[0]) as { answer?: string; reasoning?: string; basis?: string; escalate?: boolean; why?: string };
        if (j.answer) return resolve({ answer: j.answer, reasoning: j.reasoning ?? '', basis: j.basis ?? 'judgment' });
        resolve({ escalate: true, why: j.why });
      } catch {
        resolve(undefined);
      }
    });
  });
}

function isDir(d: string): boolean {
  try {
    return fs.statSync(d).isDirectory();
  } catch {
    return false;
  }
}
