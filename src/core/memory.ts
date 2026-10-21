/**
 * ═══ ONE MEMORY PER PROJECT, SHARED BY EVERY PROFILE (#2791) ═══
 *
 * Claude Code keeps what it learns about a folder in
 *   <profile home>/projects/<project slug>/memory/
 * with one note per file and a MEMORY.md index that is loaded into every session. Each profile had its own copy, so
 * the same project was learned three times over and the copies drifted apart.
 *
 * A project can now have ONE home for those notes, under ~/.agent-manager/shared/projects/<slug>/memory, and every
 * profile's own folder becomes a link to it. Claude Code follows the link for reading and for writing — proved with
 * real sessions on a throwaway project: one profile saved a note, another profile opened the same folder and read it
 * out of its index without being told.
 *
 * Merging never loses a note. Two files with the same name and the same words become one. When they differ, the one
 * changed most recently keeps the plain name — so every [[link]] written inside a note still points somewhere — and
 * the other is kept beside it as <name>.from-<profile>.md. The indexes are merged as a union, one line per file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { AM_HOME, ensureDir } from './paths.js';
import { loadConfig, type Profile } from './config.js';

export const SHARED_ROOT = path.join(AM_HOME, 'shared', 'projects');
export const BACKUPS_ROOT = path.join(AM_HOME, 'backups');
/** An index this long is hard for a session to hold: say so (#2793 turns it into topic pages). */
export const INDEX_LINES_WARN = 200;

/**
 * checks/memory-share.ts's deliberate faults; empty in the app.
 *   drop_older     a note that differs between profiles keeps only the newest copy, so the other profile's words are lost
 *   no_backup      the folders are swapped for links without being copied anywhere first
 *   latest_backup  undoing reaches for the newest backup of any shape, so a tidy's copy of the shared folder shadows
 *                  the share's own copy of each profile's folder
 */
export const memorySeams = { breakFor: '' as '' | 'drop_older' | 'no_backup' | 'latest_backup' };

/**
 * Claude Code's own folder name for a project: the real path with every slash as a dash. It is the REAL path that
 * matters — on this Mac /tmp is itself a link to /private/tmp, and a session opened in /tmp/x keeps its memory under
 * -private-tmp-x. Taking the path as typed would make a folder no session ever reads.
 */
