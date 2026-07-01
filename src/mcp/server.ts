/**
 * ThriftMcpServer — the M2-MCP integration surface.
 *
 * Wraps the M1 store + retriever + meter behind three MCP tools:
 *   remember     — lightweight write, no mandatory LLM enrichment
 *   recall       — scoped retrieval under a hard token budget, with a savings receipt
 *   search_memory — full-scope match without a budget (for browsing / the control panel)
 *
 * Any MCP-capable agent (Claude Code, Cursor, Windsurf) connects with one config line —
 * no code change required.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { MemoryStore } from "../store/index.js";
import type { Retriever } from "../retrieval/index.js";
import type { TokenMeter } from "../meter/index.js";
import type { MeterEvent } from "../meter/index.js";
import type { MemoryInput, MemoryRecord, RecallQuery, RecallResult } from "../types.js";

// ── arg shapes (plain TS — no Zod required in the library) ──────────────────

export interface RememberArgs {
  scope: "org" | "agent" | "session";
  text: string;
  agentId?: string;
  sessionId?: string;
  tags?: string[];
  pinned?: boolean;
}

export interface RecallArgs {
  agentId: string;
  tokenBudget: number;
  sessionId?: string;
  task?: string;
  tags?: string[];
  /** Quality-pairing: 'full' = baseline run, 'thin' = thrift recall used. */
  mode?: "full" | "thin";
  /** Quality-pairing: which board task this run is serving. */
  taskId?: string;
  /** Quality-pairing: agent-reported outcome (pass | needs-fix | error | ...). */
  outcome?: string;
  /** Quality-pairing: mark this row synthetic (seeded), excluded by --real-only. */
  synthetic?: boolean;
}

export interface SearchMemoryArgs {
  agentId: string;
  sessionId?: string;
  task?: string;
  tags?: string[];
  limit?: number;
}

// ── JSON-schema definitions exposed to MCP clients ─────────────────────────

const TOOLS = [
  {
    name: "remember",
    description:
      "Store a memory in the Thrift fleet store. Cheap write path — no LLM enrichment required. " +
      "Org-scoped memories are shared across the whole fleet; agent-scoped belong to a single agent; " +
      "session-scoped are ephemeral.",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["org", "agent", "session"],
          description: "Scope hierarchy: org (fleet-wide) > agent > session.",
        },
        text: { type: "string", description: "The memory content to store." },
        agentId: {
          type: "string",
          description: "Required when scope is 'agent'.",
        },
        sessionId: {
          type: "string",
          description: "Required when scope is 'session'.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tags for filtering (e.g. project id, topic).",
        },
        pinned: {
          type: "boolean",
          description: "Pinned memories always get first claim on the token budget.",
        },
      },
      required: ["scope", "text"],
    },
  },
  {
    name: "recall",
    description:
      "Retrieve the relevant memory slice for an agent-run under a hard token budget. " +
      "Returns selected memories + a metering receipt (injectedTokens, baselineTokens, savedTokens) " +
      "that proves the savings vs loading everything. The receipt also reports budget pressure: " +
      "hasMoreRelevantMemory / skippedForBudget / budgetPressure ('none'|'low'|'high') tell you whether " +
      "relevant memory was left out because the budget was too small. If budgetPressure is 'high' or " +
      "hasMoreRelevantMemory is true, do ONE more focused recall (a narrower task or larger budget) before " +
      "acting — start cheap, expand only when the signal says the slice was insufficient.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "The requesting agent." },
        tokenBudget: {
          type: "number",
          description: "Hard ceiling on tokens injected this recall.",
        },
        sessionId: { type: "string", description: "Include session-scoped memories for this session." },
        task: {
          type: "string",
          description: "Free-text description of the current task — drives relevance ranking.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Restrict to memories carrying any of these tags (pinned memories bypass this).",
        },
        mode: {
          type: "string",
          enum: ["full", "thin"],
          description:
            "Quality-pairing: 'full' = full-context baseline run, 'thin' = thrift recall used. " +
            "Recorded on the meter row so an A/B runner can pair runs and compare outcome quality.",
        },
        taskId: {
          type: "string",
          description: "Quality-pairing: the board task this run is serving (pairs full vs thin on the same task).",
        },
        outcome: {
          type: "string",
          description: "Quality-pairing: agent-reported outcome for this run (e.g. 'pass' | 'needs-fix' | 'error').",
        },
      },
      required: ["agentId", "tokenBudget"],
    },
  },
  {
    name: "search_memory",
    description:
      "Search memories by text/tags without a token budget. Returns all matching memories " +
      "ordered by relevance. Useful for browsing or the owner control panel.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "The requesting agent (determines scope)." },
        sessionId: { type: "string", description: "Include session-scoped memories for this session." },
        task: { type: "string", description: "Free-text for relevance ranking." },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Filter by tags.",
        },
        limit: { type: "number", description: "Cap results to this many memories." },
      },
      required: ["agentId"],
    },
  },
];

// ── options ─────────────────────────────────────────────────────────────────

