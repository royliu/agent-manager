/**
 * Keeping the shared index short (#2793): a narrow check of the folding, and of what a codex agent is told.
 *
 * Everything happens in a throwaway home under /tmp with made-up profiles and made-up notes, so no real profile and
 * no real project is touched. The same folding was also run on a scratch copy of genie's real merged memory — 768
 * index lines down to 180, every note still there and reachable — and that run is in the task's report.
 *
 *   node --import tsx checks/memory-tidy.ts                   all PASS
 *   BREAK=drop_line node --import tsx checks/memory-tidy.ts   must FAIL: a folded note is left off its topic page,
 *                                                             so nothing in the index points at it any more
 *
 * THE ONE MISTAKE THAT WOULD MATTER is losing a memory: a note that keeps no line of its own and is not listed on the
 * page that replaced it is, for every session after, gone. The fault does exactly that, and the reachability check has
 * to catch it. A fault that only miscounted would be caught by the line count and would prove much less.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'am-tidycheck-'));
process.env.AGENT_MANAGER_HOME = HOME;

const { projectSlug, sharedMemoryDir, noteFiles, indexLinesOf, sharedMemoryNote, withSharedMemory, INDEX_LINES_WARN } = await import('../src/core/memory.js');
const { tidySeams, planTidy, applyTidy, auditTidy, snapshotNotes, overridesFile, FOLD_OVER, SMALLEST_TOPIC } = await import('../src/core/memorytidy.js');

const BREAK = process.env.BREAK ?? '';
if (BREAK === 'drop_line') tidySeams.breakFor = 'drop_line';

let failed = 0;
let all = 0;
const check = (ok: boolean, what: string, detail = ''): void => {
  all += 1;
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `  (${detail})` : ''}`);
};

/* ═══ a throwaway project with a long index ═══ */
const note = (name: string, words: string): string =>
  `---\nname: ${name}\ndescription: ${words}\nmetadata:\n  type: project\n---\n\n${words}\n`;

/**
 * A folder of notes: three families that each share an obvious word, a long tail that shares NOTHING with anybody
 * (so they can never be grouped and must keep their own lines), and one page somebody wrote by hand.
 */
function makeProject(name: string, byHandPage: boolean): { dir: string; shared: string; slug: string; lines: string[] } {
  const dir = path.join(HOME, 'work', name);
  fs.mkdirSync(dir, { recursive: true });
  const slug = projectSlug(dir);
  const shared = sharedMemoryDir(slug);
  fs.mkdirSync(shared, { recursive: true });
  const lines: string[] = [];
  const add = (file: string, title: string, words: string): void => {
    fs.writeFileSync(path.join(shared, file), note(file.replace(/\.md$/, ''), words));
    lines.push(`- [${title}](${file}) — ${words}`);
  };
  for (let i = 0; i < 55; i += 1) add(`the-browser-draws-${i}.md`, `The browser draws ${i}`, `what the browser draws, ${i}`);
  for (let i = 0; i < 50; i += 1) add(`a-database-row-${i}.md`, `A database row ${i}`, `how the database stores row ${i}`);
  for (let i = 0; i < 45; i += 1) add(`the-trader-card-${i}.md`, `The trader card ${i}`, `what a trader card shows, ${i}`);
  /** Each of these carries one word of its own, shared with no other note. */
  for (let i = 0; i < 150; i += 1) add(`w${i}x.md`, `On its own ${i}`, `something on its own, ${i}`);
  if (byHandPage) {
    const byHand = ['---', 'name: handwritten-pages', 'description: Index somebody wrote', 'metadata:', '  type: reference', '---', '',
      'Each is its own memory:', '',
      ...Array.from({ length: 10 }, (_, i) => `- [[the-browser-draws-${i}]] The browser draws ${i}`), ''].join('\n');
    fs.writeFileSync(path.join(shared, 'handwritten-pages.md'), byHand);
    lines.push('- [Handwritten pages](handwritten-pages.md) — index of 10 somebody wrote');
  }
  fs.writeFileSync(path.join(shared, 'MEMORY.md'), lines.join('\n') + '\n');
  return { dir, shared, slug, lines };
}

const { dir: PROJECT, shared, slug } = makeProject('my-project', true);
const notesBefore = noteFiles(shared);
const wordsBefore = snapshotNotes(shared);
const indexBefore = indexLinesOf(path.join(shared, 'MEMORY.md')).length;
check(indexBefore > INDEX_LINES_WARN, `the index starts over the ${INDEX_LINES_WARN} lines status warns about`, `${indexBefore} lines`);

/* ═══ A: the plan, before anything is touched ═══ */
const plan = planTidy(PROJECT);
check(plan.before === indexBefore && plan.after < plan.before, 'the plan shortens the index', `${plan.before} → ${plan.after}`);
check(plan.kept.some((p) => p.file === 'handwritten-pages.md' && p.notes.length === 10),
  'the page somebody wrote by hand is found and left alone', plan.kept.map((p) => `${p.file}:${p.notes.length}`).join(', '));
check(plan.made.length > 0 && plan.made.every((t) => t.notes.length >= SMALLEST_TOPIC),
  `no topic is smaller than ${SMALLEST_TOPIC} notes`, plan.made.map((t) => `${t.title}:${t.notes.length}`).join(', '));
