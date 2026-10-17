/** Bounded exponential backoff with full jitter. `attempt` starts at 1. */
export function backoffDelayMs(
  attempt: number,
  opts: { baseMs?: number; maxMs?: number; random?: () => number } = {},
): number {
  const base = opts.baseMs ?? 30_000;
  const max = opts.maxMs ?? 60 * 60_000;
  const random = opts.random ?? Math.random;
  const exp = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  // Full jitter, but never shorter than half the base so retries do not stampede.
  return Math.round(Math.max(base / 2, random() * exp));
}
