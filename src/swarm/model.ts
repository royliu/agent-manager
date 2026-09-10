import { z } from 'zod';

export const StatusSchema = z.enum([
  'open', 'plan', 'in_progress', 'blocked', 'review', 'done', 'cancelled',
]);
export type Status = z.infer<typeof StatusSchema>;

export const BlockedOnSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('question'), questionId: z.string(), to: z.enum(['tm', 'gm', 'user']) }),
  z.object({ kind: z.literal('dependency'), taskId: z.number() }),
  z.object({ kind: z.literal('quota'), profile: z.string(), resetsAt: z.number().optional() }),
  z.object({ kind: z.literal('approval') }),
  z.object({ kind: z.literal('budget') }),
  z.object({ kind: z.literal('stalled') }),
]);
export type BlockedOn = z.infer<typeof BlockedOnSchema>;

export const NoteKindSchema = z.enum([
  'context', 'decision', 'plan', 'acceptance', 'finding', 'checkpoint', 'answer', 'feedback',
]);
export const NoteSchema = z.object({
  id: z.string(),
  author: z.string(),
  kind: NoteKindSchema,
  text: z.string(),
  at: z.number(),
});
export type Note = z.infer<typeof NoteSchema>;

export const QuestionSchema = z.object({
  id: z.string(),
  from: z.string(),
  /** Who is currently holding it. */
  to: z.enum(['tm', 'gm', 'user']),
  about: z.string(),
  known: z.string(),
  question: z.string(),
  options: z.array(z.string()).default([]),
  default: z.string(),
  path: z.array(z.object({ to: z.string(), at: z.number(), note: z.string().optional() })).default([]),
  answer: z.string().optional(),
  answeredBy: z.string().optional(),
  askedAt: z.number(),
  answeredAt: z.number().optional(),
});
export type Question = z.infer<typeof QuestionSchema>;

export const ReportSchema = z.object({
  changed: z.string(),
  verified: z.string(),
  left: z.string(),
  watch: z.string().optional(),
  status: z.enum(['done', 'failed']).default('done'),
});
export type Report = z.infer<typeof ReportSchema>;

export const RunExitSchema = z.enum(['done', 'blocked', 'failed', 'cancelled', 'compacted', 'paused']);
export const RunSchema = z.object({
  id: z.string(),
  n: z.number(),
  taskId: z.number(),
  agent: z.string(),
  sessionId: z.string().optional(),
  pid: z.number().optional(),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  exit: RunExitSchema.optional(),
  exitNote: z.string().optional(),
  log: z.string().optional(),
  tokens: z.number().default(0),
  usd: z.number().default(0),
  contextPct: z.number().optional(),
});
export type Run = z.infer<typeof RunSchema>;

export const TaskSchema = z.object({
  id: z.number(),
  title: z.string(),
  description: z.string().default(''),
  /** Your original words, kept verbatim on the root task. */
  ask: z.string().optional(),
  status: StatusSchema.default('open'),
  blockedOn: BlockedOnSchema.optional(),
  resumeTo: StatusSchema.optional(),
  reviewStage: z.enum(['gm', 'user']).optional(),
  awaitingPlanApproval: z.boolean().default(false),
  planFirst: z.boolean().default(false),
  planApproved: z.boolean().default(false),
  reviewBy: z.enum(['gm', 'user']).default('user'),
  priority: z.number().int().min(0).max(3).default(2),
  eta: z.number().optional(),
  parentId: z.number().optional(),
  dependsOn: z.array(z.number()).default([]),
  agent: z.string().optional(),
  /** True once the GM asked for it to be worked; open tasks without it are backlog. */
  dispatchRequested: z.boolean().default(false),
  /** Parked on purpose (stopped without feedback, or held by the GM): the task manager will not start it on its own. */
  hold: z.boolean().default(false),
  useWorktree: z.boolean().default(false),
  worktree: z.string().optional(),
  branch: z.string().optional(),
  notes: z.array(NoteSchema).default([]),
  questions: z.array(QuestionSchema).default([]),
  runs: z.array(RunSchema).default([]),
  report: ReportSchema.optional(),
  progress: z.string().optional(),
  /** The agent's own estimate, 0-100, from task_progress. */
  progressPct: z.number().min(0).max(100).optional(),
  progressAt: z.number().optional(),
  /** What the agent has been doing, from its session, newest first. */
  activity: z.array(z.object({ at: z.number(), text: z.string() })).default([]),
  usage: z.object({ tokens: z.number().default(0), usd: z.number().default(0) }).default({ tokens: 0, usd: 0 }),
  createdBy: z.string().default('gm'),
  createdAt: z.number(),
  updatedAt: z.number(),
  closedAt: z.number().optional(),
});
export type Task = z.infer<typeof TaskSchema>;

