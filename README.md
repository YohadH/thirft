# Thrift

**Cost-first memory for AI agent teams.**

Thrift gives MCP-capable agents a small shared memory layer that optimizes for
cost visibility: store memories cheaply, recall only the relevant slice under a
hard token budget, and log a receipt for every recall.

```text
savedTokens = baselineTokens - injectedTokens
```

The goal is practical: help teams of agents stop paying to reload the same broad
context on every run.

> Status: early `0.0.x`. APIs are useful but still allowed to change before
> `v0.1`.

## What It Does

Thrift has three surfaces:

| Surface | Purpose |
| --- | --- |
| MCP server | Agent memory tools: `remember`, `recall`, `search_memory` |
| Local dashboard | Read-only savings UI backed by the meter JSONL |
| Proxy | Optional HTTP gateway that trims live LLM requests and retries rate limits |

Be precise about the split:

- **MCP manages memory recall and token receipts.**
- **`thrift-proxy` manages live request trimming and rate-limit retries.**

## MCP Tools

```text
remember(scope, text, agentId?, sessionId?, tags?)
  Store a memory in org, agent, or session scope.

recall(agentId, tokenBudget, task?, tags?)
  Return relevant memories under a hard token budget.
  Also returns { injectedTokens, baselineTokens, savedTokens }.

search_memory(agentId, task?, tags?, limit?)
  Browse matching memories without applying a small recall budget.
```

## Quick Start

```bash
npm install -g thrift-memory
```

Add Thrift to an MCP-capable client:

```json
{
  "mcpServers": {
    "thrift": {
      "command": "npx",
      "args": ["thrift-memory"]
    }
  }
}
```

Or run the MCP server directly:

```bash
npx thrift-memory \
  --store-path=~/.thrift/memories.jsonl \
  --meter-path=~/.thrift/meter.jsonl \
  --default-budget=2000
```

## Dashboard

The optional dashboard is local and read-only. It shows whether Thrift is really
saving tokens across real agent runs.

```bash
npx thrift-panel serve \
  --store-path=~/.thrift/memories.jsonl \
  --meter-path=~/.thrift/meter.jsonl \
  --control-path=~/.thrift/control.json \
  --port=8585
```

Open `http://127.0.0.1:8585`.

![Thrift dashboard](./docs/dashboard.svg)

The dashboard shows:

| View | What it proves |
| --- | --- |
| Fleet summary | Total baseline, injected, saved tokens, and savings rate |
| Daily token flow | Whether savings persist across real days |
| Agent savings | Which agents are expensive and which save the most |
| Recent receipts | The latest metered recall/proxy events |
| Audit paths | The local files backing the numbers |

CLI equivalents:

```bash
npx thrift-panel summary --store-path=~/.thrift/memories.jsonl --meter-path=~/.thrift/meter.jsonl
npx thrift-panel agents --store-path=~/.thrift/memories.jsonl --meter-path=~/.thrift/meter.jsonl
npx thrift-panel memories --store-path=~/.thrift/memories.jsonl --scope=org
```

## Measuring Performance

Every `recall` writes a receipt to `THRIFT_METER_PATH` when a meter path is
configured:

```json
{"at":1760000000000,"agentId":"dev","injectedTokens":420,"baselineTokens":2100,"savedTokens":1680}
```

Definitions:

| Field | Meaning |
| --- | --- |
| `baselineTokens` | The no-Thrift counterfactual: all in-scope memory that would have been loaded |
| `injectedTokens` | The slice Thrift actually returned under budget |
| `savedTokens` | `baselineTokens - injectedTokens` |
| Savings rate | `savedTokens / baselineTokens` |

Recommended measurement loop:

1. Seed memories from your own markdown files or use `remember`.
2. Let real agents call `recall` during normal work.
3. Review `thrift-panel summary` and `thrift-panel agents`.
4. Validate quality separately by comparing task outcomes with full memory vs
   Thrift recall.

For a credible public report, publish both token reduction and quality evidence.
For example: "saved 72% of memory tokens across 200 real recalls, with 19/20
paired tasks producing the same outcome."

## Synthetic Benchmark

This repo includes a small synthetic fixture so users can verify the measurement
pipeline without any private data:

```bash
npm run build
node benchmark/run.mjs
```

It reads:

- `benchmark/fixtures/memories.jsonl`
- `benchmark/fixtures/meter.jsonl`

See [docs/case-study.md](./docs/case-study.md) for a sanitized example of how to
interpret the numbers.

## Proxy And Rate Limits

The proxy is optional. Use it when an agent can point its LLM `base_url` at a
local HTTP gateway.

```bash
npx thrift-proxy \
  --upstream=https://api.anthropic.com \
  --port=8787 \
  --budget=4000 \
  --meter-path=~/.thrift/meter.jsonl
```

Then configure the agent's LLM base URL as `http://localhost:8787` and keep using
the real provider API key.

The proxy:

- trims live request context under a hard token budget,
- writes the same savings receipts as the MCP surface,
- retries upstream `429` and `503 Retry-After` responses,
- throttles concurrent upstream requests per provider.

Rate-limit defaults:

| Setting | Default | Env var |
| --- | ---: | --- |
| Max concurrency | `5` | `THRIFT_MAX_CONCURRENCY` |
| Max retries | `5` | `THRIFT_MAX_RETRIES` |
| Backoff base | `1000ms` | `THRIFT_BACKOFF_BASE_MS` |
| Max backoff | `60000ms` | `THRIFT_MAX_BACKOFF_MS` |

`thrift-proxy` buffers responses in this version; streaming passthrough is a
future improvement.

## Import Existing Memories

The import script is generic and local-only. It can import markdown files into a
JSONL store:

```bash
node scripts/import-memories.mjs \
  --source=./memory \
  --scope=org \
  --store-path=~/.thrift/memories.jsonl \
  --dry-run
```

For agent-scoped memories, put markdown files under project directories and use
`--scope=agent`:

```text
memory/
  checkout-service/
    dev.md
    qa.md
  docs-site/
    writer.md
```

```bash
node scripts/import-memories.mjs --source=./memory --scope=agent
```

## Library Usage

```ts
import { JsonlStore, ScopedRetriever, InMemoryMeter, ThriftMcpServer } from "thrift-memory";

const server = new ThriftMcpServer({
  store: new JsonlStore({ path: "./memories.jsonl" }),
  retriever: new ScopedRetriever(),
  meter: new InMemoryMeter(),
  defaultTokenBudget: 2000,
});

await server.runStdio();
```

## Development

```bash
npm install
npm run typecheck
npm run build
npm test
```

## Layout

| Path | Purpose |
| --- | --- |
| `src/mcp/` | MCP stdio server and tool definitions |
| `src/store/` | JSONL memory store |
| `src/retrieval/` | Scoped budget-bounded recall |
| `src/meter/` | Token meter and rollups |
| `src/control/` | CLI and local dashboard |
| `src/proxy/` | HTTP proxy, context trimming, rate-limit retries |
| `benchmark/fixtures/` | Synthetic public benchmark data |
| `docs/` | Public docs, screenshot, sanitized case study |
| `test/` | Unit and integration tests |

## License

[Apache-2.0](./LICENSE)