export function realProjectPath(projectPath: string): string {
  const abs = path.resolve(projectPath);
  try {
    return fs.realpathSync(abs);
  } catch {
    /* not there yet: the path as given is the best we have */
    return abs;
  }
}
export function projectSlug(projectPath: string): string {
  return realProjectPath(projectPath).replace(/\//g, '-');
}

export function sharedMemoryDir(slug: string): string {
  return path.join(SHARED_ROOT, slug, 'memory');
}

export function profileMemoryDir(profile: Profile, slug: string): string {
  return path.join(profile.home, 'projects', slug, 'memory');
}

/** Every profile whose tool keeps memory this way: its folder becomes a link to the shared one. */
export function memoryProfiles(): Profile[] {
  return loadConfig().profiles.filter((p) => p.provider === 'claude-code');
}

/** The profiles that get told where the shared folder is instead, because their tool keeps no memory of its own. */
export function pointedProfiles(): Profile[] {
  return loadConfig().profiles.filter((p) => p.provider === 'codex');
}

/**
 * ═══ WHAT A CODEX AGENT IS TOLD (#2793) ═══
 *
 * Claude Code finds this folder by itself — it is where it keeps its own memory, and the index is loaded into every
 * session. Codex has no such thing, so an agent on a codex profile is simply told, in its start instructions, where
 * the folder is and how to read and write it. Null when the project has no shared memory, so a codex agent on an
 * ordinary project carries nothing extra.
 *
 * It is deliberately five lines. It goes in front of EVERY start and resume on that profile, so anything longer is
 * paid for again on every task.
 */
export function sharedMemoryNote(projectPath: string): string | null {
  const dir = sharedMemoryDir(projectSlug(projectPath));
  if (!fs.existsSync(dir)) return null;
  return [
    `This project keeps one memory, shared by every tool, in ${dir}.`,
    'Read its MEMORY.md first: one line per note, with a link. Open the few notes that bear on your task.',
    'Before you finish, if you learned something a later session would need and that folder does not already say it,',
    'write <short-name>.md there with front matter — name, description, and metadata.type of user, feedback, project',
    'or reference — and add ONE line to MEMORY.md: "- [Title](<short-name>.md) — a hook". Never change a note already there.',
  ].join('\n');
}

/** The start instructions an agent is given, with that pointer added when its tool needs one. */
export function withSharedMemory(systemPrompt: string, provider: string, projectPath: string): string {
  if (provider !== 'codex') return systemPrompt;
  const note = sharedMemoryNote(projectPath);
  return note === null ? systemPrompt : `${systemPrompt}\n\n${note}`;
}

export type FolderState =
  /** A link to this project's shared folder: already sharing. */
  | 'shared'
  /** A link somewhere else — left alone, and said out loud. */
  | 'other-link'
  /** Its own folder with notes in it. */
  | 'own'
  /** Nothing there yet, or an empty folder. */
  | 'empty';

export function folderState(dir: string, shared: string): FolderState {
  let link: fs.Stats | undefined;
  try {
    link = fs.lstatSync(dir);
  } catch {
    return 'empty';
  }
  if (link.isSymbolicLink()) {
    const target = safeRealpath(dir);
    return target !== null && target === safeRealpath(shared) ? 'shared' : 'other-link';
  }
  return noteFiles(dir).length > 0 || fs.existsSync(path.join(dir, 'MEMORY.md')) ? 'own' : 'empty';
}

function safeRealpath(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** The notes themselves: every .md in the folder except the index. */
export function noteFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== 'MEMORY.md')
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

const readText = (file: string): string => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};
const modifiedAt = (file: string): number => {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
};
const sizeOf = (file: string): number => {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
};
/**
 * The same note, whatever the file's own front matter says about when it was written: the words alone decide whether
 * two copies are identical, so a difference in a stored timestamp is still one note.
 */
const sameWords = (a: string, b: string): boolean => body(a) === body(b);
const body = (text: string): string => text.replace(/\r\n/g, '\n').trim();

/* ═══ what a share would do ═══ */

export interface ConflictSide {
  profile: string;
  bytes: number;
  modified: string;
  /** The name it is kept under after the merge. */
  keptAs: string;
}
export interface Conflict {
  name: string;
  sides: ConflictSide[];
}
export interface ProfilePlan {
  profile: string;
  state: FolderState;
  dir: string;
  notes: number;
  indexLines: number;
}
export interface SharePlan {
  projectPath: string;
  slug: string;
  shared: string;
  profiles: ProfilePlan[];
  /** Notes that are the same in two or more profiles and become one file. */
  identical: number;
  /** Notes only one profile had. */
  onlyOne: number;
  conflicts: Conflict[];
  /** How many lines the merged index ends up with. */
  indexLines: number;
  /** The merged folder as it would be written: file name to its words. */
  files: Map<string, string>;
  /** Where each merged file's words came from, for the report. */
  from: Map<string, string>;
  index: string[];
}

interface Candidate {
  profile: string;
  file: string;
  text: string;
  modified: number;
  bytes: number;
}

/**
 * Work out the merged folder without touching anything. Profiles already linked to this project's shared folder are
 * counted but never merged again — their notes are already in it.
 */
