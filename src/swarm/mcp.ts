import { openClient, type TmClient } from './client.js';
import type { Agent, InboxItem, Task } from './model.js';
import { RpcError } from './protocol.js';
import { statusLabel } from './service.js';

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
type Json = Record<string, unknown>;
const S = (props: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({ type: 'object', properties: props, required, additionalProperties: false });
const s = (description: string) => ({ type: 'string', description });
const n = (description: string) => ({ type: 'number', description });
const b = (description: string) => ({ type: 'boolean', description });
const arr = (description: string) => ({ type: 'array', items: { type: 'string' }, description });

const ID = n('task id, the number after #');
const ETA = s('when you expect it done: "2h", "1d", or a date/time like "2026-09-07 18:00"');

const GM_TOOLS: Tool[] = [
  { name: 'task_create', description: 'Create a task on the board. Write the description for the agent who will do it: what to build or find, where, and what done means. Every task needs an eta: your estimate of when it will be done ("2h", "1d", or a date and time); the agent refines it. Set dispatch=true to start it right away, or dispatch later with task_dispatch.', inputSchema: S({ title: s('short title'), description: s('the brief for the agent'), ask: s("the owner's original words, verbatim, on a root task"), acceptance: s('what done means, one paragraph'), notes: arr('extra context notes'), parentId: n('parent task id for a sub-task'), dependsOn: { type: 'array', items: { type: 'number' }, description: 'ids that must be done first' }, priority: n('0 urgent … 3 whenever, default 2'), eta: ETA, agent: s('agent name, or leave empty for the first idle agent'), planFirst: b('agent writes a plan the owner approves before code'), useWorktree: b('give the task its own git worktree and branch'), reviewBy: { type: 'string', enum: ['gm', 'user'], description: 'who gives final acceptance; default user' }, dispatch: b('start it now') }, ['title', 'description', 'eta']) },
  { name: 'task_update', description: 'Change a task: title, description, priority, eta, dependsOn, planFirst, useWorktree, reviewBy.', inputSchema: S({ id: ID, title: s(''), description: s(''), priority: n(''), eta: ETA, dependsOn: { type: 'array', items: { type: 'number' } }, planFirst: b(''), useWorktree: b(''), reviewBy: { type: 'string', enum: ['gm', 'user'] }, by: s('') }, ['id']) },
  { name: 'task_dispatch', description: 'Ask the task manager to start a task: on the named agent, or the first idle one. Held automatically while dependencies are unfinished.', inputSchema: S({ id: ID, agent: s('agent name, optional') }, ['id']) },
  { name: 'task_reassign', description: 'Move a task to another agent. A running agent is asked to stop and the new one continues from the notes.', inputSchema: S({ id: ID, agent: s('agent name') }, ['id', 'agent']) },
  { name: 'task_note', description: 'Add a note to a task: a decision, acceptance criteria, context, a finding. Agents see notes in their brief.', inputSchema: S({ id: ID, kind: { type: 'string', enum: ['context', 'decision', 'plan', 'acceptance', 'finding'], description: 'default context' }, text: s('a complete sentence or two') }, ['id', 'text']) },
  { name: 'task_answer', description: "Answer an agent's open question on a task. The answer becomes a note and the agent continues with it.", inputSchema: S({ id: ID, answer: s('plain-English answer') }, ['id', 'answer']) },
  { name: 'task_escalate', description: 'Put an open question to the owner, with your own view. Use when the ask, the notes and your design do not settle it. The owner can answer on the board or in chat.', inputSchema: S({ id: ID, view: s('your recommendation, one or two sentences') }, ['id']) },
  { name: 'task_approve', description: "Approve a reported task after looking at the work (it then waits for the owner's acceptance unless reviewBy is gm), or approve a plan that is awaiting approval.", inputSchema: S({ id: ID, text: s('what you checked, optional') }, ['id']) },
  { name: 'task_reject', description: 'Send a reported task or a plan back with specific feedback, or stop a running agent: with feedback it is restarted on your feedback, without feedback the task is put on hold.', inputSchema: S({ id: ID, feedback: s('what to change and why; leave empty to just stop the work') }, ['id']) },
  { name: 'task_cancel', description: 'Cancel a task. A running agent is stopped; the worktree is kept.', inputSchema: S({ id: ID }, ['id']) },
  { name: 'task_list', description: 'The board in one screen: every task with status, agent, eta.', inputSchema: S({ all: b('include done and cancelled') }) },
  { name: 'task_get', description: 'Everything about one task: description, notes, questions, runs, timeline.', inputSchema: S({ id: ID }, ['id']) },
  { name: 'team_list', description: 'The agents: state, current task, context use.', inputSchema: S({}) },
  { name: 'workspace_update', description: "Record what the team should know: the project brief (the owner's goals, the design so far, what matters and what does not; the task manager reasons from it when answering the team), a branch change, conventions for agents, environment variables. Agents adapt at their next task.", inputSchema: S({ brief: s("the owner's intent and the design so far, kept current; replaces the previous brief"), branch: s(''), notes: s('plain-English conventions every agent should know'), env: { type: 'object', additionalProperties: { type: 'string' }, description: 'environment variables to set for agents' } }) },
  { name: 'inbox_read', description: 'Read and clear items the task manager left for you. "Needs you" items: a question it could not settle, a finished task to review, a stalled agent, a quota warning. "For awareness" items: questions it already answered; no action.', inputSchema: S({}) },
  { name: 'board_summary', description: 'Counts: what needs the owner, what is running, what is queued.', inputSchema: S({}) },
];

const AGENT_TOOLS: Tool[] = [
  { name: 'task_get', description: 'Re-read your task (or a related one): description, notes, questions.', inputSchema: S({ id: n('task id; defaults to your task') }) },
  { name: 'task_note', description: 'Record a finding or a decision on your task, as a complete sentence.', inputSchema: S({ kind: { type: 'string', enum: ['context', 'decision', 'plan', 'finding'] }, text: s('') }, ['text']) },
  { name: 'task_progress', description: 'One short sentence on where you are, with your honest estimate of how far along the task is (0-100). Do this after each significant step; the owner sees it as a progress bar.', inputSchema: S({ text: s(''), percent: n('0-100, how much of the task is done') }, ['text', 'percent']) },
  { name: 'task_eta', description: 'Refine when you expect to be done.', inputSchema: S({ eta: ETA }, ['eta']) },
  { name: 'task_ask', description: 'Ask when a decision matters and the notes do not settle it. All five parts are required; then end your reply and wait to be continued.', inputSchema: S({ about: s('which task and what it is for, one or two sentences'), known: s('what you have done, found or tried'), question: s('the exact question'), options: arr('choices with trade-offs'), default: s('what you will do if nobody answers, and by when') }, ['about', 'known', 'question', 'default']) },
  { name: 'task_checkpoint', description: 'Save your state before your context is compacted: what is done, what is left, the next step, decisions and why. Then end your reply.', inputSchema: S({ text: s('') }, ['text']) },
  { name: 'task_report', description: 'Report the task finished (or that you could not finish). Say what changed, how you verified it, what is left, and anything to watch. Then end your reply.', inputSchema: S({ changed: s(''), verified: s(''), left: s(''), watch: s(''), status: { type: 'string', enum: ['done', 'failed'] } }, ['changed', 'verified', 'left']) },
  { name: 'memory_update', description: 'Replace your one-paragraph memory of this project: what you know about the codebase and how the team works.', inputSchema: S({ text: s('') }, ['text']) },
];

function fmtTask(t: Task, gm: string): string {
  const q = [...t.questions].reverse().find((x) => !x.answer);
  const lines = [
    `#${t.id} ${t.title}`,
    `status: ${statusLabel(t, gm)} · priority P${t.priority}${t.eta ? ` · eta ${new Date(t.eta).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : ''} · agent: ${t.agent ?? 'none yet'}${t.parentId ? ` · part of #${t.parentId}` : ''}${t.dependsOn.length ? ` · waits for ${t.dependsOn.map((d) => '#' + d).join(', ')}` : ''}`,
    t.ask ? `ask: "${t.ask}"` : '',
    `description: ${t.description}`,
    t.progress ? `progress: ${t.progress}` : '',
    t.branch ? `branch: ${t.branch} (${t.worktree})` : '',
    'notes:',
    ...(t.notes.length ? t.notes.map((x) => `  - [${x.kind}] ${x.author} (${new Date(x.at).toLocaleTimeString()}): ${x.text}`) : ['  (none)']),
    q ? `open question from ${q.from} (waiting on ${q.to === 'tm' ? 'task manager' : q.to === 'gm' ? gm : 'the owner'}):\n  about: ${q.about}\n  known: ${q.known}\n  question: ${q.question}\n  options: ${q.options.join(' | ') || '(none)'}\n  default: ${q.default}` : '',
    t.report ? `report: changed: ${t.report.changed} · verified: ${t.report.verified} · left: ${t.report.left}${t.report.watch ? ` · watch: ${t.report.watch}` : ''}` : '',
    t.runs.length ? `runs: ${t.runs.map((r) => `${r.n}: ${r.exit ?? 'running'}${r.exitNote ? ` (${r.exitNote})` : ''}`).join('; ')} · cost $${t.usage.usd.toFixed(2)}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

function fmtList(tasks: Task[], gm: string, all: boolean): string {
  const shown = tasks.filter((t) => all || (t.status !== 'done' && t.status !== 'cancelled'));
  if (!shown.length) return 'No tasks on the board.';
  return shown.map((t) => `#${t.id} ${t.title} — ${statusLabel(t, gm)} · ${t.agent ?? 'no agent'}${t.eta ? ` · eta ${new Date(t.eta).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : ''}${t.progress ? ` · ${t.progress}` : ''}`).join('\n');
}

export async function runMcpBridge(opts: { swarm: string; role: 'gm' | 'agent'; agent?: string; task?: number }): Promise<void> {
  let raw: TmClient = await openClient(opts.swarm);
  const isTransport = (e: unknown) => !(e instanceof RpcError) && e instanceof Error && /closed|not connected|ENOENT|ECONNREFUSED|EPIPE/.test(e.message);
  /** Calls go through here so a restarted task manager is picked up transparently. */
  const client = {
    async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      try {
        return await raw.call<T>(method, params);
      } catch (e) {
        if (!isTransport(e)) throw e;
        raw.close();
        raw = await openClient(opts.swarm);
        return raw.call<T>(method, params);
      }
    },
    close: () => raw.close(),
  };
  const meta = (await client.call<{ meta: { name: string } }>('snapshot')).meta;
  const gm = meta.name;
  const tools = opts.role === 'gm' ? GM_TOOLS : AGENT_TOOLS;

  const write = (msg: Json) => process.stdout.write(JSON.stringify(msg) + '\n');
  const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], isError });

  async function call(name: string, a: Json): Promise<Json> {
    const id = typeof a.id === 'number' ? a.id : opts.task;
    if (opts.role === 'agent') {
      a = { ...a, agent: opts.agent, id, by: opts.agent };
    } else {
      a = { ...a, by: gm };
    }
    let out: string;
    switch (name) {
      case 'task_create': {
        const t = await client.call<Task>('task.create', a);
        out = `Created #${t.id} ${t.title} (${statusLabel(t, gm)}${t.agent ? `, ${t.agent}` : ''}). Refer to it as #${t.id}.`;
        if (t.eta && t.eta - Date.now() > 6 * 3_600_000) {
          const team = await client.call<Agent[]>('team.list');
          const idle = team.filter((x) => x.state === 'idle' && !x.paused).length;
          if (idle > 0) out += `\n\nThis task is estimated at more than six hours and ${idle} agent${idle === 1 ? ' is' : 's are'} idle. If it has independent parts, split it into separate tasks and dispatch them in parallel; the job then takes as long as its longest part.`;
        }
        break;
      }
      case 'task_update': out = fmtTask(await client.call<Task>('task.update', a), gm); break;
      case 'task_dispatch': { const t = await client.call<Task>('task.dispatch', a); out = `#${t.id} → ${statusLabel(t, gm)}${t.agent ? ` · ${t.agent}` : ' · next idle agent'}`; break; }
      case 'task_reassign': { const t = await client.call<Task>('task.reassign', a); out = `#${t.id} → ${t.agent}`; break; }
      case 'task_note': { const r = await client.call<{ message?: string }>('task.note', { ...a, author: opts.role === 'agent' ? opts.agent : gm }); out = r.message ?? `Noted on #${id}.`; break; }
      case 'task_progress': await client.call('task.progress', a); out = 'Progress noted.'; break;
      case 'task_eta': { const t = await client.call<Task>('task.eta', a); out = t.eta ? `ETA set to ${new Date(t.eta).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}.` : 'Could not read that time; use "2h", "1d" or a date and time.'; break; }
      case 'task_ask': { const r = await client.call<{ message: string }>('task.ask', a); out = r.message; break; }
      case 'task_answer': { const t = await client.call<Task>('task.answer', a); out = `Answered. #${t.id} is now ${statusLabel(t, gm)}; ${t.agent ?? 'the agent'} continues with your answer.`; break; }
      case 'task_escalate': { const t = await client.call<Task>('task.escalate', a); out = `The question on #${t.id} is now with the owner. Tell them in plain words, in the five-part shape, with your view.`; break; }
      case 'task_approve': { const t = await client.call<Task>('task.approve', a); out = `#${t.id} → ${statusLabel(t, gm)}.`; break; }
      case 'task_reject': { const t = await client.call<Task>('task.reject', a); out = a.feedback ? `#${t.id} → ${statusLabel(t, gm)}; ${t.agent ?? 'the agent'} continues with your feedback.` : `#${t.id} stopped and on hold; dispatch it again when it should continue.`; break; }
      case 'task_report': { const r = await client.call<{ message: string }>('task.report', a); out = r.message; break; }
      case 'task_checkpoint': { const r = await client.call<{ message: string }>('task.checkpoint', a); out = r.message; break; }
      case 'task_cancel': { const t = await client.call<Task>('task.cancel', a); out = `#${t.id} cancelled.`; break; }
      case 'task_list': out = fmtList(await client.call<Task[]>('task.list'), gm, a.all === true); break;
      case 'task_get': out = fmtTask(await client.call<Task>('task.get', { id }), gm); break;
      case 'team_list': { const team = await client.call<Array<Agent & { effectiveModel?: string }>>('team.list'); out = team.map((x) => `${x.name}: ${x.state}${x.taskId !== undefined ? ` on #${x.taskId}` : ''} · context ${x.contextPct}% · profile ${x.profile} · model ${x.effectiveModel ?? 'tool default'}`).join('\n'); break; }
      case 'workspace_update': { const ws = await client.call<{ dir: string; branch?: string; notes: string; brief: string }>('workspace.update', a); out = `Workspace: ${ws.dir}${ws.branch ? ` · branch ${ws.branch}` : ''}${ws.notes ? ` · conventions: ${ws.notes}` : ''}${ws.brief ? `\nProject brief recorded (${ws.brief.length} chars); the task manager will reason from it.` : ''}. Agents adapt at their next task.`; break; }
      case 'inbox_read': { const items = await client.call<InboxItem[]>('inbox.read', { ack: true }); out = items.length ? items.map((i) => `[${i.kind === 'info' || i.kind === 'context' ? 'for awareness' : 'needs you'} · ${i.kind}${i.taskId !== undefined ? ` #${i.taskId}` : ''}] ${i.text}`).join('\n\n') : 'Nothing new.'; break; }
      case 'board_summary': { const snap = await client.call<{ tasks: Task[]; team: Agent[]; needYou: number; inboxUnread: number }>('snapshot'); const running = snap.tasks.filter((t) => t.status === 'in_progress').length; const queued = snap.tasks.filter((t) => t.status === 'open' && t.dispatchRequested).length; out = `${snap.needYou} need the owner · ${running} running · ${queued} queued · ${snap.inboxUnread} unread for you · team: ${snap.team.map((x) => `${x.name} ${x.state}`).join(', ')}`; break; }
      case 'memory_update': await client.call('memory.update', a); out = 'Memory updated.'; break;
      default:
        return text(`unknown tool ${name}`, true);
    }
    if (opts.role === 'agent' && opts.agent) {
      const notice = await client.call<string | null>('agent.notice', { agent: opts.agent });
      if (notice) out += `\n\n${notice}`;
    }
    return text(out);
  }

  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) void onMessage(line);
    }
  });
  process.stdin.on('end', () => {
    client.close();
    process.exit(0);
  });

  async function onMessage(line: string): Promise<void> {
    let msg: { id?: number | string; method?: string; params?: Json };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const { id, method, params } = msg;
    const reply = (result: unknown) => write({ jsonrpc: '2.0', id, result });
    const fail = (code: number, message: string) => write({ jsonrpc: '2.0', id, error: { code, message } });
    try {
      switch (method) {
        case 'initialize':
          reply({ protocolVersion: (params?.protocolVersion as string) ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'swarm', version: '0.2.0' } });
          return;
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return;
        case 'ping':
          reply({});
          return;
        case 'tools/list':
          reply({ tools });
          return;
        case 'tools/call': {
          const name = String(params?.name ?? '');
          const args = (params?.arguments as Json) ?? {};
          try {
            reply(await call(name, args));
          } catch (e) {
            const m = e instanceof RpcError || e instanceof Error ? e.message : String(e);
            reply(text(m, true));
          }
          return;
        }
        default:
          if (id !== undefined) fail(-32601, `method not found: ${method}`);
      }
    } catch (e) {
      if (id !== undefined) fail(-32000, e instanceof Error ? e.message : String(e));
    }
  }
}
