/**
 * Task agents leave a profile that is nearly spent (28 Oct 2026): a narrow check of the task manager itself.
 *
 * The owner's ask: when the profile the agents run on passes 95%, keep their context and memory and move them to another
 * working profile. This replays it in a throwaway home under /tmp with made-up profiles (superclaude, work, personal, one
 * not logged in, one codex). The live usage poll is a stand-in that returns the figures each step sets; every agent run
 * is a stand-in process, so no session is started, no usage endpoint is asked and nothing real is touched. The clock is
 * the check's own, so the 3-minute checkpoint wait takes no real time.
 *
 *   node --import tsx checks/autoswitch.ts              all PASS
 *   BREAK=flap node --import tsx checks/autoswitch.ts   must FAIL: a profile the agents left is left again in the same
 *                                                       window, and gone back to before its window resets
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'am-switchcheck-'));
process.env.AGENT_MANAGER_HOME = HOME;

const { TaskManagerService, serviceSeams } = await import('../src/swarm/service.js');
const { Store } = await import('../src/swarm/store.js');
const { loadSwarmConfig, saveSwarmConfig } = await import('../src/swarm/registry.js');
const { chooseTarget, SWITCH_CHECKPOINT_WAIT_MS } = await import('../src/swarm/autoswitch.js');
const { projectSlug, profileMemoryDir, sharedMemoryDir } = await import('../src/core/memory.js');
import type { Window } from '../src/providers/types.js';

const BREAK = process.env.BREAK ?? '';
if (BREAK === 'flap') serviceSeams.breakFor = 'flap';

let failed = 0;
let all = 0;
const check = (ok: boolean, what: string, detail = ''): void => {
  all += 1;
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `  (${detail})` : ''}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ═══ a throwaway home: four Claude Code profiles (one not logged in), one codex profile, one project ═══ */
const profile = (name: string, provider = 'claude-code') => ({ name, provider, home: path.join(HOME, 'profiles', provider, name), managed: true, createdAt: new Date().toISOString() });
const PROFILES = [profile('superclaude'), profile('work'), profile('personal'), profile('spare'), profile('kimi', 'codex')];
for (const p of PROFILES) fs.mkdirSync(p.home, { recursive: true });
fs.writeFileSync(path.join(HOME, 'profiles.json'), JSON.stringify({ version: 1, profiles: PROFILES }, null, 2));
saveSwarmConfig({ ...loadSwarmConfig(), restartGapSec: 0, maxWorking: 8, autostart: false });
const WORK = path.join(HOME, 'work', 'my-project');
fs.mkdirSync(WORK, { recursive: true });
const slug = projectSlug(WORK);
// superclaude has learned something about the project on its own; work has never been there.
const scMemory = profileMemoryDir(PROFILES[0] as never, slug);
fs.mkdirSync(scMemory, { recursive: true });
fs.writeFileSync(path.join(scMemory, 'build-needs-node-24.md'), '---\nname: Build needs node 24\ndescription: the build fails on 22\nmetadata:\n  type: project\n---\nUse node 24.\n');
fs.writeFileSync(path.join(scMemory, 'MEMORY.md'), '- [Build needs node 24](build-needs-node-24.md) — the build fails on 22\n');

/** Every launch is a stand-in. "forever" never exits by itself; "limit" writes the tool's limit line to its log and exits 1. */
let mode: 'forever' | 'limit' = 'forever';
const launched: Array<{ agent: string; profile: string; task: number; child: ChildProcess }> = [];
serviceSeams.launch = (a, t) => {
  let child: ChildProcess;
  if (mode === 'limit') {
    const at = new Date(Date.now() + 2 * 3_600_000);
    const h = at.getHours();
    const said = `You've hit your session limit · resets ${h % 12 || 12}${h < 12 ? 'am' : 'pm'} (America/Los_Angeles)`;
    const store = new Store(svcNameOf(t.id));
    fs.writeFileSync(path.join(store.paths.runs, `${t.id}-${t.runs.length + 1}-${a.name}.log`), `${JSON.stringify({ type: 'result', is_error: true, result: said })}\n`);
    child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(1), 200)'], { stdio: 'ignore' });
  } else {
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  }
  launched.push({ agent: a.name, profile: a.profile, task: t.id, child });
  return child;
};
/** Which swarm a task belongs to, for the limit stand-in's log (task ids are per swarm, so each swarm here uses its own range). */
const owners = new Map<number, string>();
const svcNameOf = (id: number) => owners.get(id) ?? 'check';

/** The usage each profile reports this step: shortest (5h) and weekly windows. */
type Usage = Record<string, { loggedIn?: boolean; h5: number; d7: number; resets5h?: number }>;
let clock = Date.now();
const win = (label: '5h' | '7d', usedPercent: number, resetsAt: number): Window => ({ label, usedPercent, windowMinutes: label === '5h' ? 300 : 10080, resetsAt });