export interface ThriftMcpServerOptions {
  store: MemoryStore;
  retriever: Retriever;
  meter?: TokenMeter;
  /** Default token budget for recall when caller omits it. */
  defaultTokenBudget?: number;
  /** If set, every recall's metering event is appended here as JSONL — so a control panel / dashboard can
   *  show the token flow (injected vs baseline vs saved) across runs (the in-memory meter is per-process). */
  meterLogPath?: string;
  /**
   * Optional hook that lets the owner's control panel override a recall's token
   * budget per agent BEFORE retrieval runs: the global kill-switch and per-agent
   * budgets are applied here. Given (agentId, requestedBudget) it returns the
   * effective budget (0 = inject nothing). When omitted, the requested budget is
   * used as-is. This is what makes the M3 controls actually bite at recall time,
   * not just display in the dashboard.
   */
  resolveBudget?: (agentId: string, requestedBudget: number) => number;
}

// ── server class ─────────────────────────────────────────────────────────────

export class ThriftMcpServer {
  private readonly store: MemoryStore;
  private readonly retriever: Retriever;
  private readonly meter: TokenMeter | undefined;
  private readonly defaultTokenBudget: number;
  private readonly meterLogPath: string | undefined;
  private readonly resolveBudget: ((agentId: string, requestedBudget: number) => number) | undefined;
  private readonly _server: Server;

  constructor(opts: ThriftMcpServerOptions) {
    this.store = opts.store;
    this.retriever = opts.retriever;
    this.meter = opts.meter;
    this.defaultTokenBudget = opts.defaultTokenBudget ?? 2_000;
    this.meterLogPath = opts.meterLogPath;
    this.resolveBudget = opts.resolveBudget;
    this._server = new Server(
      { name: "thrift-memory", version: "0.0.6" },
      { capabilities: { tools: {} } },
    );
    this._registerHandlers();
  }

  // ── public business-logic methods (also used in tests without MCP transport) ──

  remember(args: RememberArgs, now: number): MemoryRecord {
    const input: MemoryInput = {
      scope: args.scope,
      agentId: args.agentId,
      sessionId: args.sessionId,
      text: args.text,
      tags: args.tags,
      pinned: args.pinned,
    };
    return this.store.add(input, now);
  }

  recall(args: RecallArgs, now: number): RecallResult {
    const requested = args.tokenBudget ?? this.defaultTokenBudget;
    // The owner's control panel can clamp the budget per agent BEFORE retrieval:
    // the global kill-switch / per-agent disable return 0 (inject nothing) and a
    // per-agent budget caps it. The retriever still computes the honest baseline
    // from the full in-scope set, so the savings receipt reflects the real cost
    // the owner avoided by muting/capping that agent.
    const effective = this.resolveBudget ? this.resolveBudget(args.agentId, requested) : requested;
    const query: RecallQuery = {
      agentId: args.agentId,
      sessionId: args.sessionId,
      task: args.task,
      tags: args.tags,
      tokenBudget: effective,
    };
    const result = this.retriever.recall(this.store, query);
    if (this.meter) {
      const event: MeterEvent = {
        at: now,
        agentId: args.agentId,
        injectedTokens: result.injectedTokens,
        baselineTokens: result.baselineTokens,
      };
      // Quality-pairing pass-through: only set when the caller supplied them, so
      // existing recall callers keep producing the original lean row shape.
      if (args.mode !== undefined) event.mode = args.mode;
      if (args.taskId !== undefined) event.taskId = args.taskId;
      if (args.outcome !== undefined) event.outcome = args.outcome;
      if (args.synthetic !== undefined) event.synthetic = args.synthetic;
      this.meter.record(event);
      // Persist the event so a dashboard can show the token flow across runs (in-memory meter is per-process).
      if (this.meterLogPath) {
        try {
          mkdirSync(dirname(this.meterLogPath), { recursive: true });
          appendFileSync(this.meterLogPath, JSON.stringify({ ...event, savedTokens: result.baselineTokens - result.injectedTokens }) + "\n");
        } catch { /* metering must never break a recall */ }
      }
    }
    return result;
  }

  searchMemory(args: SearchMemoryArgs): MemoryRecord[] {
    const query: RecallQuery = {
      agentId: args.agentId,
      sessionId: args.sessionId,
      task: args.task,
      tags: args.tags,
      tokenBudget: 1_000_000, // effectively unbounded for search
    };
    const result = this.retriever.recall(this.store, query);
    return args.limit !== undefined ? result.memories.slice(0, args.limit) : result.memories;
  }

  // ── MCP transport ──────────────────────────────────────────────────────────

  async runStdio(): Promise<void> {
    const transport = new StdioServerTransport();
    await this._server.connect(transport);
  }

  // ── private ────────────────────────────────────────────────────────────────

  private _registerHandlers(): void {
    this._server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOLS,
    }));

    this._server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name } = request.params;
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;

      if (name === "remember") {
        const record = this.remember(args as unknown as RememberArgs, Date.now());
        return { content: [{ type: "text" as const, text: JSON.stringify(record, null, 2) }] };
      }

      if (name === "recall") {
        const result = this.recall(args as unknown as RecallArgs, Date.now());
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      }

      if (name === "search_memory") {
        const memories = this.searchMemory(args as unknown as SearchMemoryArgs);
        return { content: [{ type: "text" as const, text: JSON.stringify(memories, null, 2) }] };
      }

      throw new Error(`Unknown tool: ${name}`);
    });
  }
}
