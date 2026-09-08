import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { buildEnv } from '../../core/env.js';
import type { AgentAdapter, AgentLaunch } from './types.js';

function toml(v: string): string {
  return JSON.stringify(v);
}

export const codexAgent: AgentAdapter = {
  provider: 'codex',
  spawn(l: AgentLaunch): ChildProcess {
    const prompt = l.resume ? l.prompt : `${l.systemPrompt}\n\n${l.prompt}`;
    const common = [
      '--json', '--skip-git-repo-check', '-s', 'workspace-write',
      '-c', `mcp_servers.swarm.command=${toml(l.mcpCommand.command)}`,
      '-c', `mcp_servers.swarm.args=[${l.mcpCommand.args.map(toml).join(',')}]`,
    ];
    if (l.model) common.push('-m', l.model);
    const args = l.resume ? ['exec', 'resume', l.sessionId, ...common, prompt] : ['exec', ...common, prompt];
    const env = buildEnv('codex', l.profileHome, { ...process.env, ...l.extraEnv });
    const log = fs.openSync(l.logPath, 'a');
    fs.writeSync(log, `\n--- ${new Date().toISOString()} codex ${l.resume ? 'resume' : 'start'} ${l.resume ? l.sessionId : ''}\n`);
    const child = spawn('codex', args, { cwd: l.cwd, env, stdio: ['ignore', log, log] });
    child.on('exit', () => fs.closeSync(log));
    return child;
  },
  sessionIdFromLog(log: string): string | undefined {
    let raw: string;
    try {
      raw = fs.readFileSync(log, 'utf8');
    } catch {
      return undefined;
    }
    const lines = raw.split('\n').reverse();
    for (const line of lines) {
      const m = /"(?:thread_id|session_id|conversation_id)"\s*:\s*"([0-9a-fA-F-]{8,})"/.exec(line);
      if (m) return m[1];
      if (line.startsWith('--- ')) break;
    }
    return undefined;
  },
};
