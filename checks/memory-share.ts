/**
 * One shared memory per project (#2791): a narrow check of the merge, the links, status, unshare and the auto-join.
 *
 * Everything happens in a throwaway home under /tmp with made-up profiles, so no real profile and no real project is
 * touched. It does not start any session: that Claude Code follows a linked memory folder for reading and for writing
 * was proved separately, with two real sessions on a throwaway project.
 *
 *   node --import tsx checks/memory-share.ts                   all PASS
 *   BREAK=drop_older node --import tsx checks/memory-share.ts  must FAIL: the older copy of a note that differs is lost
 *   BREAK=no_backup  node --import tsx checks/memory-share.ts  must FAIL: folders are swapped for links with no copy kept
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'am-memcheck-'));
process.env.AGENT_MANAGER_HOME = HOME;

const { memorySeams, planShare, applyShare, memoryStatus, unshare, ensureLinked, projectSlug, sharedMemoryDir, profileMemoryDir, INDEX_LINES_WARN, noteFiles, indexLinesOf } = await import('../src/core/memory.js');
const { memoryStatusCommand } = await import('../src/commands/memory.js');
import type { Profile } from '../src/core/config.js';

const BREAK = process.env.BREAK ?? '';
if (BREAK === 'drop_older' || BREAK === 'no_backup') memorySeams.breakFor = BREAK;

let failed = 0;
let all = 0;
const check = (ok: boolean, what: string, detail = ''): void => {
  all += 1;
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `  (${detail})` : ''}`);
};

/* ═══ a throwaway home: three profiles and one project ═══ */
const PROJECT = path.join(HOME, 'work', 'my-project');
fs.mkdirSync(PROJECT, { recursive: true });
const slug = projectSlug(PROJECT);

const profile = (name: string): Profile => ({
  name,
  provider: 'claude-code',
  home: path.join(HOME, 'profiles', 'claude-code', name),
  managed: true,
  createdAt: new Date().toISOString(),
});
const A = profile('alpha');
const B = profile('beta');
const C = profile('gamma');
fs.mkdirSync(HOME, { recursive: true });
fs.writeFileSync(path.join(HOME, 'profiles.json'), JSON.stringify({ version: 1, profiles: [A, B, C] }, null, 2));

const note = (name: string, words: string): string => `---\nname: ${name}\ndescription: ${words}\nmetadata:\n  type: project\n---\n\n${words}\n`;
const write = (p: Profile, file: string, text: string, when: number): void => {
  const dir = profileMemoryDir(p, slug);
  fs.mkdirSync(dir, { recursive: true });
  const at = path.join(dir, file);
  fs.writeFileSync(at, text);
  fs.utimesSync(at, when / 1000, when / 1000);
};
const NOW = Date.now();
/** The same note in both: one file after the merge. */
write(A, 'same.md', note('same', 'The build runs from the line folder.'), NOW - 50_000);
write(B, 'same.md', note('same', 'The build runs from the line folder.'), NOW - 40_000);
/** The same name, different words: alpha's is newer, so alpha's keeps the name. */
write(A, 'drifted.md', note('drifted', 'The port is 4536 and a restart takes two minutes.'), NOW - 10_000);
write(B, 'drifted.md', note('drifted', 'The port is 4536.'), NOW - 90_000);
/** One each that the other has never seen; alpha's points at the drifted note by name. */
write(A, 'only-alpha.md', note('only-alpha', 'Alpha learned this. See [[drifted]].'), NOW - 20_000);
write(B, 'only-beta.md', note('only-beta', 'Beta learned this.'), NOW - 20_000);
fs.writeFileSync(path.join(profileMemoryDir(A, slug), 'MEMORY.md'), [
  '- [Same](same.md) — both profiles wrote this',
  '- [Drifted](drifted.md) — alpha words',
  '- [Only alpha](only-alpha.md) — alpha only',
].join('\n') + '\n');
fs.writeFileSync(path.join(profileMemoryDir(B, slug), 'MEMORY.md'), [
  '- [Same](same.md) — both profiles wrote this',
  '- [Drifted](drifted.md) — beta words',
  '- [Only beta](only-beta.md) — beta only',
].join('\n') + '\n');

/* ═══ A: the plan, before anything is touched ═══ */
const plan = planShare(PROJECT, [A, B]);
check(plan.identical === 1 && plan.onlyOne === 2 && plan.conflicts.length === 1,
  'the plan counts: one note the same in both, two only one profile had, one that differs',
  `${plan.identical} same, ${plan.onlyOne} only one, ${plan.conflicts.length} differ`);
check(plan.conflicts[0]?.name === 'drifted.md' && plan.conflicts[0]?.sides[0]?.profile === 'alpha' && plan.conflicts[0]?.sides[0]?.keptAs === 'drifted.md',
  'the one changed most recently keeps the name', JSON.stringify(plan.conflicts[0]?.sides.map((s) => `${s.profile}→${s.keptAs}`)));
check(fs.existsSync(profileMemoryDir(A, slug)) && !fs.existsSync(sharedMemoryDir(slug)),
  'a dry run changes nothing: no shared folder, both profiles still have their own');

/* ═══ B: doing it ═══ */
const done = applyShare(PROJECT, [A, B]);
const shared = sharedMemoryDir(slug);
const inShared = noteFiles(shared);
check(inShared.join(',') === 'drifted.from-beta.md,drifted.md,only-alpha.md,only-beta.md,same.md',
  'the merged folder: one of each, and the other profile\'s copy of what differed', inShared.join(', '));
check(fs.readFileSync(path.join(shared, 'drifted.md'), 'utf8').includes('a restart takes two minutes'),
  'the newer words keep the plain name, so [[drifted]] still points at them');
