/**
 * Real token costs for agent_sessions logging. $/MTok (input, output),
 * cache writes at 1.25× input, cache reads at 0.1× input.
 */
export interface UsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

const PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-fable-5": { input: 10, output: 50 },
};

export function computeCostUsd(model: string, usage: UsageLike): number {
  const rates = PER_MTOK[model] ?? PER_MTOK["claude-sonnet-5"];
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const usd =
    (input * rates.input +
      cacheWrite * rates.input * 1.25 +
      cacheRead * rates.input * 0.1 +
      output * rates.output) /
    1_000_000;
  return Math.round(usd * 10_000) / 10_000;
}

export function sumUsage(a: UsageLike, b: UsageLike): Required<UsageLike> {
  return {
    input_tokens: (a.input_tokens ?? 0) + (b.input_tokens ?? 0),
    output_tokens: (a.output_tokens ?? 0) + (b.output_tokens ?? 0),
    cache_creation_input_tokens:
      (a.cache_creation_input_tokens ?? 0) + (b.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens: (a.cache_read_input_tokens ?? 0) + (b.cache_read_input_tokens ?? 0),
  };
}
