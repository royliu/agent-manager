import { claudeCodeAgent } from './claude-code.js';
import { codexAgent } from './codex.js';
import type { AgentAdapter } from './types.js';

export function agentAdapter(provider: 'claude-code' | 'codex'): AgentAdapter {
  return provider === 'codex' ? codexAgent : claudeCodeAgent;
}
export * from './types.js';
