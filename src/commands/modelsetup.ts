import fs from 'node:fs';
import path from 'node:path';
import type { HarnessSetup } from '../core/harness.js';
import { getProvider } from '../providers/index.js';
import {
  checkOpenRouterKey, fetchOpenRouterModels, keyHint, OPENROUTER_KEYS_URL, type OpenRouterModel,
} from '../providers/openrouter.js';
import { modelNameNote } from '../swarm/models.js';
import { bold, cyan, dim, green, red, yellow } from '../ui/format.js';
import { ask, askSecret, confirm, isInteractive, select, type Choice } from '../ui/prompt.js';

type Harness = 'claude-code' | 'codex';

export interface SetupFlags {
  model?: string;
  openrouter?: boolean;
  /** Accept defaults and never prompt. */
  yes?: boolean;
}

const OPENROUTER_EXAMPLE: Record<Harness, string> = {
  'claude-code': 'anthropic/claude-sonnet-5',
  codex: 'openai/gpt-5.6-sol',
};

/** Official Claude ids, most capable first. The tool's default stays the first choice. */
const CLAUDE_MODELS = ['claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'];

/**
 * The models Codex lists for a ChatGPT login, from the catalog it caches on each start. A new profile
 * has no cache yet, so fall back to the default install's. OpenRouter ids (vendor/model) are left out,
 * in case that install is itself on OpenRouter.
 */
function codexModels(): string[] {
  const home = getProvider('codex').defaultHome;
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(home, 'models_cache.json'), 'utf8')) as {
      models?: { slug?: string; visibility?: string }[];
    };
    return (cache.models ?? [])
      .filter((m) => m.slug && m.visibility !== 'hide' && !m.slug.includes('/'))
      .map((m) => m.slug!)
      .slice(0, 6);
  } catch {
    return [];
  }
}

function contextLabel(tokens: number | undefined): string | undefined {
  if (!tokens) return undefined;
  return tokens >= 1_000_000 ? `${Math.round(tokens / 100_000) / 10}M context` : `${Math.round(tokens / 1000)}K context`;
}

/**
 * How a Claude Code or Codex profile reaches its model, and which model: the tool's own login with a
 * native model, or OpenRouter with a key and an OpenRouter model. Prints its own errors and returns
 * undefined when the profile cannot be set up as asked.
 */
export async function chooseHarness(provider: Harness, flags: SetupFlags): Promise<HarnessSetup | undefined> {
  const interactive = isInteractive() && !flags.yes;
  let backend: HarnessSetup['backend'] = flags.openrouter ? 'openrouter' : 'native';
  if (!flags.openrouter && interactive) {
    const account = provider === 'claude-code'
      ? { label: 'Claude account', hint: 'sign in with /login; Claude models on your subscription' }
      : { label: 'ChatGPT account', hint: 'sign in with codex login; OpenAI models on your plan' };
    console.log('');
    backend = await select('How should this profile reach its model?', [
      { value: 'native', ...account },
      { value: 'openrouter', label: 'OpenRouter', hint: 'an API key; any model on openrouter.ai, billed per token' },
    ]);
  }

  if (backend === 'native') {
    const model = await chooseNativeModel(provider, flags.model, interactive);
    return model === null ? undefined : { backend, model };
  }

  const key = await chooseOpenRouterKey(interactive);
  if (!key) return undefined;
  const model = await chooseOpenRouterModel(provider, flags.model, interactive);
  if (!model) return undefined;
  return { backend, key, model };
}

/** Undefined is the tool's own default; null means give up. */
async function chooseNativeModel(provider: Harness, flagModel: string | undefined, interactive: boolean): Promise<string | undefined | null> {
  let model = flagModel?.trim() || undefined;
  if (!model && interactive) {
    const tool = getProvider(provider).displayName;
    const ids = provider === 'claude-code' ? CLAUDE_MODELS : codexModels();
    const choices: Choice<string>[] = [
      { value: '', label: `${tool}'s default`, hint: 'the tool picks, and moves to new models as they ship' },
      ...ids.map((id) => ({ value: id, label: id })),
      { value: '?', label: 'Another model id' },
    ];
    console.log('');
    const picked = await select('Which model should it run?', choices);
    model = picked === '?' ? (await ask('Model id?')).trim() || undefined : picked || undefined;
  }
  if (!model) return undefined;
  if (model.includes('/')) {
    console.log(`  ${yellow('!')} ${model} looks like an OpenRouter id; ${getProvider(provider).displayName} asks its own service for it by that name.`);
    console.log(`    ${dim('For OpenRouter, choose it when asked how the profile reaches its model, or pass --openrouter.')}`);
  }
  const note = modelNameNote(model);
  if (note) console.log(`  ${dim(note)}`);
  return model;
}

