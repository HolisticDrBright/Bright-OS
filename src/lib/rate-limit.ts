/**
 * In-memory sliding-window rate limiter. Single-VPS deployment means a
 * process-local limiter is honest and sufficient; webhook endpoints call
 * this before doing any work.
 */
type Window = number[];

const buckets = new Map<string, Window>();

export function rateLimit(key: string, opts: { limit: number; windowMs: number; nowMs?: number }): {
  allowed: boolean;
  remaining: number;
} {
  const now = opts.nowMs ?? Date.now();
  const cutoff = now - opts.windowMs;
  const hits = (buckets.get(key) ?? []).filter((t) => t > cutoff);
  if (hits.length >= opts.limit) {
    buckets.set(key, hits);
    return { allowed: false, remaining: 0 };
  }
  hits.push(now);
  buckets.set(key, hits);
  return { allowed: true, remaining: opts.limit - hits.length };
}

export function resetRateLimits() {
  buckets.clear();
}