check(plan.made.some((t) => /browser/i.test(t.title)) && plan.made.some((t) => /database/i.test(t.title)) && plan.made.some((t) => /trader/i.test(t.title)),
  'the three families each became a topic, named after what they share', plan.made.map((t) => t.title).join(' | '));
/** The name is not decoration: every note under a topic really does carry the word the topic is named after. */
check(plan.made.every((t) => {
  const word = t.title.toLowerCase().split(' ')[0]!;
  return t.notes.every((n) => n.toLowerCase().includes(word));
}), 'every note under a topic carries the word that topic is named after', plan.made.map((t) => t.title).join(' | '));
check(plan.loose.length > 100 && plan.loose.every((n) => /^w\d+x\.md$/.test(n)),
  'the notes that share nothing with anybody are left alone, each with its own line', `${plan.loose.length} on their own`);
check(noteFiles(shared).length === notesBefore.length && indexLinesOf(path.join(shared, 'MEMORY.md')).length === indexBefore,
  'a dry run changes nothing at all');

/* ═══ B: doing it ═══ */
const done = applyTidy(PROJECT);
const audit = auditTidy(shared, wordsBefore);
const after = indexLinesOf(path.join(shared, 'MEMORY.md')).length;

check(audit.lost.length === 0, 'no note was deleted, renamed, or changed by so much as a byte', audit.lost.slice(0, 4).join(', '));
check(audit.unreachable.length === 0, 'every note is reachable from the index within one hop', audit.unreachable.slice(0, 4).join(', '));
check(after < INDEX_LINES_WARN, `the index is under ${INDEX_LINES_WARN} lines`, `${indexBefore} → ${after}`);
check(after <= FOLD_OVER, `and under the ${FOLD_OVER} it folds at`, `${after} lines`);
check(noteFiles(shared).length === notesBefore.length + plan.made.length,
  'the only new files are the topic pages it said it would write', `${notesBefore.length} → ${noteFiles(shared).length}`);
check(done.backup !== null && fs.existsSync(path.join(done.backup!, 'MEMORY.md')),
  'the folder was copied before it was touched', done.backup ?? 'no backup');
check(fs.readFileSync(path.join(done.backup!, 'MEMORY.md'), 'utf8').split('\n').filter((l) => l.trim() !== '').length === indexBefore,
  'and the copy holds the long index, so the fold can be undone by hand');

/** The pages it wrote are ordinary notes: front matter, and a list of what they cover. */
const made = plan.made[0]!;
const page = fs.readFileSync(path.join(shared, made.file), 'utf8');
check(page.startsWith('---\nname: ') && /metadata:/.test(page) && page.includes('[['),
  'a topic page is an ordinary memory note whose body lists its own notes', made.file);
check(page.split('\n').filter((l) => l.trim().startsWith('- [[')).length === made.notes.length,
  'and it lists every one of them', `${made.notes.length} notes`);

/* ═══ C: running it again does nothing ═══ */
const twice = planTidy(PROJECT);
check(twice.alreadyShort, 'tidying an already short index does nothing the second time', `${twice.before} lines`);

/* ═══ D: a person can steer it, in a folder of its own ═══ */
const second = makeProject('steered-project', false);
fs.writeFileSync(overridesFile(second.slug), JSON.stringify({
  topics: [{ name: 'Everything about the database', match: ['database'] }],
  ignore: ['the-trader-card-0.md'],
}, null, 2));
const steered = planTidy(second.dir);
check(steered.made[0]?.title === 'Everything about the database' && steered.made[0]?.notes.length === 50,
  'the topic a person asked for is made first, named as they named it, with the notes its words match',
  steered.made.map((t) => `${t.title}:${t.notes.length}`).slice(0, 3).join(', '));
check(steered.made[0]?.file === 'everything-about-the-database.md',
  'and its page is named after the heading they gave it', steered.made[0]?.file ?? 'none');
check(!steered.made.some((t) => t.notes.includes('the-trader-card-0.md')) && steered.index.some((l) => l.includes('(the-trader-card-0.md)')),
  'a note told to keep its own line keeps it, and goes into no topic');

/* ═══ E: what a codex agent is told ═══ */
const told = sharedMemoryNote(PROJECT);
check(told !== null && told.includes(shared) && told.includes('MEMORY.md') && told.includes('metadata.type'),
  'a codex agent is told where the folder is, to read the index first, and how to write a note');
check(told !== null && told.split('\n').length <= 6 && told.length < 800,
  'and it is short enough to carry on every start', `${told?.split('\n').length} lines, ${told?.length} characters`);
const elsewhere = path.join(HOME, 'work', 'no-memory-here');
fs.mkdirSync(elsewhere, { recursive: true });
check(sharedMemoryNote(elsewhere) === null, 'a project with no shared memory adds nothing to the prompt');

const base = 'You are friday-9, a task agent.';
check(withSharedMemory(base, 'codex', PROJECT) !== base && withSharedMemory(base, 'codex', PROJECT).startsWith(base),
  'the pointer is added after the start instructions a codex agent already had');
check(withSharedMemory(base, 'claude-code', PROJECT) === base,
  'a Claude Code agent is told nothing extra: it finds the folder itself, because its own memory is that folder');
check(withSharedMemory(base, 'codex', elsewhere) === base, 'and a codex agent elsewhere carries nothing extra');

console.log(failed === 0 ? `\nALL ${all} PASS` : `\n${failed} of ${all} FAIL`);
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