check(fs.existsSync(path.join(shared, 'drifted.from-beta.md')) && fs.readFileSync(path.join(shared, 'drifted.from-beta.md'), 'utf8').includes('The port is 4536.'),
  'the older words are kept beside it, named for the profile they came from');
const index = indexLinesOf(path.join(shared, 'MEMORY.md'));
check(index.filter((l) => l.includes('(same.md)')).length === 1 && index.length === 5,
  'the index is the union with one line per file, and a line for the copy that was kept', `${index.length} lines: ${index.map((l) => /\(([^)]+)\)/.exec(l)?.[1]).join(', ')}`);
for (const p of [A, B]) {
  const dir = profileMemoryDir(p, slug);
  check(fs.lstatSync(dir).isSymbolicLink() && fs.realpathSync(dir) === fs.realpathSync(shared), `${p.name}'s folder is now a link to the shared one`);
}
check(done.backup !== null && fs.existsSync(path.join(done.backup!, 'alpha', 'drifted.md')) && fs.existsSync(path.join(done.backup!, 'beta', 'drifted.md')),
  'every folder it touched was copied first, both profiles', done.backup ?? 'no backup');
check(fs.readFileSync(path.join(done.backup!, 'beta', 'drifted.md'), 'utf8').includes('The port is 4536.'),
  'the copy holds what that profile had, word for word');

/* ═══ C: a session on either profile sees one folder ═══ */
fs.writeFileSync(path.join(profileMemoryDir(B, slug), 'written-by-beta.md'), note('written-by-beta', 'Beta wrote this after the share.'));
check(fs.existsSync(path.join(profileMemoryDir(A, slug), 'written-by-beta.md')),
  'a note written through one profile\'s folder is there through the other\'s');

/* ═══ D: status ═══ */
let rows = memoryStatus([A, B, C]);
check(rows.length === 1 && rows[0]!.linked.join(',') === 'alpha,beta' && rows[0]!.notes === 6,
  'status: who is linked and how many notes', JSON.stringify(rows[0] && { linked: rows[0].linked, notes: rows[0].notes, index: rows[0].indexLines }));

/* ═══ E: a profile that was away joins, and brings what it learned ═══ */
write(C, 'only-gamma.md', note('only-gamma', 'Gamma learned this on its own.'), NOW - 5_000);
write(C, 'drifted.md', note('drifted', 'The port is 4536, the restart window is thirty minutes.'), NOW + 60_000);
const joined = ensureLinked(PROJECT, C);
check(joined === 'merged' && fs.lstatSync(profileMemoryDir(C, slug)).isSymbolicLink(),
  'a profile with its own notes folds them in and then links', joined);
check(noteFiles(shared).includes('only-gamma.md') && fs.readFileSync(path.join(shared, 'drifted.md'), 'utf8').includes('thirty minutes')
  && fs.existsSync(path.join(shared, 'drifted.from-shared.md')),
  'what it learned is in the shared folder, its newer version keeps the name, and what was there is kept');
rows = memoryStatus([A, B, C]);
check(rows[0]!.linked.join(',') === 'alpha,beta,gamma' && rows[0]!.separate.length === 0, 'status: all three linked, none separate');

/* ═══ F: a long index is called out ═══ */
const longIndex = Array.from({ length: INDEX_LINES_WARN + 1 }, (_, i) => `- [Note ${i}](n${i}.md) — a line`).join('\n');
fs.writeFileSync(path.join(shared, 'MEMORY.md'), longIndex + '\n');
const said: string[] = [];
const realLog = console.log;
console.log = (...args: unknown[]): void => { said.push(args.map(String).join(' ')); };
memoryStatusCommand({});
console.log = realLog;
check(said.some((l) => l.includes(`over ${INDEX_LINES_WARN} lines`)), 'status warns when the index is over 200 lines', said.find((l) => l.includes('over')) ?? 'no warning');

/* ═══ G: unsharing gives each profile its own folder back ═══ */
const back = unshare(PROJECT, {}, [A, B, C]);
check(back.restored.length === 3 && back.restored.every((r) => r.from === 'shared'),
  'unshare: every linked profile gets its own folder again', JSON.stringify(back.restored.map((r) => `${r.profile}:${r.notes}`)));
for (const p of [A, B, C]) {
  const dir = profileMemoryDir(p, slug);
  check(!fs.lstatSync(dir).isSymbolicLink() && noteFiles(dir).includes('only-gamma.md') && noteFiles(dir).includes('only-beta.md'),
    `${p.name} has a real folder again, with everything the project had learned`);
}
check(fs.existsSync(shared), 'the shared folder is left where it is; nothing was deleted');

/* ═══ H: unsharing from the backup puts back what a profile had just before the share ═══ */
applyShare(PROJECT, [A, B, C]);
/** Written only in the shared folder, after the share: it must not come back with a restored folder. */
fs.writeFileSync(path.join(shared, 'after-the-share.md'), note('after-the-share', 'Learned while the memory was shared.'));
const old = unshare(PROJECT, { fromBackup: true }, [A, B, C]);
const betaDir = profileMemoryDir(B, slug);
check(old.restored.some((r) => r.profile === 'beta' && r.from === 'backup')
  && !noteFiles(betaDir).includes('after-the-share.md')
  && noteFiles(betaDir).includes('only-gamma.md'),
  'unshare --from-backup: beta gets back exactly what it had just before the share, not what was learned after',
  JSON.stringify(old.restored.map((r) => `${r.profile}:${r.from}`)));
check(fs.existsSync(path.join(shared, 'after-the-share.md')), 'and what was learned while sharing stays in the shared folder');

console.log(failed === 0 ? `\nALL ${all} PASS` : `\n${failed} of ${all} FAIL`);
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
