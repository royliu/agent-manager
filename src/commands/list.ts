import { getActive, loadConfig } from '../core/config.js';
import { tildify } from '../core/paths.js';
import { getProvider, PROVIDER_ORDER } from '../providers/index.js';
import { bold, cyan, dim, padEnd } from '../ui/format.js';

/** Fast, no-IO-heavy listing. `am status` is the one that reads usage. */
export function listCommand(opts: { json?: boolean } = {}): void {
  const { profiles } = loadConfig();

  if (opts.json) {
    console.log(
      JSON.stringify(
        profiles.map((p) => ({ ...p, active: getActive(p.provider) === p.name })),
        null,
        2,
      ),
    );
    return;
  }

  if (profiles.length === 0) {
    console.log('');
    console.log(dim('  No profiles yet.'));
    console.log(`  ${cyan('am init')}          register accounts you are already signed into`);
    console.log(`  ${cyan('am profile add')}   create a new isolated profile`);
    console.log('');
    return;
  }

  const sorted = [...profiles].sort(
    (a, b) =>
      PROVIDER_ORDER.indexOf(a.provider) - PROVIDER_ORDER.indexOf(b.provider) ||
      a.name.localeCompare(b.name),
  );
  const truncate = (v: string, max: number) => (v.length <= max ? v : `${v.slice(0, max - 1)}…`);
  const nameW = Math.max(7, ...sorted.map((p) => p.name.length));
  const provW = Math.max(4, ...sorted.map((p) => getProvider(p.provider).short.length));

  console.log('');
  for (const p of sorted) {
    const active = getActive(p.provider) === p.name;
    const impl = getProvider(p.provider);
    console.log(
      `  ${active ? cyan('●') : ' '} ` +
        padEnd(active ? bold(p.name) : p.name, nameW + 2) +
        padEnd(impl.short, provW + 2) +
        padEnd(p.account ? truncate(p.account, 26) : dim('—'), 28) +
        dim(tildify(p.home)),
    );
  }
  console.log('');
}
