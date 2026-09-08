import type { TokenTotals } from '../providers/types.js';

/**
 * Public list price per million tokens, USD.
 * Source: Anthropic / OpenAI published rates, cached 2026-08.
 *
 * Cache economics (Anthropic): reads bill at ~0.1x the input rate, 5-minute
 * writes at 1.25x. We use those multipliers rather than hardcoding a fourth
 * column per model.
 */
interface Rate {
  input: number;
  output: number;
  /** Multiplier on `input` for cache reads. */
  cacheReadMult?: number;
  /** Multiplier on `input` for cache writes. */
  cacheWriteMult?: number;
}

const ANTHROPIC_CACHE = { cacheReadMult: 0.1, cacheWriteMult: 1.25 };

const RATES: Record<string, Rate> = {
  // Anthropic
  'claude-fable-5': { input: 10, output: 50, ...ANTHROPIC_CACHE },
  'claude-mythos-5': { input: 10, output: 50, ...ANTHROPIC_CACHE },
  'claude-opus-5': { input: 5, output: 25, ...ANTHROPIC_CACHE },
  'claude-opus-4-8': { input: 5, output: 25, ...ANTHROPIC_CACHE },
  'claude-opus-4-7': { input: 5, output: 25, ...ANTHROPIC_CACHE },
  'claude-opus-4-6': { input: 5, output: 25, ...ANTHROPIC_CACHE },
  'claude-opus-4-5': { input: 5, output: 25, ...ANTHROPIC_CACHE },
  // Sonnet 5 list price; an introductory $2/$10 rate applied through 2026-08-31.
  'claude-sonnet-5': { input: 3, output: 15, ...ANTHROPIC_CACHE },
  'claude-sonnet-4-6': { input: 3, output: 15, ...ANTHROPIC_CACHE },
  'claude-sonnet-4-5': { input: 3, output: 15, ...ANTHROPIC_CACHE },
  'claude-haiku-4-5': { input: 1, output: 5, ...ANTHROPIC_CACHE },

  // OpenAI (Codex) — approximate list rates for cost estimation only.
  'gpt-5.5': { input: 1.25, output: 10, cacheReadMult: 0.1 },
  'gpt-5.5-codex': { input: 1.25, output: 10, cacheReadMult: 0.1 },
  'gpt-5': { input: 1.25, output: 10, cacheReadMult: 0.1 },
  'o3': { input: 2, output: 8, cacheReadMult: 0.25 },
};

/** Resolve a rate by longest-prefix match, so dated snapshots still price. */
function rateFor(model: string): Rate | undefined {
  if (RATES[model]) return RATES[model];
  let best: { key: string; rate: Rate } | undefined;
  for (const [key, rate] of Object.entries(RATES)) {
    if (model.startsWith(key) && (!best || key.length > best.key.length)) {
      best = { key, rate };
    }
  }
  return best?.rate;
}

/**
 * Equivalent pay-per-token cost of the given usage, in USD.
 * On a subscription this is *not* what you were charged — it is the list
 * price of the same work, i.e. the value the subscription absorbed.
 */
export function estimateCost(model: string, t: TokenTotals): number {
  const rate = rateFor(model);
  if (!rate) return 0;
  const perM = 1_000_000;
  return (
    (t.input / perM) * rate.input +
    (t.output / perM) * rate.output +
    (t.cacheRead / perM) * rate.input * (rate.cacheReadMult ?? 0.1) +
    (t.cacheWrite / perM) * rate.input * (rate.cacheWriteMult ?? 1.25)
  );
}

export function isPriced(model: string): boolean {
  return rateFor(model) !== undefined;
}
