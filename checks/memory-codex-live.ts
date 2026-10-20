/**
 * Does a real codex agent actually USE the shared memory it is told about (#2793)?
 *
 * The other checks run in seconds and ask nobody. This one starts the real Codex CLI on a throwaway project with the
 * very start instructions `am` would give it, and then looks at the folder to see what it did. It is run BY HAND,
 * because it needs a logged-in codex profile, needs the network, and costs a little of that profile's usage.
 *
 *   node --import tsx checks/memory-codex-live.ts            on the `codex` profile (the subscription)
 *   PROFILE=kimi node --import tsx checks/memory-codex-live.ts
 *
 * WHAT IT PROVES. Codex keeps no memory of its own, so everything here rests on five lines of start instructions. The
 * agent is told nothing about the project except where that folder is; the task does not mention memory at all. If it
 * comes back with a note in the folder, in the right shape, and a line added to the index, then the pointer carries
 * its own weight. Nothing is asserted about WHAT it chose to write down — that is its judgement, not ours.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The REAL profile is looked up first, straight out of the real profiles file: everything after this line runs in a
 * throwaway home, and a throwaway home knows about no profiles at all.
 */
const PROFILE = process.env.PROFILE ?? 'codex';
interface Listed { name: string; provider: string; home: string }
const listed = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.agent-manager', 'profiles.json'), 'utf8')) as { profiles: Listed[] };
const profile = listed.profiles.find((p) => p.name === PROFILE && p.provider === 'codex');
if (profile === undefined) {
  console.log(`no codex profile called ${PROFILE}; nothing run`);
  process.exit(1);
}

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'am-codexlive-'));
process.env.AGENT_MANAGER_HOME = HOME;

const { sharedMemoryDir, projectSlug, withSharedMemory, noteFiles, indexLinesOf } = await import('../src/core/memory.js');

let failed = 0;
const check = (ok: boolean, what: string, detail = ''): void => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `  (${detail})` : ''}`);
};

/* ═══ a throwaway project with one fact in it, and a memory folder with one note already ═══ */
/**
 * The project teaches something BY DOING, and its README is wrong on purpose: the build refuses to run from the root
 * and says so. An agent that only reads the README learns nothing new, which is the whole difficulty — a memory is
 * worth writing when the work tells you something the files do not.
 */
const PROJECT = path.join(HOME, 'tiny-service');
fs.mkdirSync(path.join(PROJECT, 'server'), { recursive: true });
fs.writeFileSync(path.join(PROJECT, 'README.md'), [
  '# tiny-service', '', 'A small service.', '',
  'Build it with `./build.sh`, from the repository root.', '',
].join('\n'));
const build = path.join(PROJECT, 'build.sh');
fs.writeFileSync(build, [
  '#!/bin/sh',
  'if [ "$(basename "$PWD")" != "server" ]; then',
  '  echo "build: refusing to run from $(basename "$PWD"). Run it from the server/ folder." >&2',
  '  exit 1',
  'fi',
  'echo "built tiny-service"',
  '',
].join('\n'));
fs.chmodSync(build, 0o755);

const slug = projectSlug(PROJECT);
const shared = sharedMemoryDir(slug);
fs.mkdirSync(shared, { recursive: true });
fs.writeFileSync(path.join(shared, 'who-runs-this.md'), [
  '---', 'name: who-runs-this', 'description: Who to ask about tiny-service', 'metadata:', '  type: project', '---', '',
  'Ask Dana before changing anything under server/.', '',
].join('\n'));
fs.writeFileSync(path.join(shared, 'MEMORY.md'), '- [Who runs this](who-runs-this.md) — ask Dana before touching server/\n');

const notesBefore = noteFiles(shared);
const indexBefore = indexLinesOf(path.join(shared, 'MEMORY.md'));

/* ═══ exactly the start instructions am would give it ═══ */
const base = 'You are friday-9, a task agent. Follow the task brief you were given.';
const systemPrompt = withSharedMemory(base, 'codex', PROJECT);
check(systemPrompt !== base, 'am would add the pointer to this agent\'s start instructions');
console.log('');
console.log(systemPrompt.slice(base.length).trim());
console.log('');

/** An ordinary piece of work. It says nothing about memory: whether anything is written down is the pointer's doing. */
const task = 'Build this service and tell me whether the build worked.';
const log = path.join(HOME, 'run.log');
console.log(`running codex on the ${PROFILE} profile — this costs a little of its usage…`);
try {
  /**
   * The model am gives a codex task agent (`am config model.codex-agents`). It has to be named: the codex profile's
   * own default is a model a ChatGPT account may not use, and the run dies with a 400 before it reads anything.
   */
  const model = process.env.MODEL ?? 'gpt-5.6-terra';
  const out = execFileSync('codex', [
    'exec', '--skip-git-repo-check',
    '-c', 'sandbox_mode="danger-full-access"',
    '-m', model,
    `${systemPrompt}\n\n${task}`,
  ], { cwd: PROJECT, env: { ...process.env, CODEX_HOME: profile.home }, encoding: 'utf8', timeout: 600_000 });
  fs.writeFileSync(log, out);
} catch (e) {
  fs.writeFileSync(log, String(e));
  console.log(`codex exited badly; its output is in ${log}`);
}

/* ═══ what it left behind ═══ */
const notesAfter = noteFiles(shared);
const added = notesAfter.filter((n) => !notesBefore.includes(n));
const indexAfter = indexLinesOf(path.join(shared, 'MEMORY.md'));

check(added.length > 0, 'it wrote a note into the shared folder', added.join(', ') || 'nothing new');
for (const file of added) {
  const text = fs.readFileSync(path.join(shared, file), 'utf8');
  check(/^---\n/.test(text) && /\nname:\s*\S/.test(text) && /\ndescription:\s*\S/.test(text) && /metadata:/.test(text),
    `${file} has the front matter the pointer asked for`, text.split('\n').slice(0, 6).join(' / '));
}
check(indexAfter.length > indexBefore.length, 'and added a line to the index', `${indexBefore.length} → ${indexAfter.length} lines`);
const newLines = indexAfter.filter((l) => !indexBefore.includes(l));
check(newLines.some((l) => added.some((f) => l.includes(`(${f})`))), 'whose line points at the note it wrote', newLines.join(' | ').slice(0, 160));
check(fs.existsSync(path.join(shared, 'who-runs-this.md')), 'and the note that was already there is untouched');

console.log('');
console.log('what it wrote:');
for (const file of added) console.log(`\n--- ${file}\n${fs.readFileSync(path.join(shared, file), 'utf8')}`);
console.log(`\nMEMORY.md now:\n${indexAfter.join('\n')}`);
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAIL`);
console.log(`(the throwaway home is ${HOME}; delete it when you are done reading)`);
process.exit(failed === 0 ? 0 : 1);