export function planShare(projectPath: string, profiles: Profile[] = memoryProfiles()): SharePlan {
  const slug = projectSlug(projectPath);
  const shared = sharedMemoryDir(slug);
  const plans: ProfilePlan[] = [];
  /** note name -> the copies to merge, oldest profile first. */
  const byName = new Map<string, Candidate[]>();
  /** Lines of every index, keyed by the file each line points at. */
  const indexFor = new Map<string, { line: string; profile: string; modified: number }>();
  const looseIndexLines: string[] = [];

  /** The shared folder's own notes come first: a second share must not undo the first. */
  const sources: Array<{ profile: string; dir: string }> = [];
  if (fs.existsSync(shared)) sources.push({ profile: 'shared', dir: shared });
  for (const p of profiles) {
    const dir = profileMemoryDir(p, slug);
    const state = folderState(dir, shared);
    plans.push({ profile: p.name, state, dir, notes: noteFiles(dir).length, indexLines: indexLinesOf(path.join(dir, 'MEMORY.md')).length });
    if (state === 'own') sources.push({ profile: p.name, dir });
  }

  for (const src of sources) {
    for (const name of noteFiles(src.dir)) {
      const file = path.join(src.dir, name);
      const list = byName.get(name) ?? [];
      list.push({ profile: src.profile, file, text: readText(file), modified: modifiedAt(file), bytes: sizeOf(file) });
      byName.set(name, list);
    }
    for (const line of indexLinesOf(path.join(src.dir, 'MEMORY.md'))) {
      const target = indexTarget(line);
      if (target === null) {
        if (!looseIndexLines.includes(line)) looseIndexLines.push(line);
        continue;
      }
      const had = indexFor.get(target);
      const when = modifiedAt(path.join(src.dir, target));
      /** One line per file: the newest copy's wording wins, so the index matches the note that kept the name. */
      if (had === undefined || when > had.modified) indexFor.set(target, { line, profile: src.profile, modified: when });
    }
  }

  const files = new Map<string, string>();
  const from = new Map<string, string>();
  const conflicts: Conflict[] = [];
  let identical = 0;
  let onlyOne = 0;

  for (const [name, list] of [...byName.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (list.length === 1) {
      onlyOne += 1;
      files.set(name, list[0]!.text);
      from.set(name, list[0]!.profile);
      continue;
    }
    const first = list[0]!;
    if (list.every((c) => sameWords(c.text, first.text))) {
      identical += 1;
      /** Same words everywhere: one file, the newest copy's bytes (they only differ in line endings). */
      const newest = [...list].sort((a, b) => b.modified - a.modified)[0]!;
      files.set(name, newest.text);
      from.set(name, list.map((c) => c.profile).join(' + '));
      continue;
    }
    /** They differ: the one changed most recently keeps the name so every [[link]] to it still points somewhere. */
    const ordered = [...list].sort((a, b) => b.modified - a.modified);
    const winner = ordered[0]!;
    files.set(name, winner.text);
    from.set(name, winner.profile);
    const sides: ConflictSide[] = [{ profile: winner.profile, bytes: winner.bytes, modified: new Date(winner.modified).toISOString(), keptAs: name }];
    const base = name.replace(/\.md$/, '');
    for (const other of ordered.slice(1)) {
      /** Two profiles can hold the same older words: keep one copy of them, not one per profile. */
      if (sameWords(other.text, winner.text)) continue;
      const keptAs = `${base}.from-${other.profile}.md`;
      if (memorySeams.breakFor === 'drop_older') continue;
      files.set(keptAs, other.text);
      from.set(keptAs, other.profile);
      sides.push({ profile: other.profile, bytes: other.bytes, modified: new Date(other.modified).toISOString(), keptAs });
    }
    if (sides.length > 1) conflicts.push({ name, sides });
    else identical += 1;
  }

  /** The index: one line per note, plus a line for every copy kept beside a conflict, so nothing is invisible. */
  const index: string[] = [...looseIndexLines];
  for (const name of [...files.keys()].sort((a, b) => a.localeCompare(b))) {
    const known = indexFor.get(name);
    if (known !== undefined) {
      index.push(known.line);
      continue;
    }
    const kept = /^(.*)\.from-([^.]+)\.md$/.exec(name);
    if (kept !== null) {
      const parent = indexFor.get(`${kept[1]}.md`);
      const title = parent ? indexTitle(parent.line) ?? kept[1]! : kept[1]!;
      const whose = kept[2] === 'shared' ? 'the copy the shared folder already had' : `the ${kept[2]} profile's own copy`;
      index.push(`- [${title}](${name}) — ${whose}, kept when the two differed`);
      continue;
    }
    index.push(`- [${titleOf(files.get(name) ?? '', name)}](${name})`);
  }

  return {
    projectPath: realProjectPath(projectPath),
    slug,
    shared,
    profiles: plans,
    identical,
    onlyOne,
    conflicts,
    indexLines: index.length,
    files,
    from,
    index,
  };
}

/** The index's own pointer lines ("- [Title](file.md) — hook"), in order, without blank lines. */
export function indexLinesOf(file: string): string[] {
  const text = readText(file);
  if (text === '') return [];
  return text.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() !== '');
}

