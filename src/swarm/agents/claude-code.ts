import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { buildEnv } from '../../core/env.js';
import type { AgentAdapter, AgentLaunch } from './types.js';

export const claudeCodeAgent: AgentAdapter = {
  provider: 'claude-code',
  spawn(l: AgentLaunch): ChildProcess {
    const args = ['-p', l.prompt, '--output-format', 'json', '--mcp-config', l.mcpConfigPath, '--strict-mcp-config',
      '--append-system-prompt', l.systemPrompt, '--permission-mode', l.permissionMode];
    if (l.allow.length) args.push('--allowedTools', ...l.allow);
    if (l.model) args.push('--model', l.model);
    if (l.resume) args.push('--resume', l.sessionId);
    else args.push('--session-id', l.sessionId);
    const env = buildEnv('claude-code', l.profileHome, { ...process.env, ...l.extraEnv });
    if (l.compactEnv) env[l.compactEnv] = String(l.compactAt);
    const log = fs.openSync(l.logPath, 'a');
    fs.writeSync(log, `\n--- ${new Date().toISOString()} claude ${l.resume ? 'resume' : 'start'} ${l.sessionId}\n`);
    const child = spawn('claude', args, { cwd: l.cwd, env, stdio: ['ignore', log, log] });
    child.on('exit', () => fs.closeSync(log));
    return child;
  },
};