function makeService(name: string, usage: () => Usage) {
  new Store(name).saveMeta({ name, dir: WORK, profile: 'superclaude', provider: 'claude-code', createdAt: Date.now(), profiles: { agents: 'superclaude' } } as never);
  const svc = new TaskManagerService(name) as unknown as Record<string, any>;
  svc.now = () => clock;
  svc.stopping = true;
  svc.liveProfiles = async () => PROFILES.filter((p) => p.provider === 'claude-code').map((p) => {
    const u = usage()[p.name];
    return {
      profile: p,
      identity: { loggedIn: u ? u.loggedIn !== false : false },
      usage: { windows: u ? [win('5h', u.h5, u.resets5h ?? clock + 4 * 3_600_000), win('7d', u.d7, clock + 5 * 86_400_000)] : [], source: 'live' },
      active: false,
      hazards: [],
    };
  });
  return svc;
}
/** One tick, in the tick's order, with a fresh usage poll. */
const step = async (svc: Record<string, any>): Promise<void> => {
  svc.quotaCache = undefined;
  await svc.refreshQuota();
  svc.autoSwitch();
  svc.reapLingering();
  svc.startDeferred();
  svc.assign();
  await sleep(150);
};
const inbox = (svc: Record<string, any>): Array<{ kind: string; text: string }> => fs.readFileSync(svc.store.paths.inbox, 'utf8').split('\n').filter(Boolean).map((l: string) => JSON.parse(l));
const notes = (svc: Record<string, any>, id: number) => svc.store.get(id).notes as Array<{ kind: string; author: string; text: string }>;
const eta = '2h';

/* ═══════════════════════ 1. the threshold: 90% does nothing, 96% moves the agents ═══════════════════════ */
const T1 = clock + 2 * 3_600_000; // superclaude's 5h window resets then
let usage: Usage = {
  superclaude: { h5: 90, d7: 50, resets5h: T1 },
  work: { h5: 30, d7: 40 },
  personal: { h5: 70, d7: 50 },
  spare: { loggedIn: false, h5: 1, d7: 1 },
};
const svc = makeService('check', () => usage);
svc.addAgent('friday-1', 'superclaude');
svc.addAgent('friday-2', 'superclaude');
svc.addAgent('friday-3', 'superclaude');
const A = svc.createTask({ title: 'the run that checkpoints when asked', eta, agent: 'friday-1' });
const B = svc.createTask({ title: 'the run that never checkpoints', eta, agent: 'friday-3' });
svc.dispatchTask(A.id, 'friday-1', 'check');
svc.dispatchTask(B.id, 'friday-3', 'check');
await step(svc);
check(svc.agent('friday-1').state === 'working' && svc.agent('friday-3').state === 'working', 'friday-1 and friday-3 are working on superclaude');
check(svc.store.team().every((a: { switchTo?: string; profile: string }) => !a.switchTo && a.profile === 'superclaude'), 'at 90% nobody moves');

usage = { ...usage, superclaude: { h5: 96, d7: 50, resets5h: T1 } };
await step(svc);
const f2 = svc.agent('friday-2');
check(f2.profile === 'work' && !f2.switchTo, 'at 96% the idle friday-2 moves to work at once', `profile ${f2.profile}`);
check(svc.agent('friday-1').switchTo === 'work' && svc.agent('friday-3').switchTo === 'work', 'the running friday-1 and friday-3 are asked to move to work');
check(svc.agent('friday-1').profile === 'superclaude' && svc.agent('friday-1').state === 'working', 'and keep running on superclaude until they checkpoint');
check(svc.store.meta().profiles?.agents === 'work', 'new agents for this GM are created on work from now on');
const said = inbox(svc).find((i) => i.kind === 'quota' && /^Auto-switch/.test(i.text));
check(!!said && /superclaude/.test(said.text) && /work/.test(said.text) && /96%/.test(said.text) && /friday-2/.test(said.text) && /friday-1/.test(said.text), "the GM's inbox says who moves, from where to where, why, with the figures", said?.text.slice(0, 220) ?? 'no such item');
const notice = svc.notice('friday-1') as string | null;
check(!!notice && /Write a checkpoint now/.test(notice) && /where your files are/.test(notice) && /so you are moving to the/.test(notice), "friday-1's next tool call and result carry the checkpoint request (and the hook's pattern)", notice?.slice(0, 120) ?? 'none');

