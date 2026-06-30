/**
 * RateLimitHandler — the explicit safety net on Thrift's PROXY/gateway surface
 * (THIRFT-M5).
 *
 * Thrift's core token reduction already relieves tokens-per-minute pressure, but
 * an agent fleet can still trip a provider's request-rate limit and get a raw
 * `429 Too Many Requests` back. The MCP surface never sees this — it only
 * handles memory calls. The 429 happens on the agent↔LLM API call, which on
 * Thrift flows through `ThriftProxy`'s outbound `fetch`. This handler wraps that
 * outbound call so a 429 becomes a transparent retry instead of a hard error in
 * the agent's logs.
 *
 * What it does, in order:
 *   1. Concurrency throttle — at most `maxConcurrency` in-flight upstream
 *      requests per provider; the rest queue (FIFO). This bounds the burst that
 *      causes 429s in the first place.
 *   2. Retry on 429 (and 503/Retry-After). It respects the upstream
 *      `Retry-After` header — seconds form (`Retry-After: 1`) or HTTP-date form
 *      (`Retry-After: Wed, 21 Oct 2026 07:28:00 GMT`).
 *   3. Exponential backoff fallback when no header is present:
 *      `backoffBaseMs * 2^attempt`, capped at `maxBackoffMs` (default 60s).
 *   4. Caps retries at `maxRetries` (default 5); after that it returns the last
 *      429 response to the caller rather than looping forever, so the agent
 *      still gets a definitive answer.
 *
 * Clock discipline (matches the rest of Thrift): the only wall-clock reads are
 * `Date.now()` (for HTTP-date math) and the injectable `sleep`. Both are
 * injectable so tests are deterministic and never actually wait.
 *
 * Per-provider: the handler is keyed by a provider id (default "default").
 * Concurrency limits are tracked per provider so a slow Anthropic queue does not
 * starve OpenAI requests sharing the same proxy.
 */

/** A minimal fetch-shaped callable — what `RateLimitHandler` wraps. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface RateLimitOptions {
  /** Max concurrent in-flight upstream requests per provider. Default 5. */
  maxConcurrency?: number;
  /** Max retry attempts on a 429/rate-limit before giving up. Default 5. */
  maxRetries?: number;
  /** Base for exponential backoff, in ms. Default 1000 (1s, 2s, 4s, 8s, …). */
  backoffBaseMs?: number;
  /** Hard cap on any single backoff wait, in ms. Default 60_000 (60s). */
  maxBackoffMs?: number;
  /** Injectable sleep (ms). Defaults to a real timer; tests pass a no-op recorder. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock for HTTP-date Retry-After math. Defaults to Date.now. */
  now?: () => number;
}

const DEFAULTS = {
  maxConcurrency: 5,
  maxRetries: 5,
  backoffBaseMs: 1000,
  maxBackoffMs: 60_000,
};

/**
 * Read rate-limit config from env vars, falling back to library defaults.
 * `THRIFT_MAX_CONCURRENCY`, `THRIFT_MAX_RETRIES`, `THRIFT_BACKOFF_BASE_MS`,
 * `THRIFT_MAX_BACKOFF_MS`. Invalid / non-positive values are ignored.
 */
export function rateLimitOptionsFromEnv(
  env: Record<string, string | undefined> = process.env,
): RateLimitOptions {
  const opts: RateLimitOptions = {};
  const conc = positiveInt(env.THRIFT_MAX_CONCURRENCY);
  if (conc !== undefined) opts.maxConcurrency = conc;
  const retries = nonNegativeInt(env.THRIFT_MAX_RETRIES);
  if (retries !== undefined) opts.maxRetries = retries;
  const base = positiveInt(env.THRIFT_BACKOFF_BASE_MS);
  if (base !== undefined) opts.backoffBaseMs = base;
  const maxBackoff = positiveInt(env.THRIFT_MAX_BACKOFF_MS);
  if (maxBackoff !== undefined) opts.maxBackoffMs = maxBackoff;
  return opts;
}

export class RateLimitHandler {
  private readonly maxConcurrency: number;
  private readonly maxRetries: number;
  private readonly backoffBaseMs: number;
  private readonly maxBackoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  /** Per-provider concurrency state: active count + FIFO waiters. */
  private readonly lanes = new Map<string, { active: number; queue: Array<() => void> }>();

  constructor(opts: RateLimitOptions = {}) {
    this.maxConcurrency = opts.maxConcurrency ?? DEFAULTS.maxConcurrency;
    this.maxRetries = opts.maxRetries ?? DEFAULTS.maxRetries;
    this.backoffBaseMs = opts.backoffBaseMs ?? DEFAULTS.backoffBaseMs;
    this.maxBackoffMs = opts.maxBackoffMs ?? DEFAULTS.maxBackoffMs;
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? Date.now;
    if (this.maxConcurrency < 1) {
      throw new Error("RateLimitHandler: maxConcurrency must be >= 1");
    }
  }

