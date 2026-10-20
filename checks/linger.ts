/**
 * A run that reported but never exited must not block its agent (#2794): a narrow check of the task manager itself.
 *
 * friday-6 reported #2783 done, its process stayed alive, and every start for friday-6 returned without a word: #2792,
 * pinned to it, sat open for 25 minutes while the board showed friday-6 idle. This replays that in a throwaway home
 * under /tmp with a made-up profile. The agent's process is a stand-in (a real process that never exits, with a child of
 * its own, like the task bridge under a real run), so no session is started and nothing real is touched. The clock is
 * the check's own, so the 90-second grace and the 5-minute stall take no real time.
 *
 *   node --import tsx checks/linger.ts                 all PASS
 *   BREAK=no_reap node --import tsx checks/linger.ts   must FAIL: the lingering run is never ended, the pinned task never starts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'am-lingercheck-'));
process.env.AGENT_MANAGER_HOME = HOME;

const { TaskManagerService, serviceSeams, LINGER_GRACE_MS, PINNED_STALL_MS } = await import('../src/swarm/service.js');
const { Store } = await import('../src/swarm/store.js');
const { loadSwarmConfig, saveSwarmConfig } = await import('../src/swarm/registry.js');

const BREAK = process.env.BREAK ?? '';
if (BREAK === 'no_reap') serviceSeams.breakFor = 'no_reap';

let failed = 0;
let all = 0;
const check = (ok: boolean, what: string, detail = ''): void => {
  all += 1;
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `  (${detail})` : ''}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number | undefined): boolean => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/* ═══ a throwaway home: one profile, one swarm, at most one run working at a time ═══ */
const PROFILE = { name: 'alpha', provider: 'claude-code', home: path.join(HOME, 'profiles', 'claude-code', 'alpha'), managed: true, createdAt: new Date().toISOString() };
fs.mkdirSync(PROFILE.home, { recursive: true });
fs.writeFileSync(path.join(HOME, 'profiles.json'), JSON.stringify({ version: 1, profiles: [PROFILE] }, null, 2));
saveSwarmConfig({ ...loadSwarmConfig(), restartGapSec: 0, maxWorking: 1, autostart: false });
const WORK = path.join(HOME, 'work');
fs.mkdirSync(WORK, { recursive: true });
new Store('check').saveMeta({ name: 'check', dir: WORK, profile: 'alpha', provider: 'claude-code', createdAt: Date.now() } as never);

