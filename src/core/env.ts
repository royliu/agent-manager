import type { ProviderId } from './config.js';

export type HazardSeverity = 'critical' | 'warning';

export interface EnvHazard {
  variable: string;
  severity: HazardSeverity;
  affects: ProviderId[];
  explanation: string;
  fix: string;
}

/**
 * Environment variables that silently override subscription auth and route
 * usage to pay-per-token billing (or a third-party endpoint) instead. These
 * are the single most common cause of "why is my subscription profile still
 * charging my API account?" — so we surface them loudly.
 */
const HAZARDS: EnvHazard[] = [
  {
    variable: 'ANTHROPIC_API_KEY',
    severity: 'critical',
    affects: ['claude-code'],
    explanation:
      'Claude Code prefers this API key over your subscription OAuth login. Every token is billed per-use to the API account, and your profile’s subscription quota is never touched.',
    fix: 'unset ANTHROPIC_API_KEY  (or let `am run` strip it, which it does by default)',
  },
  {
    variable: 'ANTHROPIC_AUTH_TOKEN',
    severity: 'critical',
    affects: ['claude-code'],
    explanation:
      'Overrides the Authorization header, bypassing subscription OAuth entirely.',
    fix: 'unset ANTHROPIC_AUTH_TOKEN',
  },
  {
    variable: 'ANTHROPIC_BASE_URL',
    severity: 'warning',
    affects: ['claude-code'],
    explanation:
      'Routes requests to a non-Anthropic endpoint (proxy/gateway). Subscription billing and usage reporting will not reflect reality.',
    fix: 'unset ANTHROPIC_BASE_URL',
  },
  {
    variable: 'CLAUDE_CODE_USE_BEDROCK',
    severity: 'warning',
    affects: ['claude-code'],
    explanation: 'Routes Claude Code to AWS Bedrock; billed via AWS, not your subscription.',
    fix: 'unset CLAUDE_CODE_USE_BEDROCK',
  },
  {
    variable: 'CLAUDE_CODE_USE_VERTEX',
    severity: 'warning',
    affects: ['claude-code'],
    explanation: 'Routes Claude Code to Google Vertex; billed via GCP, not your subscription.',
    fix: 'unset CLAUDE_CODE_USE_VERTEX',
  },
  {
    variable: 'OPENAI_API_KEY',
    severity: 'critical',
    affects: ['codex'],
    explanation:
      'Codex can authenticate with this API key instead of your ChatGPT subscription, billing tokens to the API account.',
    fix: 'unset OPENAI_API_KEY  (or let `am run` strip it, which it does by default)',
  },
  {
    variable: 'OPENAI_BASE_URL',
    severity: 'warning',
    affects: ['codex'],
    explanation: 'Routes Codex to a non-OpenAI endpoint; subscription usage will not be accurate.',
    fix: 'unset OPENAI_BASE_URL',
  },
];

/** Hazards currently present in the given environment. */
export function detectHazards(
  env: NodeJS.ProcessEnv = process.env,
  provider?: ProviderId,
): EnvHazard[] {
  return HAZARDS
    .filter((h) => {
      const value = env[h.variable];
      if (value === undefined || value === '') return false;
      return provider ? h.affects.includes(provider) : true;
    })
    .map((h) => ({ ...h }));
}

/** Variables `am run` strips so a profile always uses its subscription login. */
export function hazardVarsFor(provider: ProviderId): string[] {
  return HAZARDS
    .filter((h) => h.affects.includes(provider) && h.severity === 'critical')
    .map((h) => h.variable);
}

/**
 * The variable that relocates a tool's entire config + credential store.
 * Only listed where the tool actually documents/honours one — verified against
 * Claude Code 2.x and Codex CLI. Tools absent from this map fall back to HOME
 * redirection, which is coarser (see `buildEnv`).
 */
export const CONFIG_ENV_VAR: Partial<Record<ProviderId, string>> = {
  'claude-code': 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
};

/**
 * Build the environment a profile should run under.
 * `keepApiKeys` opts out of the safety strip for users who deliberately want
 * API-key billing in a given profile.
 */
export function buildEnv(
  provider: ProviderId,
  home: string,
  base: NodeJS.ProcessEnv = process.env,
  opts: { keepApiKeys?: boolean } = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };

  const varName = CONFIG_ENV_VAR[provider];
  if (varName) {
    env[varName] = home;
  } else if (provider !== 'claude-desktop') {
    // No dedicated variable: relocate HOME so the tool writes its dotfiles
    // inside the profile instead of the real home directory.
    env.HOME = home;
    env.XDG_CONFIG_HOME = `${home}/.config`;
  }

  if (!opts.keepApiKeys) {
    for (const v of hazardVarsFor(provider)) delete env[v];
  }

  // Mark the session so shells/statuslines can display the active profile.
  env.AGENT_MANAGER_PROFILE_HOME = home;
  return env;
}