export const AgentStateSchema = z.enum(['idle', 'working', 'waiting', 'compacting', 'stalled', 'paused']);
export const AgentSchema = z.object({
  name: z.string(),
  profile: z.string(),
  provider: z.enum(['claude-code', 'codex']),
  model: z.string().optional(),
  sessionId: z.string().optional(),
  sessionCwd: z.string().optional(),
  nudges: z.number().default(0),
  state: AgentStateSchema.default('idle'),
  taskId: z.number().optional(),
  contextPct: z.number().default(0),
  memory: z.string().default(''),
  /** Set when the next start should use a fresh session (after a checkpoint). */
  rotateSession: z.boolean().default(false),
  compactRequestedAt: z.number().optional(),
  paused: z.boolean().default(false),
  usdToday: z.number().default(0),
});
export type Agent = z.infer<typeof AgentSchema>;

export const WorkspaceSchema = z.object({
  dir: z.string(),
  repo: z.string().optional(),
  branch: z.string().optional(),
  env: z.record(z.string()).default({}),
  tools: z.record(z.string()).default({}),
  notes: z.string().default(''),
  /** The owner's intent and the design so far, kept current by the GM; what the task manager reasons from. */
  brief: z.string().default(''),
  updatedAt: z.number(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const EventSchema = z.object({
  at: z.number(),
  actor: z.string(),
  taskId: z.number().optional(),
  text: z.string(),
});
export type Event = z.infer<typeof EventSchema>;

export const InboxItemSchema = z.object({
  id: z.string(),
  at: z.number(),
  kind: z.enum(['question', 'done', 'failed', 'stalled', 'quota', 'context', 'note', 'info']),
  taskId: z.number().optional(),
  text: z.string(),
  read: z.boolean().default(false),
});
export type InboxItem = z.infer<typeof InboxItemSchema>;

export const SwarmMetaSchema = z.object({
  name: z.string(),
  dir: z.string(),
  profile: z.string(),
  provider: z.enum(['claude-code', 'codex']),
  createdAt: z.number(),
  gmSessionId: z.string().optional(),
  /** The task manager's own conversation, so its answers stay consistent over time. */
  tmSessionId: z.string().optional(),
  /** Models set for this GM only (am gm start --gm-model …, or the GM's models_set); they beat the global model.* settings. */
  models: z.object({
    gm: z.string().optional(),
    tm: z.string().optional(),
    agent: z.string().optional(),
    codexAgent: z.string().optional(),
  }).optional(),
  /** Profiles set for this GM only: the profile new task agents are created on (am gm start --agent-profile). */
  profiles: z.object({
    agents: z.string().optional(),
  }).optional(),
});
export type SwarmMeta = z.infer<typeof SwarmMetaSchema>;

export const SwarmConfigSchema = z.object({
  agents: z.number().int().min(1).max(16).default(4),
  dispatch: z.enum(['propose', 'auto']).default('propose'),
  /** off: every question goes to the GM · notes: answer only what a note settles · most (default): the task manager reasons from the owner's intent and answers like the GM would, escalating only the rare judgment call. */
  triage: z.enum(['off', 'notes', 'most']).default('most'),
  /** The task manager's model. Unset: the GM profile's own default model. */
  tmModel: z.string().optional(),
  /** When an agent is free, the task manager starts the next open task by itself (priority, then ETA). Off: only tasks someone started. */
  autostart: z.boolean().default(true),
  notify: z.boolean().default(true),
  stallAfterMin: z.number().default(15),
  compactAt: z.number().min(5).max(99).default(90),
  contextWindow: z.number().default(200_000),
  /** Model for task agents on Claude Code profiles. Unset: each agent's profile default. */
  agentModel: z.string().optional(),
  /** Model for task agents on Codex profiles (Codex has its own model names). Unset: the profile default. */
  codexAgentModel: z.string().optional(),
  /** The General Manager's model. Unset: the profile's own default model. */
  gmModel: z.string().optional(),
  /** Profile new task agents are created on (any Claude Code or Codex profile). Unset: the GM's profile. */
  agentProfile: z.string().optional(),
  permissionMode: z.string().default('acceptEdits'),
  allow: z.array(z.string()).default(['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch', 'mcp__swarm', 'mcp__swarm__*']),
  budgetUsd: z.number().optional(),
  quotaWarnAt: z.number().default(80),
  quotaHoldAt: z.number().default(95),
  /** Show the profile's own status line (claude-hud, if installed anywhere) above the swarm line in the GM session. */
  hud: z.boolean().default(true),
  /** Environment variable that pins the tool's own auto-compaction threshold, if it has one. */
  compactEnv: z.string().default('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'),
});
export type SwarmConfig = z.infer<typeof SwarmConfigSchema>;

export const PRIORITY_LABEL = ['P0', 'P1', 'P2', 'P3'] as const;

export function shortId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