/* the memory: work reads the same folder superclaude learned in */
const workMemory = profileMemoryDir(PROFILES[1] as never, slug);
const shared = sharedMemoryDir(slug);
const isLink = (p: string) => { try { return fs.lstatSync(p).isSymbolicLink() && fs.realpathSync(p) === fs.realpathSync(shared); } catch { return false; } };
check(fs.existsSync(path.join(shared, 'build-needs-node-24.md')), "superclaude's own note is in the project's shared memory");
check(isLink(workMemory) && isLink(scMemory), "work's and superclaude's memory folders both link to the shared one");
check(fs.existsSync(path.join(workMemory, 'build-needs-node-24.md')), 'so work reads what superclaude learned');

/* ═══════════════════════ 2. friday-1 writes its checkpoint and ends: #A continues on work ═══════════════════════ */
svc.checkpoint(A.id, 'friday-1', 'Done: the parser. Next: the tests. Files: src/parse.ts, uncommitted.');
launched.find((l) => l.agent === 'friday-1' && l.task === A.id)!.child.kill();
await sleep(300);
await step(svc);
const a = svc.store.get(A.id);
check(svc.agent('friday-1').profile === 'work' && !svc.agent('friday-1').switchTo, 'friday-1 is on work once its run has ended');
check(a.runs[0]?.exit === 'compacted' && /superclaude → work/.test(a.runs[0]?.exitNote ?? ''), "#A's first run ends as a checkpoint and a move", a.runs[0]?.exitNote);
const relaunchA = launched.filter((l) => l.task === A.id).at(-1)!;
check(a.status === 'in_progress' && a.runs.length === 2 && relaunchA.profile === 'work', '#A continues on work', `status ${a.status}, runs ${a.runs.length}, last launch on ${relaunchA.profile}`);
const moveNoteA = notes(svc, A.id).find((n) => /^Moved from profile superclaude to work/.test(n.text));
check(!!moveNoteA && /96% of its 5h window/.test(moveNoteA.text) && /resetting at/.test(moveNoteA.text), "#A's board note says it moved from superclaude to work because superclaude reached 96%, resetting at …", moveNoteA?.text.slice(0, 160));

/* ═══════════════════════ 3. friday-3 never writes one: the wait is bounded ═══════════════════════ */
clock += SWITCH_CHECKPOINT_WAIT_MS - 10_000;
await step(svc);
check(svc.agent('friday-3').profile === 'superclaude' && svc.agent('friday-3').switchTo === 'work', 'inside the 3-minute wait friday-3 is left to write its own checkpoint');
clock += 20_000;
await step(svc);
await sleep(300);
await step(svc);
const b = svc.store.get(B.id);
const tmCheckpoint = notes(svc, B.id).find((n) => n.kind === 'checkpoint' && n.author === 'task manager');
check(svc.agent('friday-3').profile === 'work', 'past the wait friday-3 is stopped and moved to work');
check(!!tmCheckpoint && /moved off the superclaude profile/.test(tmCheckpoint.text), 'the task manager wrote the checkpoint for it', tmCheckpoint?.text.slice(0, 120));
check(b.status === 'in_progress' && launched.filter((l) => l.task === B.id).at(-1)!.profile === 'work', '#B continues on work');
check(inbox(svc).some((i) => i.kind === 'info' && /move from superclaude to work is complete/.test(i.text)), 'the GM hears when the move is complete');

/* ═══════════════════════ 4. no flapping ═══════════════════════ */
// The owner puts friday-2 back on superclaude by hand; superclaude is still at 96% in the same window.
svc.moveAgent('friday-2', 'superclaude');
await step(svc);
check(svc.agent('friday-2').profile === 'superclaude' && !svc.agent('friday-2').switchTo, 'superclaude is left at most once per window: friday-2, put back by hand, is not moved again', `profile ${svc.agent('friday-2').profile}`);
svc.moveAgent('friday-2', 'work');
// superclaude's figure drops (its window has not reset); then work fills up. The move must not go back to superclaude.
usage = { ...usage, superclaude: { h5: 50, d7: 50, resets5h: T1 }, work: { h5: 96, d7: 40, resets5h: clock + 3 * 3_600_000 } };
await step(svc);
check(svc.agent('friday-1').switchTo === 'personal' && svc.agent('friday-2').profile === 'personal', 'when work fills up, the agents go to personal, not back to superclaude before its reset', `friday-1 → ${svc.agent('friday-1').switchTo}, friday-2 on ${svc.agent('friday-2').profile}`);
clock += SWITCH_CHECKPOINT_WAIT_MS + 1_000;
await step(svc);
await sleep(300);
await step(svc);

/* ═══════════════════════ 5. no profile qualifies: nobody moves, the GM hears it once ═══════════════════════ */
usage = { ...usage, personal: { h5: 96, d7: 50, resets5h: clock + 3 * 3_600_000 } };
await step(svc);
await step(svc);
const none = inbox(svc).filter((i) => i.kind === 'quota' && /no other profile can take its task agents/.test(i.text));
check(svc.store.team().every((a: { profile: string; switchTo?: string }) => a.profile === 'personal' && !a.switchTo), 'with every other profile spent, left this window or not logged in, nobody moves');
check(none.length === 1 && /spare is not logged in/.test(none[0]!.text) && /work was left this window/.test(none[0]!.text), "the GM's inbox says why, once", none.map((i) => i.text.slice(0, 200)).join(' | ') || 'no such item');

