/**
 * ═══ KEEPING THE SHARED INDEX SHORT ENOUGH TO READ (#2793) ═══
 *
 * Every session loads the project's MEMORY.md whole. One profile's index was already 175 lines; merged across three
 * profiles (#2792) genie's came to 768, which is a wall of text at the top of every conversation and costs real money
 * on every single turn.
 *
 * `am memory tidy` groups the lines under TOPIC PAGES. A topic page is itself an ordinary memory note — the same front
 * matter, the same folder — whose body is a list of the notes it covers. MEMORY.md then carries one line per topic
 * instead of one line per note, in the style the personal profile already used by hand:
 *
 *   - [Browser and screen lessons](browser-and-screen-lessons.md) — index of 42 notes on …
 *
 * THREE RULES IT MUST NEVER BREAK, and the check holds it to all three:
 *   1. No note is deleted and no note is renamed. Tidying only ever ADDS topic pages and rewrites MEMORY.md.
 *   2. Every note is reachable from MEMORY.md within ONE hop — either it still has its own line, or it is listed on a
 *      topic page that MEMORY.md names.
 *   3. The words of every existing note are left exactly as they were.
 *
 * HOW NOTES ARE GROUPED, without asking a model. The folder usually already holds pages somebody wrote by hand; those
 * are found first and their notes come out of the index straight away. Whatever is left is grouped by the words in the
 * note names: the word that covers the most remaining notes becomes a topic, those notes go under it, and so on until
 * the index fits. A word that is too common to mean anything is ignored, and a run never folds a topic smaller than
 * five notes — a page of three is not worth a hop. Anything still unmatched keeps its own line, so nothing is forced
 * into a topic it does not belong to.
 *
 * WHEN THE GROUPING IS WRONG, a person fixes it in memory-topics.json beside the folder, and tidy follows it: a topic
 * can be named, given its own matching words, handed notes by name, and any note can be told to keep its own line.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from './paths.js';
import { BACKUPS_ROOT, SHARED_ROOT, indexLinesOf, noteFiles, projectSlug, sharedMemoryDir } from './memory.js';

/** Over this many lines, tidy has work to do. */
export const FOLD_OVER = 180;
/** It stops making topics once the index is down to this. */
export const FOLD_TO = 180;
/** A topic worth a hop holds at least this many notes. */
export const SMALLEST_TOPIC = 5;
/**
 * And at most this many, so one broad word cannot swallow the whole folder. It is set well above the biggest page
 * anybody has written by hand (59), because a real family of notes should not be cut in half by a round number.
 */
export const BIGGEST_TOPIC = 150;

/**
 * checks/memory-tidy.ts's deliberate fault; empty in the app.
 *   drop_line  ONE note that went under a topic is left off that topic page, while its own line is still taken out of
 *              MEMORY.md — so nothing anywhere points at it any more. One line, not a page's worth, because a single
 *              missing line is exactly what a careless check would not notice, and it is the one mistake that quietly
 *              loses a memory for good.
 */
export const tidySeams = { breakFor: '' as '' | 'drop_line' };

/** Words that name no topic: grammar, and nouns too vague to be a heading. */
const STOP = new Set(
  (
    'a an the and or of to in on for is are was were be been it its that this with from by at as not no can cannot ' +
    'never always one two his her their our we you if when what which who how why do does did done into over under ' +
    'out up down off than then there here all any each more most some such only own same so too very also must has ' +
    'have had they them per every nothing without inside outside between through around again ' +
    'name line empty hour answer word point place thing part time day moment need needs needed make makes made get ' +
    'gets got give gives given take takes taken keep keeps kept put puts say says said see sees seen use uses used ' +
    'show shows shown still just even after before first last next new old real another way ways'
  ).split(/\s+/),
);

export interface TidyTopic {
  /** The heading, as MEMORY.md and the page itself say it. */
  title: string;
  /** The page's file name, e.g. browser-and-screen-lessons.md. */
  file: string;
  /** The notes it covers, by file name. */
  notes: string[];
  /** Written by this run, or already in the folder. */
  made: boolean;
}

export interface TidyPlan {
  projectPath: string;
  shared: string;
  /** How long MEMORY.md is now, and how long it would be after. */
  before: number;
  after: number;
  /** Pages the folder already had, and the ones this run would write. */
  kept: TidyTopic[];
  made: TidyTopic[];
  /** Notes that keep a line of their own. */
  loose: string[];
  /** The MEMORY.md this run would write. */
  index: string[];
  /** Every topic page's words, by file name — only for the pages this run would write. */
  pages: Map<string, string>;
  /** Nothing to do: the index is already short enough. */
  alreadyShort: boolean;
  /** It could not get under the target; says why. */
  short: string | null;
}