/** Every launch is a stand-in: a process that never exits by itself, with a child of its own under it. */
const launched: ChildProcess[] = [];
serviceSeams.launch = () => {
  const child = spawn(process.execPath, ['-e', "require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
  launched.push(child);
  return child;
};

const svc = new TaskManagerService('check') as unknown as Record<string, any>;
/** The check's own clock, and no tick of its own: each step below is run by hand, in the tick's order. */
let clock = Date.now();
svc.now = () => clock;
svc.stopping = true;
const step = async (): Promise<void> => {
  svc.reapLingering();
  await sleep(300);
  svc.startDeferred();
  svc.assign();
  svc.watchPinned();
};
const events = (id: number): string[] => fs.readFileSync(svc.store.paths.events, 'utf8').split('\n').filter(Boolean).map((l: string) => JSON.parse(l)).filter((e: { taskId?: number }) => e.taskId === id).map((e: { text: string }) => e.text);
const inbox = (): string[] => fs.readFileSync(svc.store.paths.inbox, 'utf8').split('\n').filter(Boolean).map((l: string) => JSON.parse(l).text);
const eta = '2h';
/** The processes directly under a process (the stand-in's own child, like the task bridge under a real run). */
const kids = (pid: number | undefined): number[] => execFileSync('ps', ['-Ao', 'pid=,ppid=']).toString().trim().split('\n')
  .map((l) => l.trim().split(/\s+/).map(Number)).filter(([, pp]) => pp === pid).map(([p]) => p!);

svc.addAgent('friday-6', 'alpha');
svc.addAgent('friday-7', 'alpha');

/* ═══ 1. friday-6 runs #A, reports it, and its process stays alive ═══ */
const A = svc.createTask({ title: 'the run that will not exit', eta, agent: 'friday-6' });
svc.dispatchTask(A.id, 'friday-6', 'check');
await step();
const first = launched[0];
check(svc.store.get(A.id).status === 'in_progress' && alive(first?.pid), `#${A.id} starts on friday-6`, `pid ${first?.pid}`);
svc.report({ id: A.id, agent: 'friday-6', changed: 'x', verified: 'y', left: 'z' });
check(svc.agent('friday-6').state === 'idle' && alive(first?.pid), 'after the report the board shows friday-6 idle while its process is still alive');
await sleep(300);
const under = kids(first?.pid);
check(under.length === 1 && alive(under[0]), 'the stand-in has a process of its own under it', `${under.join(', ')}`);

/* ═══ 2. a task pinned to friday-6 waits, and says why, instead of vanishing ═══ */
const B = svc.createTask({ title: 'the pinned task', eta, agent: 'friday-6' });
svc.dispatchTask(B.id, 'friday-6', 'check');
await step();
const said = events(B.id).find((e) => /has not exited yet/.test(e));
check(!!said, `#${B.id} says on its events why it waits`, said ?? 'no such event');
check(svc.store.get(B.id).status === 'open' && launched.length === 1, `#${B.id} does not start while the old process lives (no second process on the same agent)`);

/* ═══ 3. inside the grace the old run is left alone; past it, it and its child are ended and #B starts ═══ */
clock += LINGER_GRACE_MS - 5_000;
await step();
check(alive(first?.pid), 'inside the 90-second grace the old process is left alone');
clock += 10_000;
await step();
await sleep(500);
await step();
check(!alive(first?.pid), 'past the grace the old process is ended');
check(under.length > 0 && under.every((pid) => !alive(pid)), 'and so is the process under it');
const ended = events(A.id).find((e) => /still running .* after #\d+ left it/.test(e));
check(!!ended, `#${A.id}'s events say its run was ended and why`, ended ?? 'no such event');
const runA = svc.store.get(A.id).runs.at(-1);
check(!!runA?.endedAt && runA.exit === 'done', `#${A.id}'s run is closed as done`, `exit ${runA?.exit}`);
check(svc.store.get(B.id).status === 'in_progress' && svc.store.get(B.id).agent === 'friday-6', `the pinned #${B.id} starts on friday-6`, `status ${svc.store.get(B.id).status}`);

/* ═══ 4. a pinned task that waits 5 minutes on an agent shown idle reaches the GM as stalled, naming the cause ═══ */
// friday-6 is working on #B and only one run may work, so #C, pinned to friday-7 (idle), cannot start.
const C = svc.createTask({ title: 'pinned to an idle agent', eta, agent: 'friday-7' });
svc.dispatchTask(C.id, 'friday-7', 'check');
await step();
check(!inbox().some((t) => t.includes(`#${C.id} `) && /has not started/.test(t)), `#${C.id} is not called stalled at once`);
clock += PINNED_STALL_MS + 1_000;
await step();
const stalled = inbox().find((t) => t.includes(`#${C.id} `) && /has not started/.test(t));
check(!!stalled && /max-working/.test(stalled), `after 5 minutes #${C.id} is in the GM's inbox as stalled, with the cause`, stalled?.slice(0, 160) ?? 'no such item');

/* ═══ clean up: every stand-in process and the process under it (children first, before they move to a new parent) ═══ */
const leftovers = [...launched.flatMap((c) => kids(c.pid)), ...under, ...launched.map((c) => c.pid!)];
for (const pid of leftovers) {
  try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
}
fs.rmSync(HOME, { recursive: true, force: true });
console.log(failed === 0 ? `all ${all} PASS` : `${failed} of ${all} FAILED`);
process.exit(failed === 0 ? 0 : 1);