const indexTarget = (line: string): string | null => /\]\(([^)]+\.md)\)/.exec(line)?.[1] ?? null;
const indexTitle = (line: string): string | null => /\[([^\]]+)\]/.exec(line)?.[1] ?? null;
/** A note's own name line, for an index line that was never written. */
function titleOf(text: string, fallbackFile: string): string {
  const name = /^name:\s*(.+)$/m.exec(text)?.[1]?.trim();
  return name && name !== '' ? name : fallbackFile.replace(/\.md$/, '');
}

/* ═══ doing it ═══ */

export interface ShareResult {
  plan: SharePlan;
  backup: string | null;
  linked: string[];
}

/** Back up every folder that is about to change, then write the merged folder, then swap in the links. */
export function applyShare(projectPath: string, profiles: Profile[] = memoryProfiles()): ShareResult {
  const plan = planShare(projectPath, profiles);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(BACKUPS_ROOT, `memory-${stamp}`, plan.slug);
  let backedUp = false;

  for (const p of plan.profiles) {
    if (p.state !== 'own' || memorySeams.breakFor === 'no_backup') continue;
    const to = path.join(backup, p.profile);
    ensureDir(path.dirname(to));
    fs.cpSync(p.dir, to, { recursive: true });
    backedUp = true;
  }
  /** The shared folder, when there already is one, is backed up too: a second share must be undoable as well. */
  if (fs.existsSync(plan.shared)) {
    const to = path.join(backup, '_shared');
    ensureDir(path.dirname(to));
    fs.cpSync(plan.shared, to, { recursive: true, dereference: true });
    backedUp = true;
  }

  ensureDir(plan.shared);
  /** The folder name cannot be turned back into a path (a dash in a folder's own name reads like a slash), so the
   *  project's real path is written beside it once and read back by `am memory status`. */
  fs.writeFileSync(path.join(SHARED_ROOT, plan.slug, 'project.json'), JSON.stringify({ path: plan.projectPath }, null, 2) + '\n');
  for (const [name, text] of plan.files) fs.writeFileSync(path.join(plan.shared, name), text);
  fs.writeFileSync(path.join(plan.shared, 'MEMORY.md'), plan.index.join('\n') + '\n');

  const linked: string[] = [];
  for (const p of plan.profiles) {
    if (p.state === 'shared' || p.state === 'other-link') continue;
    linkTo(p.dir, plan.shared);
    linked.push(p.profile);
  }
  return { plan, backup: backedUp ? backup : null, linked };
}

/** Replace a folder (or nothing) with a link to the shared one. The old folder is removed only after it is backed up. */
function linkTo(dir: string, shared: string): void {
  ensureDir(path.dirname(dir));
  try {
    const link = fs.lstatSync(dir);
    if (link.isSymbolicLink()) fs.unlinkSync(dir);
    else fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* nothing there */
  }
  fs.symlinkSync(shared, dir);
}

/**
 * (5) A profile joining a project that already shares its memory: fold whatever it has learned on its own into the
 * shared folder, then link. Does nothing when the project has no shared memory, so it is safe to call on every start.
 */
export function ensureLinked(projectPath: string, profile: Profile): 'linked' | 'merged' | 'already' | 'none' {
  if (profile.provider !== 'claude-code') return 'none';
  const slug = projectSlug(projectPath);
  const shared = sharedMemoryDir(slug);
  if (!fs.existsSync(shared)) return 'none';
  const dir = profileMemoryDir(profile, slug);
  const state = folderState(dir, shared);
  if (state === 'shared' || state === 'other-link') return 'already';
  if (state === 'own') {
    applyShare(projectPath, [profile]);
    return 'merged';
  }
  linkTo(dir, shared);
  return 'linked';
}

/* ═══ status ═══ */

export interface ProjectStatus {
  slug: string;
  projectPath: string;
  shared: string;
  notes: number;
  indexLines: number;
  linked: string[];
  separate: Array<{ profile: string; notes: number; indexLines: number }>;
}

