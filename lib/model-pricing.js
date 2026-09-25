/**
 * Compact model price table (USD / 1M tokens) used to recommend the cheapest
 * model for heartbeat judgment calls.
 *
 * Sources: the curated, human-checked table shipped with dsh-cost-meter
 * (checked 2026-08/09), DeepSeek official pricing (off-peak tier). This is a
 * HEURISTIC for ranking, not a billing ledger — unknown models simply carry
 * no price and are never recommended as "cheapest".
 *
 * @module dsh-plugin-heartbeat/model-pricing
 */

/** provider → modelId → { input, output } (USD per 1M tokens) */
export const PRICE_TABLE = {
  'deepseek-official': {
    'deepseek-flash': { input: 0.22, output: 0.66 },
    'deepseek-v4-flash': { input: 0.22, output: 0.66 },
    'deepseek-pro': { input: 0.66, output: 1.98 },
    'deepseek-v4-pro': { input: 0.66, output: 1.98 },
    'deepseek-chat': { input: 0.27, output: 1.1 },
    'deepseek-reasoner': { input: 0.55, output: 2.19 },
  },
  xiaomi: {
    'mimo-v2.6-flash': { input: 0.14, output: 0.28 },
    'mimo-v2.5': { input: 0.14, output: 0.28 },
    'mimo-v2.6-pro': { input: 0.435, output: 0.87 },
    'mimo-v2.5-pro': { input: 0.435, output: 0.87 },
  },
  openai: {
    'gpt-5-nano': { input: 0.05, output: 0.4 },
    'gpt-5.1-codex-mini': { input: 0.25, output: 2 },
    'gpt-4.1-mini-2025-04-14': { input: 0.4, output: 1.6 },
    'gpt-5.6-luna': { input: 0.2, output: 1.2 },
    'gpt-5.4-mini': { input: 0.75, output: 4.5 },
    'gpt-5.4-nano': { input: 0.2, output: 1.25 },
  },
  anthropic: {
    'claude-haiku-4-5': { input: 1, output: 5 },
  },
  google: {
    'gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
    'gemini-2.5-flash': { input: 0.3, output: 2.5 },
    'gemini-3.5-flash-lite': { input: 0.3, output: 2.5 },
    'gemini-3.5-flash': { input: 1.5, output: 9 },
  },
  alibaba: {
    'qwen3.5-plus': { input: 0.2, output: 1.2 },
    'qwen3-plus': { input: 0.4, output: 1.2 },
    'qwen3.7-plus': { input: 0.4, output: 1.6 },
  },
  moonshot: {
    'kimi-k2.5': { input: 0.6, output: 3 },
    'kimi-k2.6': { input: 0.95, output: 4 },
    'kimi-k2.7-code': { input: 0.95, output: 4 },
  },
  'z-ai': {
    'glm-5.3-flash': { input: 0.15, output: 0.5 },
    'glm-5': { input: 1, output: 3.2 },
  },
}

/** Judgment-call shape assumption: ~2000 input tokens + ~200 output tokens. */
const ASSUMED_INPUT_TOKENS = 2000
const ASSUMED_OUTPUT_TOKENS = 200

export function priceFor(provider, model) {
  const table = PRICE_TABLE[provider]
  if (!table) return undefined
  return table[model] ?? table[model.toLowerCase()] ?? undefined
}

/** Estimated USD cost of one judgment call, or undefined when unpriced. */
export function costPerCall(provider, model) {
  const price = priceFor(provider, model)
  if (!price) return undefined
  return (price.input * ASSUMED_INPUT_TOKENS + price.output * ASSUMED_OUTPUT_TOKENS) / 1_000_000
}

/**
 * Annotate a model list with prices and pick the cheapest entry.
 * @param {Array<{ provider: string, model: string }>} models
 * @returns {{ models: Array<object>, cheapest: { provider: string, model: string } | undefined }}
 */
export function annotateModels(models) {
  let cheapest
  let cheapestCost
  const annotated = models.map(({ provider, model }) => {
    const price = priceFor(provider, model)
    const cost = price ? costPerCall(provider, model) : undefined
    if (cost !== undefined && (cheapestCost === undefined || cost < cheapestCost)) {
      cheapestCost = cost
      cheapest = { provider, model }
    }
    return { provider, model, price, cost }
  })
  return { models: annotated, cheapest }
}