/* the target choice on its own: after superclaude's reset it is a target again */
const left = new Map([['superclaude', T1]]);
const pick = (now: number) => chooseTarget('personal', [
  { profile: 'superclaude', loggedIn: true, metered: false, windows: [win('5h', 85, T1), win('7d', 50, T1 + 86_400_000)] },
  { profile: 'work', loggedIn: true, metered: false, windows: [win('5h', 60, now + 3_600_000), win('7d', 70, now + 86_400_000)] },
  { profile: 'meter', loggedIn: true, metered: true, windows: [] },
], { now, leftUntil: left });
check(pick(T1 - 60_000).to === 'work', 'target choice: the lowest under 80% in every window (work at 70%), not a profile left this window');
check(pick(T1 + 60_000).to === 'superclaude', 'target choice: once its window has reset, superclaude is a target again (its 85% was the old window)');

/* ═══════════════════════ 6. a run hits the account's limit: it moves instead of waiting for the reset ═══════════════════════ */
let limitUsage: Usage = { superclaude: { h5: 60, d7: 50 }, work: { h5: 30, d7: 40 }, personal: { h5: 70, d7: 50 } };
const lim = makeService('lim', () => limitUsage);
lim.addAgent('lim-1', 'superclaude');
lim.addAgent('lim-2', 'superclaude');
const L2 = lim.createTask({ title: 'running beside it', eta, agent: 'lim-2' });
owners.set(L2.id, 'lim');
lim.dispatchTask(L2.id, 'lim-2', 'check');
await step(lim);
const L = lim.createTask({ title: 'the run that hits the limit', eta, agent: 'lim-1' });
owners.set(L.id, 'lim');
mode = 'limit';
lim.dispatchTask(L.id, 'lim-1', 'check');
await step(lim);
mode = 'forever';
await sleep(600);
await step(lim);
await sleep(300);
await step(lim);
const l = lim.store.get(L.id);
check(l.runs[0]?.exit === 'failed' && /session limit/.test(l.runs[0]?.exitNote ?? ''), "the limit is read from the run's log", l.runs[0]?.exitNote);
check(lim.agent('lim-1').profile === 'work' && l.status === 'in_progress' && launched.filter((x) => x.task === L.id).at(-1)!.profile === 'work', 'at the limit, with work under 80%, lim-1 moves to work and the task continues there', `lim-1 on ${lim.agent('lim-1').profile}, #${L.id} ${l.status}`);
check(lim.agent('lim-2').profile === 'work' && lim.store.get(L2.id).status === 'in_progress' && notes(lim, L2.id).some((n) => n.kind === 'checkpoint' && n.author === 'task manager'), 'lim-2, running on the same spent profile, is stopped at once with a checkpoint and continues on work');
check(inbox(lim).some((i) => i.kind === 'quota' && /hit its limit/.test(i.text) && /move from superclaude to work/.test(i.text)), "the GM's inbox says the limit was hit and where the agents went");

// The same with nowhere to go: the task waits for the reset, as before, and the GM hears why.
limitUsage = { superclaude: { h5: 60, d7: 50 }, work: { h5: 90, d7: 40 }, personal: { h5: 85, d7: 50 } };
const lim0 = makeService('lim0', () => limitUsage);
lim0.addAgent('nil-1', 'superclaude');
await step(lim0);
const N = lim0.createTask({ title: 'nowhere to go', eta, agent: 'nil-1' });
owners.set(N.id, 'lim0');
mode = 'limit';
lim0.dispatchTask(N.id, 'nil-1', 'check');
await step(lim0);
mode = 'forever';
await sleep(600);
await step(lim0);
const n = lim0.store.get(N.id);
check(n.status === 'blocked' && n.blockedOn?.kind === 'quota' && n.blockedOn.profile === 'superclaude' && lim0.agent('nil-1').profile === 'superclaude', 'at the limit with no profile under 80%, the task waits for the reset on superclaude', `${n.status} ${JSON.stringify(n.blockedOn)}`);
check(inbox(lim0).some((i) => i.kind === 'quota' && /No other profile can take the work/.test(i.text)), "the GM's inbox says no other profile can take it");

/* ═══ clean up ═══ */
for (const l of launched) {
  try { l.child.kill('SIGKILL'); } catch { /* gone */ }
}
fs.rmSync(HOME, { recursive: true, force: true });
console.log(failed === 0 ? `all ${all} PASS` : `${failed} of ${all} FAILED`);
process.exit(failed === 0 ? 0 : 1);
