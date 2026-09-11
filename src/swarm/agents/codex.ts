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
    // Keep the explicit roots in the launch for path discovery and future Codex policies. Today,
    // however, workspace-write protects Git metadata even when the repository's `.git` directory
    // is supplied through `--add-dir`: linked-worktree agents can edit source but every `git add`
    // still fails at `.git/worktrees/*/index.lock` with EPERM. Task agents are expected to create
    // their own isolated commits, so they need danger-full-access until Codex offers a narrow Git
    // metadata write capability. `exec resume` does not accept `--add-dir`; the config roots remain
    // useful on resumed sessions.
    const addedDirs = !l.resume && l.writableRoots?.length
      ? l.writableRoots.flatMap((root) => ['--add-dir', root])
      : [];
    const common = [
      '--json', '--skip-git-repo-check',
      // The sandbox goes in as a config override rather than as `-s`: `codex exec` accepts
      // that flag but `codex exec resume` rejects it ("unexpected argument '-s' found"), so
      // every codex agent died the moment it was resumed. `-c` is accepted by both, and
      // `sandbox_mode` takes read-only, workspace-write or danger-full-access.
      '-c', `sandbox_mode=${toml('danger-full-access')}`,
      '-c', 'sandbox_workspace_write.network_access=true',
      ...addedDirs,
      ...(l.writableRoots?.length
        ? ['-c', `sandbox_workspace_write.writable_roots=[${l.writableRoots.map(toml).join(',')}]`]
        : []),
      '-c', `mcp_servers.swarm.command=${toml(l.mcpCommand.command)}`,
      '-c', `mcp_servers.swarm.args=[${l.mcpCommand.args.map(toml).join(',')}]`,
      // Task updates are the agent's control channel, not an untrusted external action. Codex
      // otherwise classifies writes such as task_eta/task_report as approval-gated; exec runs
      // are non-interactive, so those calls are refused and the worker can never report.
      '-c', `mcp_servers.swarm.default_tools_approval_mode=${toml('approve')}`,
    ];
    if (l.model) common.push('-m', l.model);
    const args = l.resume ? ['exec', 'resume', l.sessionId, ...common, prompt] : ['exec', ...common, prompt];
    const env = buildEnv('codex', l.profileHome, { ...process.env, ...l.extraEnv });
    const log = fs.openSync(l.logPath, 'a');
    fs.writeSync(log, `\n--- ${new Date().toISOString()} codex ${l.resume ? 'resume' : 'start'} ${l.resume ? l.sessionId : ''}\n`);
    // Give each worker its own process group. The npm launcher starts a native Codex child;
    // stopping only the launcher can otherwise leave that child running in the worktree.
    const child = spawn('codex', args, { cwd: l.cwd, env, stdio: ['ignore', log, log], detached: true });
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