async function chooseOpenRouterKey(interactive: boolean): Promise<string | undefined> {
  let fromEnv = process.env.OPENROUTER_API_KEY?.trim() || undefined;
  for (;;) {
    let key: string;
    if (fromEnv && (!interactive || (await confirm(`Use OPENROUTER_API_KEY from this shell (${keyHint(fromEnv) ?? 'set'})?`, true)))) {
      key = fromEnv;
    } else if (!interactive) {
      console.error(`${red('✗')} OpenRouter needs an API key. Export it and run this again:`);
      console.error(`    ${cyan('export OPENROUTER_API_KEY=sk-or-…')}   ${dim(`(make one at ${OPENROUTER_KEYS_URL})`)}`);
      console.error(`  ${dim('It is read from there, never from the command line, so it stays out of your shell history.')}`);
      return undefined;
    } else {
      console.log('');
      key = await askSecret(`OpenRouter API key ${dim(`(input hidden; make one at ${OPENROUTER_KEYS_URL})`)}`);
    }
    fromEnv = undefined;
    if (!key) {
      console.log(dim('  A key is needed for OpenRouter.'));
      continue;
    }

    const check = await checkOpenRouterKey(key);
    if (check.ok) {
      const extra = [check.label, typeof check.limitRemaining === 'number' ? `$${check.limitRemaining.toFixed(2)} left on its limit` : undefined].filter(Boolean).join(' · ');
      console.log(`  ${green('✓')} OpenRouter accepted key ${keyHint(key) ?? ''}${extra ? dim(`  ${extra}`) : ''}`);
      return key;
    }
    if (!check.rejected) {
      console.log(`  ${yellow('!')} Could not reach OpenRouter to check the key (${check.error}); using it as given.`);
      return key;
    }
    console.error(`  ${red('✗')} OpenRouter rejected key ${keyHint(key) ?? ''}: ${check.error}`);
    if (!interactive) return undefined;
  }
}

type Resolved = { ok: true; model: OpenRouterModel | undefined; id: string } | { ok: false; error: string; near: string[] };

/** Match a typed id against the catalog; a trailing [1m] is Claude Code's marker, not part of the id. */
function resolveOpenRouterModel(typed: string, catalog: OpenRouterModel[] | undefined): Resolved {
  const id = typed.trim().replace(/\[1m\]$/i, '');
  if (!catalog) return { ok: true, model: undefined, id };
  const hit = catalog.find((m) => m.id === id) ?? catalog.find((m) => m.id.toLowerCase() === id.toLowerCase());
  if (hit) return { ok: true, model: hit, id: hit.id };
  // A typo is a few edits away; a bare name such as "kimi" is part of the ids it means.
  const needle = id.toLowerCase();
  const concrete = catalog.filter((m) => !m.id.includes(':') && !m.id.startsWith('~'));
  const typos = concrete
    .map((m) => ({ id: m.id, d: distance(needle, m.id.toLowerCase()) }))
    .filter((m) => m.d <= Math.max(3, Math.floor(needle.length / 4)))
    .sort((a, b) => a.d - b.d)
    .map((m) => m.id);
  const named = concrete.filter((m) => m.id.toLowerCase().includes(needle)).map((m) => m.id);
  const near = [...new Set([...typos, ...named])].slice(0, 3);
  return { ok: false, error: `OpenRouter has no model "${id}"`, near };
}

/** Edit distance, for suggesting the id someone meant to type. */
function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

async function chooseOpenRouterModel(provider: Harness, flagModel: string | undefined, interactive: boolean): Promise<string | undefined> {
  const catalog = await fetchOpenRouterModels();
  if (!catalog) console.log(`  ${yellow('!')} Could not load OpenRouter's model list; the model id is used as typed.`);
  const vendor = provider === 'claude-code' ? 'anthropic/' : 'openai/';
  let typed = flagModel?.trim() || undefined;

  for (;;) {
    if (!typed) {
      if (!interactive) {
        console.error(`${red('✗')} Name the OpenRouter model: ${cyan(`--model ${OPENROUTER_EXAMPLE[provider]}`)} ${dim('(any id from openrouter.ai/models)')}`);
        return undefined;
      }
      // Newest models of the tool's own maker first: they are what the tool is built around.
      const suggestions = (catalog ?? []).filter((m) => m.id.startsWith(vendor) && m.tools && !m.id.includes(':')).slice(0, 5);
      console.log('');
      if (suggestions.length > 0) {
        const picked = await select('Which OpenRouter model?', [
          ...suggestions.map((m) => ({ value: m.id, label: m.id, hint: contextLabel(m.contextLength) })),
          { value: '', label: 'Another model on OpenRouter', hint: 'type its id, e.g. moonshotai/kimi-k3 or z-ai/glm-5.3' },
        ]);
        typed = picked || (await ask('OpenRouter model id?')).trim();
      } else {
        typed = (await ask(`OpenRouter model id? ${dim(`e.g. ${OPENROUTER_EXAMPLE[provider]}; see openrouter.ai/models`)}`)).trim();
      }
      if (!typed) continue;
    }

    const resolved = resolveOpenRouterModel(typed, catalog);
    typed = undefined;
    if (!resolved.ok) {
      console.error(`  ${red('✗')} ${resolved.error}.${resolved.near.length ? ` Did you mean ${resolved.near.map((n) => bold(n)).join(', ')}?` : ` ${dim('See openrouter.ai/models.')}`}`);
      if (!interactive) return undefined;
      continue;
    }
    const m = resolved.model;
    if (m && !m.tools) {
      console.log(`  ${yellow('!')} ${m.id} does not list tool calls, which ${getProvider(provider).displayName} needs for every edit and command.`);
      if (interactive && !(await confirm('Use it anyway?', false))) continue;
    }
    // Claude Code sizes its context from the model name, and knows only its own ids. OpenRouter's
    // documented setup marks 1M-context Claude models with [1m]; `am` measures the 90% line by it too.
    if (provider === 'claude-code' && m && m.id.startsWith('anthropic/') && (m.contextLength ?? 0) >= 1_000_000) {
      return `${m.id}[1m]`;
    }
    return resolved.id;
  }
}

/** One line for the model a new profile runs, for `am profile add`. */
export function describeSetup(setup: HarnessSetup): string {
  if (setup.backend === 'openrouter') {
    return `${bold(setup.model ?? '')} on OpenRouter ${dim(`· key ${keyHint(setup.key) ?? ''} · billed per token`)}`;
  }
  return setup.model ? bold(setup.model) : dim("the tool's default");
}
