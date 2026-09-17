import fs from 'node:fs';
import path from 'node:path';
import type { ProviderId } from './config.js';
import { isOpenRouterUrl, keyHint, OPENROUTER_ANTHROPIC_BASE, OPENROUTER_API } from '../providers/openrouter.js';

/**
 * How a Claude Code or Codex profile reaches its model, kept in the tool's own config inside the
 * profile directory: Claude Code's settings.json, Codex's config.toml. Every way of starting the tool
 * on that directory then picks it up with no help from us: `am run`, a GM, the task manager, the task
 * agents, and a hand-typed `CLAUDE_CONFIG_DIR=… claude` alike.
 *
 *   native      the tool's own login (a Claude or ChatGPT subscription), optionally with a pinned model
 *   openrouter  an OpenRouter API key and an OpenRouter model id, billed per token
 */
export type Backend = 'native' | 'openrouter';

export interface Harness {
  backend: Backend;
  /** The model the tool runs when nothing on its command line says otherwise. */
  model?: string;
  /** "…a1b2" for an OpenRouter key we can read. */
  keyHint?: string;
}

export interface HarnessSetup {
  backend: Backend;
  /** Undefined leaves the tool on its own default (native only). */
  model?: string;
  /** The OpenRouter API key (openrouter only). */
  key?: string;
}

/** Codex reads the key through its auth command, so the key never has to be in anyone's environment. */
export const CODEX_KEY_FILE = 'openrouter.key';
const CODEX_PROVIDER = 'openrouter';

/**
 * Claude Code on OpenRouter, as OpenRouter documents it. ANTHROPIC_API_KEY must be present and empty:
 * a real one would go out as x-api-key, which OpenRouter treats as a direct Anthropic credential. Every
 * model alias the tool uses internally (the small model for titles, sub-agents, /model opus) maps to the
 * chosen model, since the tool's own Anthropic ids are not OpenRouter ids.
 */
const CLAUDE_MODEL_ENV = [
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
];
const CLAUDE_OPENROUTER_ENV = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY',
  ...CLAUDE_MODEL_ENV,
];

interface ClaudeSettings {
  model?: string;
  env?: Record<string, string>;
  [key: string]: unknown;
}

function claudeSettingsPath(home: string): string {
  return path.join(home, 'settings.json');
}

