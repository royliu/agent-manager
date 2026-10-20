/**
 * `am memory share | status | unshare` — one home for what every profile has learned about a project (#2791).
 *
 * The notes themselves live in src/core/memory.ts; this is what you see and type.
 */
import fs from 'node:fs';
import path from 'node:path';
import { tildify } from '../core/paths.js';
import {
  INDEX_LINES_WARN,
  applyShare,
  ensureLinked,
  memoryProfiles,
  memoryStatus,
  newestBackup,
  planShare,
  unshare,
  type SharePlan,
} from '../core/memory.js';
import { bold, cyan, dim, green, red, yellow } from '../ui/format.js';

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The report a dry run prints, and the same summary a real share prints before it writes. */
function printPlan(plan: SharePlan, opts: { dryRun: boolean }): void {
  console.log('');
  console.log(`  ${bold(opts.dryRun ? 'Would share' : 'Sharing')} the memory of ${bold(tildify(plan.projectPath))}`);
  console.log(`  ${dim('one home for all of it:')} ${dim(tildify(plan.shared))}`);
  console.log('');
  const nameW = Math.max(8, ...plan.profiles.map((p) => p.profile.length));
  for (const p of plan.profiles) {
    const says =
      p.state === 'shared'
        ? green('already a link to this shared folder')
        : p.state === 'other-link'
          ? yellow('a link somewhere else — left alone')
          : p.state === 'own'
            ? `${plural(p.notes, 'note')}, ${plural(p.indexLines, 'index line')}`
            : dim('nothing yet');
    console.log(`    ${p.profile.padEnd(nameW)}  ${says}`);
  }
  console.log('');
  console.log(`  ${plural(plan.files.size, 'note')} after the merge`);
  console.log(`    ${plan.identical} the same in more than one profile, folded into one`);
  console.log(`    ${plan.onlyOne} in one profile only`);
  console.log(`    ${plan.conflicts.length} ${plan.conflicts.length === 1 ? 'note differs' : 'notes differ'} between profiles; nothing is thrown away`);
  console.log(`  ${plural(plan.indexLines, 'line')} in the merged index${plan.indexLines > INDEX_LINES_WARN ? ` ${yellow(`— over ${INDEX_LINES_WARN}, a lot for one session to hold`)}` : ''}`);
  if (plan.conflicts.length > 0) {
    console.log('');
    console.log(`  ${bold('Where they differ')} ${dim('(the one changed most recently keeps the name)')}`);
    for (const c of plan.conflicts) {
      console.log(`    ${c.name}`);
      for (const s of c.sides) {
        const when = s.modified.slice(0, 16).replace('T', ' ');
        const keeps = s.keptAs === c.name ? green('keeps the name') : dim(`kept as ${s.keptAs}`);
        console.log(`      ${s.profile.padEnd(12)} ${String(s.bytes).padStart(6)} bytes  ${when}  ${keeps}`);
      }
    }
  }
  console.log('');
}

export function memoryShareCommand(projectPath: string | undefined, opts: { dryRun?: boolean; yes?: boolean } = {}): void {
  const where = path.resolve(projectPath ?? process.cwd());
  if (!fs.existsSync(where)) {
    console.error(`${red('✗')} No such folder: ${where}`);
    process.exitCode = 1;
    return;
  }
  const profiles = memoryProfiles();
  if (profiles.length === 0) {
    console.error(`${red('✗')} No Claude Code profiles to share between.`);
    process.exitCode = 1;
    return;
  }
  const plan = planShare(where, profiles);
  printPlan(plan, { dryRun: opts.dryRun === true });
  if (opts.dryRun === true) {
    console.log(`  ${dim('Nothing was changed. Run it again without --dry-run to do it.')}`);
    console.log('');
    return;
  }
  const done = applyShare(where, profiles);
  console.log(`  ${green('✓')} ${plural(done.plan.files.size, 'note')} in ${tildify(done.plan.shared)}`);
  if (done.backup !== null) console.log(`    every folder it touched was copied to ${tildify(done.backup)} first`);
  console.log(`    linked: ${done.linked.length === 0 ? dim('none (they were already linked)') : done.linked.join(', ')}`);
  console.log('');
}

export function memoryStatusCommand(opts: { json?: boolean } = {}): void {
  const rows = memoryStatus();
  if (opts.json === true) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  console.log('');
  if (rows.length === 0) {
    console.log(dim('  No project shares its memory yet.'));
    console.log(`  ${cyan('am memory share <folder> --dry-run')}   see what sharing one would do`);
    console.log('');
    return;
  }
  for (const r of rows) {
    console.log(`  ${bold(tildify(r.projectPath))}`);
    const warn = r.indexLines > INDEX_LINES_WARN;
    console.log(
      `    ${plural(r.notes, 'note')}, ${plural(r.indexLines, 'index line')}` +
        (warn ? `  ${yellow(`! over ${INDEX_LINES_WARN} lines — a lot for one session to hold`)}` : ''),
    );
    console.log(`    linked: ${r.linked.length > 0 ? green(r.linked.join(', ')) : dim('none')}`);
    if (r.separate.length > 0) {
      for (const s of r.separate) {
        console.log(`    ${yellow('separate')}: ${s.profile} ${dim(`(${plural(s.notes, 'note')}, ${plural(s.indexLines, 'index line')})`)}`);
      }
    }
    console.log('');
  }
}

/**
 * (5) Every profile that is about to work in this folder joins its shared memory, if it has one: what it learned on
 * its own is folded in first, then its folder becomes a link. Silent when the project does not share its memory, so
 * it costs nothing to call on every start.
 */
export function linkMemoriesFor(dir: string, profileNames: readonly string[]): void {
  const all = memoryProfiles();
  const joined: string[] = [];
  const merged: string[] = [];
  for (const name of [...new Set(profileNames)]) {
    const profile = all.find((p) => p.name === name);
    if (profile === undefined) continue;
    const did = ensureLinked(dir, profile);
    if (did === 'linked') joined.push(name);
    if (did === 'merged') merged.push(name);
  }
  if (joined.length === 0 && merged.length === 0) return;
  const parts: string[] = [];
  if (joined.length > 0) parts.push(`${joined.join(', ')} joined`);
  if (merged.length > 0) parts.push(`${merged.join(', ')} folded its own notes in first`);
  console.log(`  ${green('✓')} this project keeps one memory for every profile: ${parts.join('; ')}`);
}

export function memoryUnshareCommand(projectPath: string | undefined, opts: { fromBackup?: boolean } = {}): void {
  const where = path.resolve(projectPath ?? process.cwd());
  const done = unshare(where, { fromBackup: opts.fromBackup === true });
  console.log('');
  if (done.restored.length === 0) {
    console.log(dim(`  No profile was linked for ${tildify(where)}.`));
    console.log('');
    return;
  }
  for (const r of done.restored) {
    console.log(`  ${green('✓')} ${r.profile}: its own folder again, ${plural(r.notes, 'note')} ${dim(r.from === 'backup' ? 'put back as it was before the share' : 'copied from the shared folder')}`);
  }
  if (opts.fromBackup === true && newestBackup(done.slug) === null) {
    console.log(`  ${yellow('!')} no backup held this project, so the shared folder was copied back instead`);
  }
  console.log(`  ${dim('The shared folder is left where it is; nothing was deleted.')}`);
  console.log('');
}