/* ═══ reading the folder ═══ */

const readText = (file: string): string => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};
const indexTarget = (line: string): string | null => /\]\(([^)]+\.md)\)/.exec(line)?.[1] ?? null;
const linkTarget = (line: string): string | null => /\[\[([^\]]+)\]\]/.exec(line)?.[1] ?? null;

/** A note's own title and the hook after it, from the line MEMORY.md already had, else from the note itself. */
function titleAndHook(line: string | undefined, file: string, text: string): { title: string; hook: string } {
  if (line !== undefined) {
    const title = /\[([^\]]+)\]/.exec(line)?.[1];
    const hook = /\)\s*—\s*(.+)$/.exec(line)?.[1] ?? '';
    if (title !== undefined && title !== '') return { title, hook };
  }
  const described = /^description:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? '';
  const named = /^name:\s*(.+)$/m.exec(text)?.[1]?.trim();
  const slug = file.replace(/\.md$/, '');
  const words = (named !== undefined && named !== '' ? named : slug).replace(/-/g, ' ');
  return { title: words.charAt(0).toUpperCase() + words.slice(1), hook: described };
}

/**
 * The pages the folder already has. A page is a note whose bullets are mostly links to other notes we hold — which is
 * what somebody writing an index by hand produces, and what this command writes. Five links at least, so an ordinary
 * note that happens to mention a few others is not mistaken for one.
 */
function pagesAlready(dir: string, notes: readonly string[]): TidyTopic[] {
  const have = new Set(notes.map((n) => n.replace(/\.md$/, '')));
  const out: TidyTopic[] = [];
  for (const file of notes) {
    const text = readText(path.join(dir, file));
    const bullets = text.split('\n').filter((l) => l.trim().startsWith('- '));
    const links = bullets.map(linkTarget).filter((t): t is string => t !== null && have.has(t));
    if (links.length < SMALLEST_TOPIC || links.length < bullets.length * 0.7) continue;
    const { title } = titleAndHook(undefined, file, text);
    out.push({ title, file, notes: links.map((t) => `${t}.md`), made: false });
  }
  return out;
}

/* ═══ what a person can override ═══ */

export interface TopicOverride {
  /** The heading to use. */
  name?: string;
  /** The page's file name; worked out from the name when left out. */
  file?: string;
  /** Extra words that put a note under this topic. */
  match?: string[];
  /** Notes named outright, whatever their words say. */
  notes?: string[];
}
export interface TidyOverrides {
  topics?: TopicOverride[];
  /** Notes that must keep their own line in MEMORY.md. */
  ignore?: string[];
}

export function overridesFile(slug: string): string {
  return path.join(SHARED_ROOT, slug, 'memory-topics.json');
}

export function readOverrides(slug: string): TidyOverrides {
  try {
    const raw = JSON.parse(fs.readFileSync(overridesFile(slug), 'utf8')) as TidyOverrides;
    return { topics: Array.isArray(raw.topics) ? raw.topics : [], ignore: Array.isArray(raw.ignore) ? raw.ignore : [] };
  } catch {
    return { topics: [], ignore: [] };
  }
}

/* ═══ grouping ═══ */

/** The words a note's name offers as a topic, singular-ish and without the grammar. */
function termsOf(file: string): Set<string> {
  const out = new Set<string>();
  const stem = file.replace(/\.md$/, '').replace(/\.from-[a-z0-9]+$/i, '');
  for (const raw of stem.split('-')) {
    let w = raw.toLowerCase();
    if (w.length < 3 || STOP.has(w)) continue;
    if (w.endsWith('s') && w.length > 4) w = w.slice(0, -1);
    if (STOP.has(w)) continue;
    out.add(w);
  }
  return out;
}

const titleCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const fileFor = (title: string): string =>
  `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.md`;

/* ═══ the plan ═══ */

