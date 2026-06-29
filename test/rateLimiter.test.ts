import { describe, expect, it } from "vitest";
import {
  RateLimitHandler,
  rateLimitOptionsFromEnv,
} from "../src/proxy/rateLimiter.js";

// A response factory — keeps the tests terse.
const r429 = (headers: Record<string, string> = {}) =>
  new Response("rate limited", { status: 429, headers });
const ok = (body = "ok") => new Response(body, { status: 200 });

/** Records every sleep so tests assert wait math without real timers. */
function recordingSleep() {
  const waited: number[] = [];
  return { waited, sleep: async (ms: number) => void waited.push(ms) };
}

describe("RateLimitHandler — 429 retry", () => {
  it("respects Retry-After: 1 (seconds) and ultimately succeeds", async () => {
    const { waited, sleep } = recordingSleep();
    const handler = new RateLimitHandler({ sleep });

    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return calls === 1 ? r429({ "retry-after": "1" }) : ok("pong");
    };

    const res = await handler.execute("anthropic", fetchImpl, "https://api/v1");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("pong");
    expect(calls).toBe(2); // one retry
    expect(waited).toEqual([1000]); // honored the 1s header, not exponential backoff
  });

  it("retries several times then succeeds (Retry-After honored each time)", async () => {
    const { waited, sleep } = recordingSleep();
    const handler = new RateLimitHandler({ sleep, maxRetries: 5 });

    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return calls < 4 ? r429({ "retry-after": "2" }) : ok();
    };

    const res = await handler.execute("p", fetchImpl, "u");
    expect(res.status).toBe(200);
    expect(calls).toBe(4); // 3 x 429 + 1 success
    expect(waited).toEqual([2000, 2000, 2000]);
  });

  it("throws-equivalent: returns the final 429 after max retries exceeded", async () => {
    const { waited, sleep } = recordingSleep();
    const handler = new RateLimitHandler({ sleep, maxRetries: 3 });

    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return r429({ "retry-after": "1" }); // always rate-limited
    };

    const res = await handler.execute("p", fetchImpl, "u");
    expect(res.status).toBe(429); // definitive answer, not an infinite loop
    expect(calls).toBe(4); // 1 initial + 3 retries
    expect(waited).toHaveLength(3); // slept before each of the 3 retries
  });

  it("falls back to exponential backoff (1s,2s,4s,8s) when no Retry-After header", async () => {
    const { waited, sleep } = recordingSleep();
    const handler = new RateLimitHandler({ sleep, maxRetries: 5, backoffBaseMs: 1000 });

    const fetchImpl = async () => r429(); // never any header, always 429

    await handler.execute("p", fetchImpl, "u");
    // base * 2^attempt for attempts 0..4 → 1,2,4,8,16 seconds
    expect(waited).toEqual([1000, 2000, 4000, 8000, 16000]);
  });

  it("caps any single backoff at maxBackoffMs (60s default)", async () => {
    const { waited, sleep } = recordingSleep();
    const handler = new RateLimitHandler({ sleep, maxRetries: 5, backoffBaseMs: 1000 });

    await handler.execute("p", async () => r429(), "u");
    // 2^5 * 1000 = 32000, 2^6 not reached; but assert nothing exceeds 60_000.
    for (const w of waited) expect(w).toBeLessThanOrEqual(60_000);
  });

  it("does not retry a non-rate-limit error response (passes 500 straight through)", async () => {
    const { waited, sleep } = recordingSleep();
    const handler = new RateLimitHandler({ sleep });
    let calls = 0;
    const res = await handler.execute(
      "p",
      async () => {
        calls += 1;
        return new Response("boom", { status: 500 });
      },
      "u",
    );
    expect(res.status).toBe(500);
    expect(calls).toBe(1); // no retry for non-429
    expect(waited).toHaveLength(0);
  });
});

