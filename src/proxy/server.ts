/**
 * ThriftProxy — the cost-wedge HERO surface (THIRFT-M2b).
 *
 * A drop-in HTTP proxy between a running agent and its LLM API
 * (Anthropic/OpenAI-compatible). The agent changes ONLY its `base_url` — one
 * line, any language, no code rewrite. For each request Thrift:
 *   1. parses the chat body,
 *   2. trims its context under a hard token budget (`trimContext`),
 *   3. meters injected-vs-baseline tokens (the provable savings),
 *   4. forwards the trimmed request upstream and returns the response verbatim.
 *
 * This is the surface that delivers the headline "X% cheaper on your existing
 * agent" — unlike MCP it can cut the always-injected overhead (system prompt,
 * full MEMORY.md), not just add just-in-time recall.
 *
 * Clock discipline (matches the rest of Thrift): the trim is pure; the only
 * wall-clock read is `Date.now()` at the HTTP boundary for the metering
 * timestamp — exactly how ThriftMcpServer stamps its events.
 *
 * Limitation (v1): responses are buffered, so upstream SSE streaming
 * (`stream: true`) is not passed through incrementally. Fine for the cost
 * benchmark; streaming passthrough is a later increment.
 */

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { TokenMeter, MeterEvent } from "../meter/index.js";
import { trimContext } from "./contextTrim.js";
import type { ChatRequest } from "./contextTrim.js";
import { RateLimitHandler, rateLimitOptionsFromEnv } from "./rateLimiter.js";
import type { RateLimitOptions } from "./rateLimiter.js";

export interface ThriftProxyOptions {
  /** Upstream LLM API base URL, e.g. "https://api.anthropic.com". */
  upstreamBaseUrl: string;
  /** Hard ceiling on forwarded context tokens per request. */
  tokenBudget: number;
  /** Optional meter — every request's savings receipt is recorded here. */
  meter?: TokenMeter;
  /** If set, each metering event is appended as JSONL (cross-run dashboards). */
  meterLogPath?: string;
  /** Header naming the requesting agent (for per-agent metering). */
  agentIdHeader?: string;
  /** Injectable fetch (tests stub the upstream); defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Rate-limit safety net (M5). 429s on the upstream LLM call are caught and
   * retried (Retry-After / exponential backoff) under a per-provider concurrency
   * throttle. Omit to read config from env vars (THRIFT_MAX_CONCURRENCY, …);
   * pass `false` to disable entirely; pass an object to override.
   */
  rateLimit?: RateLimitOptions | false;
}

/** The savings receipt the proxy attaches to each forwarded request (for tests/logs). */
export interface ProxyReceipt {
  agentId: string;
  injectedTokens: number;
  baselineTokens: number;
  savedTokens: number;
  kept: number;
  dropped: number;
  compressed: boolean;
}

const DEFAULT_AGENT_HEADER = "x-thrift-agent-id";

export class ThriftProxy {
  private readonly upstreamBaseUrl: string;
  private readonly tokenBudget: number;
  private readonly meter: TokenMeter | undefined;
  private readonly meterLogPath: string | undefined;
  private readonly agentIdHeader: string;
  private readonly fetchImpl: typeof fetch;
  private readonly rateLimiter: RateLimitHandler | undefined;
  private server: Server | undefined;

  constructor(opts: ThriftProxyOptions) {
    this.upstreamBaseUrl = opts.upstreamBaseUrl.replace(/\/+$/, "");
    this.tokenBudget = opts.tokenBudget;
    this.meter = opts.meter;
    this.meterLogPath = opts.meterLogPath;
    this.agentIdHeader = (opts.agentIdHeader ?? DEFAULT_AGENT_HEADER).toLowerCase();
    if (!opts.fetchImpl && typeof fetch !== "function") {
      throw new Error("ThriftProxy requires global fetch (Node >=18) or an injected fetchImpl");
    }
    this.fetchImpl = opts.fetchImpl ?? fetch;
    // Rate-limit safety net: on by default (config from env), disable with `false`.
    if (opts.rateLimit === false) {
      this.rateLimiter = undefined;
    } else {
      this.rateLimiter = new RateLimitHandler(opts.rateLimit ?? rateLimitOptionsFromEnv());
    }
  }