export function planTidy(projectPath: string): TidyPlan {
  const slug = projectSlug(projectPath);
  const shared = sharedMemoryDir(slug);
  const notes = noteFiles(shared);
  const lines = indexLinesOf(path.join(shared, 'MEMORY.md'));
  /** The line MEMORY.md already had for each note, so a folded line keeps the words somebody wrote for it. */
  const lineFor = new Map<string, string>();
  /** Lines that point at no note — a heading somebody wrote at the top. They are kept, untouched, where they were. */
  const headerLines: string[] = [];
  for (const line of lines) {
    const target = indexTarget(line);
    if (target === null) headerLines.push(line);
    else lineFor.set(target, line);
  }

  const empty = (extra: Partial<TidyPlan> = {}): TidyPlan => ({
    projectPath, shared, before: lines.length, after: lines.length,
    kept: [], made: [], loose: [], index: lines, pages: new Map(), alreadyShort: false, short: null, ...extra,
  });
  if (!fs.existsSync(shared)) return empty({ short: 'this project has no shared memory yet' });
  if (lines.length <= FOLD_OVER) return empty({ alreadyShort: true });

  const overrides = readOverrides(slug);
  const mustStay = new Set(overrides.ignore ?? []);

  /** 1 · pages the folder already has: their notes need no line of their own. */
  const kept = pagesAlready(shared, notes);
  const keptFiles = new Set(kept.map((p) => p.file));
  const covered = new Set<string>();
  for (const p of kept) for (const n of p.notes) covered.add(n);

  /** A note that is itself a page keeps its own line — that line IS the topic. */
  const groupable = notes.filter((n) => !covered.has(n) && !keptFiles.has(n) && !mustStay.has(n));
  const terms = new Map(groupable.map((n) => [n, termsOf(n)]));

  const made: TidyTopic[] = [];
  const left = new Set(groupable);
  const taken = new Set<string>([...notes, ...kept.map((p) => p.file)]);

  /** 2 · the topics a person asked for, before anything is worked out. */
  for (const t of overrides.topics ?? []) {
    const title = (t.name ?? '').trim();
    if (title === '') continue;
    const words = new Set((t.match ?? []).map((w) => w.toLowerCase()));
    const named = new Set(t.notes ?? []);
    const members = [...left].filter((n) => named.has(n) || [...terms.get(n) ?? []].some((w) => words.has(w))).sort();
    if (members.length === 0) continue;
    const file = t.file ?? fileFor(title);
    made.push({ title, file, notes: members, made: true });
    for (const n of members) left.delete(n);
    taken.add(file);
  }

  /** 3 · the rest, by the word that covers the most of what is left. */
  let short: string | null = null;
  const projected = (): number => kept.length + made.length + left.size + headerLines.length + mustStay.size;
  while (projected() > FOLD_TO) {
    const count = new Map<string, number>();
    for (const n of left) for (const w of terms.get(n) ?? []) count.set(w, (count.get(w) ?? 0) + 1);
    const ranked = [...count.entries()]
      .filter(([, c]) => c >= SMALLEST_TOPIC)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (ranked.length === 0) {
      short = `nothing left that ${SMALLEST_TOPIC} or more notes share`;
      break;
    }
    const [term] = ranked[0]!;
    let members = [...left].filter((n) => (terms.get(n) ?? new Set()).has(term)).sort();
    if (members.length > BIGGEST_TOPIC) members = members.slice(0, BIGGEST_TOPIC);
    /** A second word most of them also share reads better as a heading, and matches the pages written by hand. */
    const second = new Map<string, number>();
    for (const n of members) {
      for (const w of terms.get(n) ?? []) {
        if (w === term || w.includes(term) || term.includes(w)) continue;
        second.set(w, (second.get(w) ?? 0) + 1);
      }
    }
    const pair = [...second.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    const words = pair !== undefined && pair[1] >= members.length * 0.35 ? `${term} and ${pair[0]}` : term;
    let title = `${titleCase(words)} lessons`;
    let file = fileFor(title);
    if (taken.has(file)) {
      /** The folder already holds a page by that name; never write over a note. */
      title = `${titleCase(words)} notes`;
      file = fileFor(title);
    }
    if (taken.has(file)) {
      /** Still taken: these notes keep their own lines rather than have this run write over somebody's note. */
      for (const n of members) {
        left.delete(n);
        mustStay.add(n);
      }
      continue;
    }
    made.push({ title, file, notes: members, made: true });
    taken.add(file);
    for (const n of members) left.delete(n);
  }

  /** 4 · the pages themselves, and the index. */
  const pages = new Map<string, string>();
  for (const [i, topic] of made.entries()) pages.set(topic.file, pageText(shared, topic, lineFor, i === 0));

  const index: string[] = [];
  for (const p of kept) index.push(lineFor.get(p.file) ?? `- [${p.title}](${p.file}) — index of ${p.notes.length} notes`);
  for (const t of made) index.push(`- [${t.title}](${t.file}) — index of ${t.notes.length} notes${hookOf(shared, t)}`);
  for (const line of headerLines) index.push(line);
  for (const n of [...left, ...mustStay].sort()) {
    const line = lineFor.get(n);
    if (line !== undefined) index.push(line);
    else {
      const { title, hook } = titleAndHook(undefined, n, readText(path.join(shared, n)));
      index.push(`- [${title}](${n})${hook === '' ? '' : ` — ${hook}`}`);
    }
  }

  return {
    projectPath, shared,
    before: lines.length,
    after: index.length,
    kept, made,
    loose: [...left, ...mustStay].sort(),
    index,
    pages,
    alreadyShort: false,
    short,
  };
}

/**
 * A couple of the topic's own titles, so its line says more than a count — short, because this line is read at the
 * top of every session and the whole point of folding was to get those lines back.
 */
function hookOf(dir: string, topic: TidyTopic): string {
  const said: string[] = [];
  for (const n of topic.notes) {
    const { title } = titleAndHook(undefined, n, readText(path.join(dir, n)));
    said.push(title.toLowerCase());
    if (said.join('; ').length > 50) break;
  }
  if (said.length === 0) return '';
  const words = said.join('; ');
  return ` on ${words.length > 60 ? `${words.slice(0, 58).trimEnd()}…` : `${words}${topic.notes.length > said.length ? '; …' : ''}`}`;
}

/** The topic page itself: an ordinary note whose body lists what it covers. */
function pageText(dir: string, topic: TidyTopic, lineFor: Map<string, string>, first: boolean): string {
  const name = topic.file.replace(/\.md$/, '');
  const rows: string[] = [];
  for (const file of topic.notes) {
    /** The deliberate fault: exactly one note, on one page, left off. */
    if (tidySeams.breakFor === 'drop_line' && first && file === topic.notes[0]) continue;
    const { title, hook } = titleAndHook(lineFor.get(file), file, readText(path.join(dir, file)));
    rows.push(`- [[${file.replace(/\.md$/, '')}]] ${title}${hook === '' ? '' : ` — ${hook}`}`);
  }
  return [
    '---',
    `name: ${name}`,
    `description: Index of ${topic.notes.length} notes about ${topic.title.replace(/ (lessons|notes)$/, '').toLowerCase()}`,
    'metadata:',
    '  node_type: memory',
    '  type: reference',
    `  modified: ${new Date().toISOString()}`,
    '---',
    '',
    `${topic.notes.length} notes on this. Each is its own memory:`,
    '',
    ...rows,
    '',
  ].join('\n');
}

/* ═══ doing it ═══ */

export interface TidyResult {
  plan: TidyPlan;
  backup: string | null;
}

/** Copy the folder first, then write the new pages and the new MEMORY.md. No note is touched. */
export function applyTidy(projectPath: string): TidyResult {
  const plan = planTidy(projectPath);
  if (plan.alreadyShort || (plan.made.length === 0 && plan.pages.size === 0)) return { plan, backup: null };
  const slug = projectSlug(projectPath);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(BACKUPS_ROOT, `memory-tidy-${stamp}`, slug);
  ensureDir(path.dirname(backup));
  fs.cpSync(plan.shared, backup, { recursive: true, dereference: true });

  for (const [file, text] of plan.pages) fs.writeFileSync(path.join(plan.shared, file), text);
  fs.writeFileSync(path.join(plan.shared, 'MEMORY.md'), plan.index.join('\n') + '\n');
  return { plan, backup };
}

/* ═══ holding it to its promises ═══ */

export interface TidyAudit {
  ok: boolean;
  /** Notes that nothing points at any more. */
  unreachable: string[];
  /** Notes that are gone, or whose words changed. */
  lost: string[];
  indexLines: number;
}

/**
 * Read the folder back and prove the three rules: every note still there with its words unchanged, every note
 * reachable from MEMORY.md within one hop, and the index as short as it said. `before` is the folder as it was.
 */
export function auditTidy(shared: string, before: Map<string, string>): TidyAudit {
  const now = noteFiles(shared);
  const nowSet = new Set(now);
  const lost: string[] = [];
  for (const [file, text] of before) {
    if (!nowSet.has(file)) {
      lost.push(file);
      continue;
    }
    if (readText(path.join(shared, file)) !== text) lost.push(file);
  }
  const lines = indexLinesOf(path.join(shared, 'MEMORY.md'));
  const named = new Set<string>();
  for (const line of lines) {
    const target = indexTarget(line);
    if (target !== null) named.add(target);
  }
  const reachable = new Set(named);
  for (const file of named) {
    for (const line of readText(path.join(shared, file)).split('\n')) {
      const to = linkTarget(line);
      if (to !== null) reachable.add(`${to}.md`);
    }
  }
  const unreachable = now.filter((n) => !reachable.has(n));
  return { ok: lost.length === 0 && unreachable.length === 0, unreachable, lost, indexLines: lines.length };
}

/** The folder as it stands, for the audit to compare against. */
export function snapshotNotes(shared: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of noteFiles(shared)) out.set(file, readText(path.join(shared, file)));
  return out;
}