describe("RateLimitHandler — Retry-After parsing", () => {
  it("parses HTTP-date form into a future delay (ms)", () => {
    const fixedNow = Date.parse("Wed, 21 Oct 2026 07:28:00 GMT");
    const handler = new RateLimitHandler({ now: () => fixedNow });
    const res = r429({ "retry-after": "Wed, 21 Oct 2026 07:28:05 GMT" });
    // 5 seconds in the future → 5000 ms.
    expect(handler.computeWaitMs(res, 0)).toBe(5000);
  });

  it("clamps a past HTTP-date to 0 (no negative wait)", () => {
    const fixedNow = Date.parse("Wed, 21 Oct 2026 07:28:10 GMT");
    const handler = new RateLimitHandler({ now: () => fixedNow });
    expect(handler.parseRetryAfter("Wed, 21 Oct 2026 07:28:00 GMT")).toBe(0);
  });

  it("falls back to backoff when Retry-After is garbage", () => {
    const handler = new RateLimitHandler({ backoffBaseMs: 1000 });
    const res = r429({ "retry-after": "soon-ish" });
    // unparseable → exponential backoff for attempt 0 = 1000.
    expect(handler.computeWaitMs(res, 0)).toBe(1000);
  });

  it("caps a huge Retry-After at maxBackoffMs", () => {
    const handler = new RateLimitHandler({ maxBackoffMs: 60_000 });
    const res = r429({ "retry-after": "9999" }); // 9999s
    expect(handler.computeWaitMs(res, 0)).toBe(60_000);
  });
});

describe("RateLimitHandler — concurrency throttle", () => {
  it("never runs more than maxConcurrency requests at once, queues the rest", async () => {
    const handler = new RateLimitHandler({ maxConcurrency: 2 });

    let inFlight = 0;
    let peak = 0;
    const release: Array<() => void> = [];

    // Each fetch blocks until we manually release it, so we can observe the peak.
    const fetchImpl = () =>
      new Promise<Response>((resolve) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        release.push(() => {
          inFlight -= 1;
          resolve(ok());
        });
      });

    const runs = [0, 1, 2, 3, 4].map(() => handler.execute("p", fetchImpl, "u"));

    // Let the microtask queue settle so all acquirable slots are taken.
    await Promise.resolve();
    await Promise.resolve();
    expect(handler.activeCount("p")).toBe(2);
    expect(peak).toBe(2);

    // Drain: releasing one lets a queued one start, keeping peak at 2.
    while (release.length) {
      const next = release.shift()!;
      next();
      await Promise.resolve();
      await Promise.resolve();
    }

    await Promise.all(runs);
    expect(peak).toBe(2); // throttle held across the whole batch
    expect(handler.activeCount("p")).toBe(0);
  });

  it("tracks concurrency lanes per provider independently", async () => {
    const handler = new RateLimitHandler({ maxConcurrency: 1 });
    const block: Array<() => void> = [];
    const fetchImpl = () =>
      new Promise<Response>((resolve) => block.push(() => resolve(ok())));

    const a = handler.execute("anthropic", fetchImpl, "u");
    const o = handler.execute("openai", fetchImpl, "u");
    await Promise.resolve();
    await Promise.resolve();

    // Each provider has its own slot → both in-flight despite maxConcurrency=1.
    expect(handler.activeCount("anthropic")).toBe(1);
    expect(handler.activeCount("openai")).toBe(1);

    block.forEach((fn) => fn());
    await Promise.all([a, o]);
  });
});

describe("rateLimitOptionsFromEnv", () => {
  it("reads the documented env vars", () => {
    const opts = rateLimitOptionsFromEnv({
      THRIFT_MAX_CONCURRENCY: "3",
      THRIFT_MAX_RETRIES: "7",
      THRIFT_BACKOFF_BASE_MS: "500",
      THRIFT_MAX_BACKOFF_MS: "30000",
    });
    expect(opts).toEqual({
      maxConcurrency: 3,
      maxRetries: 7,
      backoffBaseMs: 500,
      maxBackoffMs: 30000,
    });
  });

  it("ignores invalid / empty values, leaving defaults to apply", () => {
    const opts = rateLimitOptionsFromEnv({
      THRIFT_MAX_CONCURRENCY: "0", // not positive → ignored
      THRIFT_BACKOFF_BASE_MS: "abc", // NaN → ignored
      THRIFT_MAX_RETRIES: "", // empty → ignored
    });
    expect(opts).toEqual({}); // nothing set → handler uses its built-in defaults
  });

  it("allows THRIFT_MAX_RETRIES=0 (retries disabled but valid)", () => {
    const opts = rateLimitOptionsFromEnv({ THRIFT_MAX_RETRIES: "0" });
    expect(opts).toEqual({ maxRetries: 0 });
  });
});
