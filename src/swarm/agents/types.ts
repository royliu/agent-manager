import type { ChildProcess } from 'node:child_process';

export interface AgentLaunch {
  provider: 'claude-code' | 'codex';
  profileHome: string;
  cwd: string;
  /** First user message (the brief, or a resume message). */
  prompt: string;
  systemPrompt: string;
  sessionId: string;
  resume: boolean;
  mcpConfigPath: string;
  /** Args the MCP bridge needs, for tools that take the server inline (Codex). */
  mcpCommand: { command: string; args: string[] };
  model?: string;
  allow: string[];
  permissionMode: string;
  extraEnv: Record<string, string>;
  compactAt: number;
  compactEnv: string;
  logPath: string;
}

export interface AgentAdapter {
  provider: 'claude-code' | 'codex';
  spawn(l: AgentLaunch): ChildProcess;
  /** Pull the session id out of the run log when the tool assigns its own. */
  sessionIdFromLog?(log: string): string | undefined;
}
