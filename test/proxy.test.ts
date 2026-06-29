import { describe, expect, it } from "vitest";
import { trimContext } from "../src/proxy/contextTrim.js";
import { ThriftProxy } from "../src/proxy/server.js";
import { InMemoryMeter } from "../src/meter/inMemoryMeter.js";

// 40 chars -> ~10 tokens (chars/4). Handy fixed-size context blocks for budget math.
const BLOCK = (c: string) => c.repeat(40);

describe("trimContext budget + receipt", () => {
  it("strips low-priority history under a hard budget and reports honest savings", () => {
    const req = {
      system: BLOCK("s"), // ~10 tok
      messages: [
        { role: "user", content: BLOCK("a") }, // ~10 tok (oldest)
        { role: "assistant", content: BLOCK("b") }, // ~10 tok
        { role: "user", content: BLOCK("c") }, // ~10 tok (latest = essential)
      ],
    };
    const out = trimContext(req, { tokenBudget: 25 });

    // Budget 25 → keep the essential latest user msg (10) + system (10) = 20; the
    // two older messages don't all fit, so at least one is stripped.
    expect(out.injectedTokens).toBeLessThanOrEqual(25);
    expect(out.baselineTokens).toBe(40); // full unmodified context: 4 blocks * 10
    expect(out.savedTokens).toBe(out.baselineTokens - out.injectedTokens);
    expect(out.savedTokens).toBeGreaterThan(0);
    expect(out.dropped).toBeGreaterThan(0);
    // The latest user message is never dropped (it's the current task).
    const last = out.request.messages![out.request.messages!.length - 1];
    expect(last.content).toBe(BLOCK("c"));
  });

  it("baseline is the FULL request cost and does NOT shrink with the budget (baseline integrity)", () => {
    const req = {
      system: BLOCK("s"),
      messages: [
        { role: "user", content: BLOCK("a") },
        { role: "assistant", content: BLOCK("b") },
        { role: "user", content: BLOCK("c") },
      ],
    };
    const loose = trimContext(req, { tokenBudget: 10_000 });
    const tight = trimContext(req, { tokenBudget: 15 });
    // Same input → same baseline regardless of budget. A baseline that tracked the
    // budget would understate savings (the lesson from THIRFT-BUG-001).
    expect(loose.baselineTokens).toBe(40);
    expect(tight.baselineTokens).toBe(40);
    // The looser budget forwards everything → zero savings; the tight one saves real tokens.
    expect(loose.savedTokens).toBe(0);
    expect(tight.savedTokens).toBeGreaterThan(0);
  });

  it("compresses (truncates) the essential message when it alone busts the budget", () => {
    const req = {
      messages: [{ role: "user", content: "Q".repeat(400) }], // ~100 tok, only message
    };
    const out = trimContext(req, { tokenBudget: 20 });
    expect(out.compressed).toBe(true);
    expect(out.injectedTokens).toBeLessThanOrEqual(20);
    // Never dropped to empty — the message survives, just shorter, with a marker.
    const content = out.request.messages![0].content as string;
    expect(content.length).toBeLessThan(400);
    expect(content).toContain("trimmed by thrift");
  });

  it("passes a within-budget request through untouched (zero savings)", () => {
    const req = { messages: [{ role: "user", content: "hi" }] };
    const out = trimContext(req, { tokenBudget: 1_000 });
    expect(out.dropped).toBe(0);
    expect(out.compressed).toBe(false);
    expect(out.savedTokens).toBe(0);
    expect(out.request.messages).toHaveLength(1);
  });

  it("supports the OpenAI shape (system role inside messages)", () => {
    const req = {
      messages: [
        { role: "system", content: BLOCK("s") },
        { role: "user", content: BLOCK("a") },
        { role: "user", content: BLOCK("c") },
      ],
    };
    const out = trimContext(req, { tokenBudget: 15 });
    expect(out.baselineTokens).toBe(30);
    expect(out.injectedTokens).toBeLessThanOrEqual(15);
    // Latest message kept.
    expect(out.request.messages![out.request.messages!.length - 1].content).toBe(BLOCK("c"));
  });

  it("preserves non-context passthrough fields (model, temperature, tools)", () => {
    const req = {
      model: "claude-opus-4-8",
      temperature: 0.3,
      tools: [{ name: "calc" }],
      messages: [{ role: "user", content: BLOCK("c") }],
    };
    const out = trimContext(req, { tokenBudget: 5 });
    expect(out.request.model).toBe("claude-opus-4-8");
    expect(out.request.temperature).toBe(0.3);
    expect(out.request.tools).toEqual([{ name: "calc" }]);
  });
});

