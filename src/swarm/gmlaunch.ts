import { randomUUID } from 'node:crypto';
import type { Profile } from '../core/config.js';
import { getProvider, type LaunchSpec } from '../providers/index.js';
import { amEntry } from './client.js';
import { profileByName } from '../core/config.js';
import type { SwarmConfig, SwarmMeta } from './model.js';
import { modelArg, modelsView } from './models.js';
import { gmSystemPrompt } from './prompts.js';
import { Store, writeJsonAtomic } from './store.js';
import { findClaudeTranscript } from './transcript.js';

/** Build the interactive GM session: Claude Code (or Codex) with the swarm tools, hooks and status line. */
export function buildGmLaunch(meta: SwarmMeta, profile: Profile, cfg: SwarmConfig, opts: { resume: boolean }): { spec: LaunchSpec; sessionId?: string } {
  const store = new Store(meta.name);
  const models = modelsView(meta, cfg, profile, store.team(), profileByName);
  const gmModel = modelArg(models.gm);
  const prompt = gmSystemPrompt(meta, store.team(), store.workspace(), cfg, models);
  const node = process.execPath;
  const cli = amEntry();
  const bridge = { command: node, args: [cli, '_bridge', '--gm', meta.name, '--role', 'gm'] };
  writeJsonAtomic(store.paths.mcpConfig, { mcpServers: { swarm: bridge } });
  const provider = getProvider(profile.provider);

  if (profile.provider === 'claude-code') {
    const hook = (kind: string) => `"${node}" "${cli}" _hook ${kind} --gm ${meta.name}`;
    writeJsonAtomic(store.paths.gmSettings, {
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: hook('inbox'), timeout: 10 }] }],
        Stop: [{ hooks: [{ type: 'command', command: hook('stop'), timeout: 10 }] }],
      },
      statusLine: { type: 'command', command: hook('status'), padding: 0 },
    });
    const args = ['--mcp-config', store.paths.mcpConfig, '--settings', store.paths.gmSettings, '--append-system-prompt', prompt];
    if (gmModel) args.push('--model', gmModel);
    let sessionId: string | undefined;
    // Resume only a conversation that really exists on disk; otherwise start fresh rather than fail.
    const canResume = opts.resume && !!meta.gmSessionId && !!findClaudeTranscript(profile.home, meta.gmSessionId);
    if (canResume) args.push('--resume', meta.gmSessionId!);
    else {
      sessionId = randomUUID();
      args.push('--session-id', sessionId);
      // A fresh GM greets the owner first, so the session opens like a conversation, not a blank prompt.
      args.push(`Say hello in one short paragraph: who you are, that your team and task manager are ready in this folder, and that the board is "am board" in another terminal. Then ask what the owner wants to get done. Do not create any task yet.`);
    }
    const spec = provider.launch(profile.home, args);
    spec.env.AM_GM = meta.name;
    return { spec, sessionId };
  }

  // Codex: tools through -c overrides; no hooks, so the prompt asks it to read its inbox each turn.
  const toml = (v: string) => JSON.stringify(v);
  const args = [
    '-c', `mcp_servers.swarm.command=${toml(bridge.command)}`,
    '-c', `mcp_servers.swarm.args=[${bridge.args.map(toml).join(',')}]`,
  ];
  if (gmModel) args.push('-m', gmModel);
  if (opts.resume && meta.gmSessionId) args.push('resume', meta.gmSessionId);
  else args.push(`${prompt}\n\nAt the start of every turn, read your inbox (inbox_read) before anything else. Introduce yourself to the owner in one short paragraph and ask what they want to get done.`);
  const spec = provider.launch(profile.home, args);
  spec.env.AM_GM = meta.name;
  return { spec };
}