/** Every project that has a shared memory, and every profile that has its own notes for one. */
export function memoryStatus(profiles: Profile[] = memoryProfiles()): ProjectStatus[] {
  const slugs = new Set<string>();
  try {
    for (const e of fs.readdirSync(SHARED_ROOT, { withFileTypes: true })) if (e.isDirectory()) slugs.add(e.name);
  } catch {
    /* nothing shared yet */
  }
  const out: ProjectStatus[] = [];
  for (const slug of [...slugs].sort()) {
    const shared = sharedMemoryDir(slug);
    const linked: string[] = [];
    const separate: ProjectStatus['separate'] = [];
    for (const p of profiles) {
      const dir = profileMemoryDir(p, slug);
      const state = folderState(dir, shared);
      if (state === 'shared') linked.push(p.name);
      else if (state === 'own') separate.push({ profile: p.name, notes: noteFiles(dir).length, indexLines: indexLinesOf(path.join(dir, 'MEMORY.md')).length });
    }
    out.push({
      slug,
      projectPath: projectPathOf(slug),
      shared,
      notes: noteFiles(shared).length,
      indexLines: indexLinesOf(path.join(shared, 'MEMORY.md')).length,
      linked,
      separate,
    });
  }
  return out;
}

/** The project a shared folder belongs to, as it was written when it was shared; the folder name alone cannot say. */
export function projectPathOf(slug: string): string {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(SHARED_ROOT, slug, 'project.json'), 'utf8')) as { path?: unknown };
    if (typeof raw.path === 'string' && raw.path !== '') return raw.path;
  } catch {
    /* written only from this version on */
  }
  return slug;
}

/* ═══ unsharing ═══ */

export interface UnshareResult {
  slug: string;
  restored: Array<{ profile: string; from: 'shared' | 'backup'; notes: number }>;
}

/**
 * Give every linked profile its own folder back. By default each one gets a copy of the shared folder as it stands,
 * so nothing written since the share is lost; `fromBackup` puts back what that profile had before it, instead.
 */
export function unshare(projectPath: string, opts: { fromBackup?: boolean } = {}, profiles: Profile[] = memoryProfiles()): UnshareResult {
  const slug = projectSlug(projectPath);
  const shared = sharedMemoryDir(slug);
  const restored: UnshareResult['restored'] = [];
  const backup = opts.fromBackup === true ? newestBackup(slug) : null;
  for (const p of profiles) {
    const dir = profileMemoryDir(p, slug);
    if (folderState(dir, shared) !== 'shared') continue;
    const mine = backup === null ? null : path.join(backup, p.name);
    const source = mine !== null && fs.existsSync(mine) ? mine : shared;
    fs.unlinkSync(dir);
    ensureDir(path.dirname(dir));
    fs.cpSync(source, dir, { recursive: true, dereference: true });
    restored.push({ profile: p.name, from: source === shared ? 'shared' : 'backup', notes: noteFiles(dir).length });
  }
  return { slug, restored };
}

/**
 * The most recent backup of the profiles' OWN folders for this project, if any — one folder per profile, as a share
 * leaves behind. `am memory tidy` also backs this project up (memory-tidy-<when>), but that is a copy of the shared
 * folder with the notes directly in it; restoring from that would quietly hand every profile the same shared copy
 * instead of what it had before the share, so a tidy must not shadow the share it followed.
 */
export function newestBackup(slug: string): string | null {
  let names: string[] = [];
  try {
    names = fs
      .readdirSync(BACKUPS_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('memory-'))
      .map((e) => e.name)
      .sort()
      .reverse();
  } catch {
    return null;
  }
  for (const name of names) {
    const dir = path.join(BACKUPS_ROOT, name, slug);
    if (!fs.existsSync(dir)) continue;
    if (memorySeams.breakFor !== 'latest_backup' && !holdsProfileFolders(dir)) continue;
    return dir;
  }
  return null;
}

/** A share's backup: a folder for each profile it copied. Anything flat is a copy of the shared folder, not that. */
function holdsProfileFolders(dir: string): boolean {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).some((e) => e.isDirectory());
  } catch {
    return false;
  }
}