describe("ThriftProxy HTTP surface (live socket, stubbed upstream)", () => {
  it("trims the forwarded body, meters savings, and returns the upstream response", async () => {
    let forwardedBody: unknown;
    let forwardedUrl = "";
    let forwardedAuth: string | null = null;

    // Stub the upstream LLM endpoint — capture what Thrift forwards, return a canned reply.
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      forwardedUrl = String(url);
      forwardedBody = JSON.parse(String(init?.body));
      const h = new Headers(init?.headers as HeadersInit);
      forwardedAuth = h.get("x-api-key");
      return new Response(JSON.stringify({ ok: true, content: "pong" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const meter = new InMemoryMeter();
    const proxy = new ThriftProxy({
      upstreamBaseUrl: "https://api.anthropic.com",
      tokenBudget: 25,
      meter,
      fetchImpl,
    });
    const port = await proxy.listen(0);

    try {
      const res = await fetch(`http://localhost:${port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "sk-test", "x-thrift-agent-id": "dev" },
        body: JSON.stringify({
          model: "claude-opus-4-8",
          system: BLOCK("s"),
          messages: [
            { role: "user", content: BLOCK("a") },
            { role: "assistant", content: BLOCK("b") },
            { role: "user", content: BLOCK("c") },
          ],
        }),
      });

      // Response passes through verbatim.
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, content: "pong" });
      // Savings header is surfaced to the caller.
      expect(Number(res.headers.get("x-thrift-saved-tokens"))).toBeGreaterThan(0);

      // Path + auth preserved upstream.
      expect(forwardedUrl).toBe("https://api.anthropic.com/v1/messages");
      expect(forwardedAuth).toBe("sk-test");

      // Forwarded body was trimmed (fewer messages than the 3 sent) and model preserved.
      const fwd = forwardedBody as { model: string; messages: unknown[] };
      expect(fwd.model).toBe("claude-opus-4-8");
      expect(fwd.messages.length).toBeLessThan(3);

      // Savings were metered for the named agent.
      const rollup = meter.rollupByAgent("dev");
      expect(rollup.runs).toBe(1);
      expect(rollup.baselineTokens).toBe(40); // full original context
      expect(rollup.savedTokens).toBeGreaterThan(0);
    } finally {
      await proxy.close();
    }
  });

  it("answers the health check", async () => {
    const proxy = new ThriftProxy({ upstreamBaseUrl: "https://example.com", tokenBudget: 100 });
    const port = await proxy.listen(0);
    try {
      const res = await fetch(`http://localhost:${port}/healthz`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: "ok", service: "thrift-proxy" });
    } finally {
      await proxy.close();
    }
  });

  it("M5 wiring: a 429 on the upstream LLM call is retried, not surfaced to the agent", async () => {
    // First upstream attempt returns 429 + Retry-After; second succeeds. With the
    // rate-limit handler wired in, the agent must see only the 200 — proving the
    // call-site is actually exercised (not just code-complete).
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response(JSON.stringify({ error: "rate_limited" }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "0" },
        });
      }
      return new Response(JSON.stringify({ ok: true, content: "pong" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const proxy = new ThriftProxy({
      upstreamBaseUrl: "https://api.anthropic.com",
      tokenBudget: 1_000,
      fetchImpl,
      // sleep is injected as a no-op so the test never actually waits.
      rateLimit: { sleep: async () => {}, maxRetries: 3 },
    });
    const port = await proxy.listen(0);
    try {
      const res = await fetch(`http://localhost:${port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      });
      expect(res.status).toBe(200); // the 429 was swallowed by the retry
      expect(await res.json()).toEqual({ ok: true, content: "pong" });
      expect(attempts).toBe(2); // one retry happened
    } finally {
      await proxy.close();
    }
  });

  it("M5 disabled: rate-limit:false surfaces the raw 429 to the agent", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "rate_limited" }), {
        status: 429,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const proxy = new ThriftProxy({
      upstreamBaseUrl: "https://api.anthropic.com",
      tokenBudget: 1_000,
      fetchImpl,
      rateLimit: false,
    });
    const port = await proxy.listen(0);
    try {
      const res = await fetch(`http://localhost:${port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      });
      expect(res.status).toBe(429); // no safety net → raw error passes through
    } finally {
      await proxy.close();
    }
  });
});