  /** Start listening. Pass 0 for an ephemeral port; resolves with the bound port. */
  listen(port: number): Promise<number> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        sendJson(res, 502, { error: "thrift-proxy: " + describe(err) });
      });
    });
    return new Promise((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, () => {
        const addr = this.server!.address();
        resolve(typeof addr === "object" && addr ? addr.port : port);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }

  /** Handle one request. Public so tests can drive it without a live socket if desired. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Health check — useful for liveness probes and the smoke test.
    if (req.method === "GET" && (req.url === "/healthz" || req.url === "/")) {
      return sendJson(res, 200, { status: "ok", service: "thrift-proxy", budget: this.tokenBudget });
    }
    if (req.method !== "POST") {
      return sendJson(res, 405, { error: "method not allowed" });
    }

    const raw = await readBody(req);
    const agentId = headerValue(req, this.agentIdHeader) ?? "proxy";

    // Parse + trim. A non-JSON / non-chat body is forwarded untouched (no metering).
    let outboundBody = raw;
    let receipt: ProxyReceipt | undefined;
    const parsed = tryParse(raw);
    if (parsed && isChatRequest(parsed)) {
      const result = trimContext(parsed, { tokenBudget: this.tokenBudget });
      outboundBody = JSON.stringify(result.request);
      receipt = {
        agentId,
        injectedTokens: result.injectedTokens,
        baselineTokens: result.baselineTokens,
        savedTokens: result.savedTokens,
        kept: result.kept,
        dropped: result.dropped,
        compressed: result.compressed,
      };
      this.meterReceipt(receipt, Date.now());
    }

    // Forward upstream, preserving path + auth headers. Routed through the M5
    // rate-limit handler when enabled: a 429 on the LLM API becomes a transparent
    // Retry-After/backoff retry under a per-provider concurrency throttle, so the
    // agent stops seeing raw rate-limit errors in its logs.
    const upstreamUrl = this.upstreamBaseUrl + (req.url ?? "/");
    const init: RequestInit = {
      method: "POST",
      headers: forwardHeaders(req, outboundBody),
      body: outboundBody,
    };
    const upstream = this.rateLimiter
      ? await this.rateLimiter.execute(
          this.provider(),
          this.fetchImpl as (url: string, init?: RequestInit) => Promise<Response>,
          upstreamUrl,
          init,
        )
      : await this.fetchImpl(upstreamUrl, init);

    const respText = await upstream.text();
    res.statusCode = upstream.status;
    const ct = upstream.headers.get("content-type");
    if (ct) res.setHeader("content-type", ct);
    if (receipt) res.setHeader("x-thrift-saved-tokens", String(receipt.savedTokens));
    res.end(respText);
  }

  /** Record the savings receipt to the meter + optional JSONL log (never throws). */
  private meterReceipt(receipt: ProxyReceipt, now: number): void {
    if (!this.meter) return;
    const event: MeterEvent = {
      at: now,
      agentId: receipt.agentId,
      injectedTokens: receipt.injectedTokens,
      baselineTokens: receipt.baselineTokens,
    };
    this.meter.record(event);
    if (this.meterLogPath) {
      try {
        mkdirSync(dirname(this.meterLogPath), { recursive: true });
        appendFileSync(
          this.meterLogPath,
          JSON.stringify({ ...event, savedTokens: receipt.savedTokens, via: "proxy" }) + "\n",
        );
      } catch {
        /* metering must never break a request */
      }
    }
  }

  /** Provider id for the concurrency lane — the upstream host (e.g. "api.anthropic.com"). */
  private provider(): string {
    try {
      return new URL(this.upstreamBaseUrl).host || "default";
    } catch {
      return "default";
    }
  }
}

// ── helpers ───────────────────────────────────────────────────────────────

function isChatRequest(obj: unknown): obj is ChatRequest {
  return (
    typeof obj === "object" &&
    obj !== null &&
    (Array.isArray((obj as ChatRequest).messages) || "system" in obj)
  );
}

function tryParse(raw: string): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Copy incoming headers minus hop-by-hop ones; fix content-length to the new body. */
function forwardHeaders(req: IncomingMessage, body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const skip = new Set(["host", "content-length", "connection", "transfer-encoding"]);
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || skip.has(k.toLowerCase())) continue;
    out[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  out["content-length"] = String(Buffer.byteLength(body));
  if (!out["content-type"]) out["content-type"] = "application/json";
  return out;
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