  /**
   * Run `fetchImpl` under the concurrency throttle + 429 retry policy.
   * `provider` keys the concurrency lane (e.g. "anthropic", "openai").
   * Resolves with the upstream Response — either a success, a non-429 error
   * response (passed through untouched), or the final 429 after retries are
   * exhausted (so the caller always gets a definitive answer).
   */
  async execute(provider: string, fetchImpl: FetchLike, url: string, init?: RequestInit): Promise<Response> {
    return this.withRetry(provider, fetchImpl, url, init);
  }

  private async withRetry(provider: string, fetchImpl: FetchLike, url: string, init?: RequestInit): Promise<Response> {
    let attempt = 0;
    // The loop runs at most maxRetries+1 times: 1 initial try + maxRetries retries.
    for (;;) {
      // The concurrency slot gates *compute* (the in-flight upstream call), not
      // *time*. Acquire it only around the fetch, then release it BEFORE we sleep
      // through the backoff. If the slot were held across the backoff (up to
      // maxBackoffMs per attempt × maxRetries), a 429 storm would pin every slot
      // for the full retry duration and deadlock the rest of the fleet behind a
      // queue that cannot drain. Re-acquiring per attempt keeps slots free during
      // every sleep so other requests can make progress.
      await this.acquire(provider);
      let res: Response;
      try {
        res = await fetchImpl(url, init);
      } finally {
        this.release(provider);
      }
      if (!isRateLimited(res)) return res;
      if (attempt >= this.maxRetries) return res; // give up — return the last 429

      const waitMs = this.computeWaitMs(res, attempt);
      // Drain the body so the upstream connection can be reused (some fetch impls
      // hold the socket until the body is consumed). Best-effort; never throws.
      await safeDrain(res);
      // Slot already released above — we sleep WITHOUT holding concurrency.
      await this.sleep(waitMs);
      attempt += 1;
    }
  }

  /**
   * Wait time for the next retry: Retry-After header if present and valid,
   * otherwise exponential backoff `base * 2^attempt`, capped at maxBackoffMs.
   */
  computeWaitMs(res: Response, attempt: number): number {
    const header = res.headers.get("retry-after");
    const fromHeader = header != null ? this.parseRetryAfter(header) : undefined;
    if (fromHeader !== undefined) return Math.min(fromHeader, this.maxBackoffMs);
    const backoff = this.backoffBaseMs * Math.pow(2, attempt);
    return Math.min(backoff, this.maxBackoffMs);
  }

  /** Parse Retry-After: integer seconds, or an HTTP-date. Returns ms, or undefined if unparseable. */
  parseRetryAfter(value: string): number | undefined {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
      return Number(trimmed) * 1000;
    }
    const when = Date.parse(trimmed);
    if (!Number.isNaN(when)) {
      return Math.max(0, when - this.now());
    }
    return undefined;
  }

  // ── concurrency lane ──────────────────────────────────────────────────────

  private lane(provider: string): { active: number; queue: Array<() => void> } {
    let l = this.lanes.get(provider);
    if (!l) {
      l = { active: 0, queue: [] };
      this.lanes.set(provider, l);
    }
    return l;
  }

  private acquire(provider: string): Promise<void> {
    const l = this.lane(provider);
    if (l.active < this.maxConcurrency) {
      l.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      l.queue.push(() => {
        l.active += 1;
        resolve();
      });
    });
  }

  private release(provider: string): void {
    const l = this.lane(provider);
    l.active -= 1;
    const next = l.queue.shift();
    if (next) next();
  }

  /** Current in-flight count for a provider (introspection / tests). */
  activeCount(provider: string): number {
    return this.lanes.get(provider)?.active ?? 0;
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** A response is rate-limited if it's a 429, or a 503 carrying a Retry-After. */
function isRateLimited(res: Response): boolean {
  if (res.status === 429) return true;
  if (res.status === 503 && res.headers.get("retry-after") != null) return true;
  return false;
}

async function safeDrain(res: Response): Promise<void> {
  try {
    // body may be a stream; consuming it frees the connection. Clone so we never
    // disturb a body the caller might read (we only drain responses we discard).
    await res.clone().arrayBuffer();
  } catch {
    /* best-effort */
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveInt(raw: string | undefined): number | undefined {
  if (raw == null || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function nonNegativeInt(raw: string | undefined): number | undefined {
  if (raw == null || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}
