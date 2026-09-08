import { withClient } from '../swarm/client.js';
import type { Task } from '../swarm/model.js';
import { resolveSwarmName } from '../swarm/registry.js';
import { statusLabel } from '../swarm/service.js';
import { bold, cyan, dim, green, red } from '../ui/format.js';
import { noSwarm } from './gm.js';

function parseId(s: string | undefined): number {
  const n = Number.parseInt((s ?? '').replace(/^#/, ''), 10);
  if (!Number.isFinite(n)) throw new Error('which task? give its id, like #12');
  return n;
}

/** `am task <ls|show|add|note|eta|answer|approve|reject|stop|start|assign|cancel|retry> …` */
export async function taskCommand(sub: string, args: string[], opts: { gm?: string; json?: boolean; agent?: string; description?: string; start?: boolean; eta?: string }): Promise<void> {
  const meta = resolveSwarmName(opts.gm);
  if (!meta) return noSwarm(opts.gm);
  const gm = meta.name;
  await withClient(meta.name, async (c) => {
    const text = (from: number) => args.slice(from).join(' ').trim();
    switch (sub) {
      case 'list':
      case 'ls': {
        const tasks = await c.call<Task[]>('task.list');
        if (opts.json) return console.log(JSON.stringify(tasks, null, 2));
        for (const t of tasks) console.log(`  ${bold(`#${t.id}`)} ${t.title} ${dim(`— ${statusLabel(t, gm)}${t.agent ? ` · ${t.agent}` : ''}`)}`);
        return;
      }
      case 'show': {
        const t = await c.call<Task>('task.get', { id: parseId(args[0]) });
        if (opts.json) return console.log(JSON.stringify(t, null, 2));
        console.log('');
        console.log(`  ${bold(`#${t.id} ${t.title}`)}  ${statusLabel(t, gm)}  ${dim(`P${t.priority}${t.eta ? ` · eta ${new Date(t.eta).toLocaleString()}` : ''}${t.agent ? ` · ${t.agent}` : ''} · $${t.usage.usd.toFixed(2)}`)}`);
        if (t.ask) console.log(`  ${dim('ask:')} "${t.ask}"`);
        console.log(`  ${t.description}`);
        if (t.notes.length) {
          console.log(`  ${dim('notes')}`);
          for (const n of t.notes) console.log(`    ${dim(new Date(n.at).toLocaleTimeString())} ${n.author} ${dim(n.kind)} ${n.text}`);
        }
        const q = [...t.questions].reverse().find((x) => !x.answer);
        if (q) {
          console.log(`  ${dim('question from')} ${q.from} ${dim(`· waiting on ${q.to === 'user' ? 'you' : q.to === 'gm' ? gm : 'task manager'}`)}`);
          console.log(`    ${dim('about')}    ${q.about}\n    ${dim('known')}    ${q.known}\n    ${dim('question')} ${q.question}\n    ${dim('options')}  ${q.options.join(' | ') || '—'}\n    ${dim('default')}  ${q.default}`);
        }
        if (t.runs.length) console.log(`  ${dim('runs')} ${t.runs.map((r) => `${r.n}:${r.exit ?? 'running'}`).join(' ')}`);
        console.log('');
        return;
      }
      case 'add': {
        const t = await c.call<Task>('task.create', { title: text(0), description: opts.description ?? text(0), by: 'you', agent: opts.agent, dispatch: opts.start === true, eta: opts.eta });
        console.log(`  ${green('✓')} #${t.id} ${t.title} ${dim(`(${statusLabel(t, gm)})`)}`);
        return;
      }
      case 'eta': { const t = await c.call<Task>('task.eta', { id: parseId(args[0]), eta: text(1), by: 'you' }); return ok(t.eta ? `#${t.id} eta ${new Date(t.eta).toLocaleString()}` : `could not read that time; use "2h", "1d" or a date and time`); }
      case 'note': await c.call('task.note', { id: parseId(args[0]), author: 'you', kind: 'context', text: text(1) }); return ok(`noted on #${parseId(args[0])}`);
      case 'answer': { const t = await c.call<Task>('task.answer', { id: parseId(args[0]), answer: text(1), by: 'you' }); return ok(`#${t.id} answered → ${statusLabel(t, gm)}${t.agent ? ` · ${t.agent} continues` : ''}`); }
      case 'approve': { const t = await c.call<Task>('task.approve', { id: parseId(args[0]), by: 'you', text: text(1) }); return ok(`#${t.id} → ${statusLabel(t, gm)}`); }
      case 'reject': case 'stop': { const t = await c.call<Task>('task.reject', { id: parseId(args[0]), feedback: text(1), by: 'you' }); return ok(`#${t.id} → ${statusLabel(t, gm)}${text(1) ? '' : ' (on hold)'}`); }
      case 'cancel': { const t = await c.call<Task>('task.cancel', { id: parseId(args[0]), by: 'you' }); return ok(`#${t.id} cancelled`); }
      case 'retry': { const t = await c.call<Task>('task.retry', { id: parseId(args[0]) }); return ok(`#${t.id} → ${statusLabel(t, gm)}`); }
      case 'start':
      case 'dispatch': { const t = await c.call<Task>('task.dispatch', { id: parseId(args[0]), agent: opts.agent, by: 'you' }); return ok(`#${t.id} → ${statusLabel(t, gm)}`); }
      case 'assign':
      case 'reassign': { const t = await c.call<Task>('task.reassign', { id: parseId(args[0]), agent: args[1] ?? opts.agent, by: 'you' }); return ok(`#${t.id} → ${t.agent}`); }
      default:
        console.error(`${red('✗')} Unknown: am task ${sub}. Try ${cyan('am task ls|show|add|note|eta|answer|approve|reject|stop|start|assign|cancel|retry #id …')}`);
        process.exitCode = 1;
    }
  });
  function ok(msg: string): void {
    console.log(`  ${green('✓')} ${msg}`);
  }
}