function readClaudeSettings(home: string): ClaudeSettings {
  try {
    const parsed = JSON.parse(fs.readFileSync(claudeSettingsPath(home), 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as ClaudeSettings) : {};
  } catch {
    return {};
  }
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** Private files: they can hold an API key. */
function writePrivate(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// --------------------------------------------------------------- config.toml
// Just enough TOML to set a few top-level keys and replace whole tables, leaving
// everything else in the file, comments included, exactly as it was.

const TABLE_LINE = /^\s*\[/;

function topLevelEnd(lines: string[]): number {
  const i = lines.findIndex((l) => TABLE_LINE.test(l));
  return i < 0 ? lines.length : i;
}

function tomlString(text: string, key: string, table?: string): string | undefined {
  const lines = text.split('\n');
  let from = 0;
  let to = topLevelEnd(lines);
  if (table) {
    from = lines.findIndex((l) => l.trim() === `[${table}]`) + 1;
    if (from === 0) return undefined;
    to = from;
    while (to < lines.length && !TABLE_LINE.test(lines[to]!)) to += 1;
  }
  const re = new RegExp(`^\\s*${key.replace(/[.]/g, '\\.')}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|'([^']*)')`);
  for (const line of lines.slice(from, to)) {
    const m = re.exec(line);
    if (!m) continue;
    if (m[2] !== undefined) return m[2];
    try {
      return JSON.parse(`"${m[1]}"`) as string;
    } catch {
      return m[1];
    }
  }
  return undefined;
}

function setTopLevel(lines: string[], key: string, value: string | undefined): void {
  const end = topLevelEnd(lines);
  const re = new RegExp(`^\\s*${key}\\s*=`);
  const i = lines.slice(0, end).findIndex((l) => re.test(l));
  if (value === undefined) {
    if (i >= 0) lines.splice(i, 1);
    return;
  }
  const line = `${key} = ${JSON.stringify(value)}`;
  if (i >= 0) {
    lines[i] = line;
    return;
  }
  let at = end;
  while (at > 0 && lines[at - 1]!.trim() === '') at -= 1;
  lines.splice(at, 0, line);
}

/** Replace a table's body, or remove the table when `body` is undefined. */
function setTable(lines: string[], header: string, body: string[] | undefined): void {
  const start = lines.findIndex((l) => l.trim() === `[${header}]`);
  if (start >= 0) {
    let end = start + 1;
    while (end < lines.length && !TABLE_LINE.test(lines[end]!)) end += 1;
    while (end > start + 1 && lines[end - 1]!.trim() === '') end -= 1;
    lines.splice(start, end - start, ...(body ? [`[${header}]`, ...body] : []));
    return;
  }
  if (!body) return;
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
  if (lines.length > 0) lines.push('');
  lines.push(`[${header}]`, ...body, '');
}

// ------------------------------------------------------------------- reading

/** How the tool in `home` reaches its model. Tools other than Claude Code and Codex are always native. */
export function readHarness(provider: ProviderId, home: string): Harness {
  if (provider === 'claude-code') {
    const settings = readClaudeSettings(home);
    const model = typeof settings.model === 'string' && settings.model ? settings.model : undefined;
    const env = settings.env ?? {};
    if (isOpenRouterUrl(env.ANTHROPIC_BASE_URL) && env.ANTHROPIC_AUTH_TOKEN) {
      return { backend: 'openrouter', model, keyHint: keyHint(env.ANTHROPIC_AUTH_TOKEN) };
    }
    return { backend: 'native', model };
  }
  if (provider === 'codex') {
    const toml = readText(path.join(home, 'config.toml')) ?? '';
    const model = tomlString(toml, 'model') || undefined;
    const providerId = tomlString(toml, 'model_provider');
    const baseUrl = providerId ? tomlString(toml, 'base_url', `model_providers.${providerId}`) : undefined;
    if (providerId && (providerId === CODEX_PROVIDER || isOpenRouterUrl(baseUrl))) {
      return { backend: 'openrouter', model, keyHint: keyHint(readText(path.join(home, CODEX_KEY_FILE))) };
    }
    return { backend: 'native', model };
  }
  return { backend: 'native' };
}

// ------------------------------------------------------------------- writing

/** Point the tool in `home` at its backend and model. Settings that are not ours are left alone. */
export function writeHarness(provider: 'claude-code' | 'codex', home: string, setup: HarnessSetup): void {
  if (setup.backend === 'openrouter' && (!setup.key || !setup.model)) {
    throw new Error('an OpenRouter profile needs both a key and a model');
  }
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });

  if (provider === 'claude-code') {
    const settings = readClaudeSettings(home);
    const env: Record<string, string> = { ...(settings.env ?? {}) };
    if (setup.backend === 'openrouter') {
      env.ANTHROPIC_BASE_URL = OPENROUTER_ANTHROPIC_BASE;
      env.ANTHROPIC_AUTH_TOKEN = setup.key!;
      env.ANTHROPIC_API_KEY = '';
      env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = '1';
      for (const name of CLAUDE_MODEL_ENV) env[name] = setup.model!;
    } else if (isOpenRouterUrl(env.ANTHROPIC_BASE_URL)) {
      for (const name of CLAUDE_OPENROUTER_ENV) delete env[name];
    }
    const next: ClaudeSettings = { ...settings, env };
    if (Object.keys(env).length === 0) delete next.env;
    if (setup.model) next.model = setup.model;
    writePrivate(claudeSettingsPath(home), `${JSON.stringify(next, null, 2)}\n`);
    return;
  }

  const file = path.join(home, 'config.toml');
  const keyFile = path.join(home, CODEX_KEY_FILE);
  const lines = (readText(file) ?? '').split('\n');
  if (setup.backend === 'openrouter') {
    setTopLevel(lines, 'model_provider', CODEX_PROVIDER);
    setTable(lines, `model_providers.${CODEX_PROVIDER}`, [
      'name = "OpenRouter"',
      `base_url = ${JSON.stringify(OPENROUTER_API)}`,
      'wire_api = "responses"',
    ]);
    // An auth command rather than env_key: the key stays out of every environment, and OpenRouter
    // documents that this mode also refreshes Codex's model catalog, so non-OpenAI models get the
    // right metadata.
    setTable(lines, `model_providers.${CODEX_PROVIDER}.auth`, ['command = "cat"', `args = [${JSON.stringify(keyFile)}]`]);
    writePrivate(keyFile, setup.key!.trim());
  } else if (tomlString(lines.join('\n'), 'model_provider') === CODEX_PROVIDER) {
    setTopLevel(lines, 'model_provider', undefined);
    setTable(lines, `model_providers.${CODEX_PROVIDER}.auth`, undefined);
    setTable(lines, `model_providers.${CODEX_PROVIDER}`, undefined);
    fs.rmSync(keyFile, { force: true });
  }
  if (setup.model) setTopLevel(lines, 'model', setup.model);
  writePrivate(file, `${lines.join('\n').trim()}\n`);
}
