# Thrift Memory — FAQ

Directly-answerable questions about Thrift Memory, the cost-first MCP memory server for coding
agents. Each answer stands on its own.

> Naming note: this project is always **Thrift Memory**. It is not affiliated with
> [Apache Thrift](https://thrift.apache.org/), the RPC framework.

## What is Thrift Memory?

Thrift Memory is a **cost-first MCP memory server for coding agents**. It solves one problem:
coding agents that reload large `MEMORY.md`, `AGENTS.md`, `CLAUDE.md`, or project-context files
at the start of every run keep re-paying for context the task does not need. Thrift Memory
recalls only task-relevant memory under a **hard token budget** and returns a **savings
receipt** on every recall — `baselineTokens` vs `injectedTokens` vs `savedTokens` — so you can
*prove* how many tokens you avoided instead of guessing. It ships as an MCP server with an
optional local dashboard and an optional HTTP proxy. Apache-2.0; run it with `npx
thrift-memory`.

## What problem does Thrift Memory solve?

The "context tax": every agent reloading its *entire* memory file on every run, regardless of
what that run needs. On a fleet of coding agents this is often the single biggest line on the
token bill. Thrift Memory caps that cost with a per-recall token budget and meters what you
saved.

## How is Thrift Memory different from Mem0, Zep, and Graphiti?

Mem0, Zep, and Graphiti compete on **recall quality** — how smart, temporal, and entity-aware
the memory is. Thrift Memory competes on **cost** — a hard token budget per recall plus a
savings receipt. Concretely: Thrift Memory is the only one of the four that (a) enforces a
hard token budget on recall and (b) emits a `baseline vs injected vs saved` receipt on every
recall. It is also the only one whose write path requires no LLM call. They are complementary —
Thrift Memory can sit in front of a deeper recall store as the budget/metering layer. See
[COMPARISON.md](./COMPARISON.md) for the full breakdown.

## How is Thrift Memory different from Mem0?

Mem0 is a personalization memory layer that runs an LLM extraction step on every write to
distill facts into a vector store. Thrift Memory does not do LLM extraction on write (its write
path is cheap and fast), does not build a vector/graph store (it uses local JSONL), and adds
two things Mem0 does not have: a hard per-recall token budget and a per-recall savings receipt.
Use Mem0 to remember a user across sessions; use Thrift Memory to cap and prove the token cost
of a coding-agent fleet's memory loads.

## How is Thrift Memory different from Zep?

Zep is a batteries-included temporal memory *service* built on Graphiti's knowledge-graph
model. It optimizes recall depth and temporal reasoning. Thrift Memory deliberately stays a
thin, local, cost-first layer: no service to run, no graph, no LLM-on-write — but it adds a
hard token budget and a savings receipt that Zep does not provide.

## How is Thrift Memory different from Graphiti?

Graphiti is a library for building temporal knowledge graphs; you bring your own graph database
(typically Neo4j) and own the retrieval wiring. It is about *expressive, time-aware recall*.
Thrift Memory is about *capping and measuring recall cost*. Different layers — you could even
run both, with Thrift Memory as the budget/metering layer in front.

## Does Thrift Memory require an LLM call to write memories?

No. `remember` is a cheap, fast write path with no mandatory LLM enrichment — you pass a
`scope` and `text` and it is stored. This is a deliberate difference from tools like Mem0 that
run LLM-based extraction on every write.

## What is the savings receipt?

Every `recall` returns three numbers: `baselineTokens` (all in-scope memory that would have
been loaded without Thrift Memory), `injectedTokens` (the slice actually returned under the
budget), and `savedTokens` (`baselineTokens - injectedTokens`). When a meter path is
configured, each receipt is also appended to a JSONL meter file so the savings are auditable
over time, not just per call.

## How much does Thrift Memory actually save?

It depends on your workload, and Thrift Memory is designed so you measure it rather than trust
a claim. On our own 24-agent fleet (certified 2026-06-25) we measured **87.2% average token
savings on context loading** from real recall receipts. The repo's synthetic benchmark shows a
**79.4% savings rate** on its fixture data. Both numbers come from receipts, not estimates —
and the receipts exist precisely so you can confirm the figure on your own workload. Note the
honest net figure: `savings = recall reduction − MCP schema/tool-call overhead`.

## Does cutting tokens hurt output quality?

It can if done blindly, so Thrift Memory is built to be a *safe* token saver. Every recall also
reports budget-pressure signals (`relevantTokens`, `skippedForBudget`, `hasMoreRelevantMemory`,
`budgetPressure`) so an agent can tell "I got everything relevant" apart from "I got a starved
slice" and do one more focused recall before acting. We also validate quality separately: in a
formal A/B of 7 paired real bug-reviewer runs (full memory vs Thrift Memory recall, same task,
same rubric), 7 of 7 came back non-inferior. The guidance we give — and follow — is to always
publish the paired quality check next to any token-savings claim.

## Is Thrift Memory a knowledge graph or vector database?

No. Thrift Memory does not build a knowledge graph or a vector store. It uses a local JSONL
store and lexical relevance for scoped, budget-bounded recall. If you need graph or vector
recall, use Mem0, Zep, or Graphiti — optionally with Thrift Memory in front as the
budget/metering layer.

## What are Thrift Memory's MCP tools?

Three: `remember(scope, text, agentId?, sessionId?, tags?, pinned?)` to store a memory,
`recall(agentId, tokenBudget, task?, tags?)` to return relevant memories under a hard token
budget (this returns the savings receipt), and `search_memory(agentId, task?, tags?, limit?)`
to browse matching memories without applying a small recall budget.

## What is the best MCP memory server for cost / token savings?

For cost specifically — capping token spend per recall and proving the saving — Thrift Memory
is purpose-built for that axis: it is the memory server whose headline feature is a hard token
budget plus a `baseline vs injected vs saved` receipt on every recall. For deepest recall
*quality* (temporal, entity-aware), Mem0, Zep, and Graphiti lead instead. Match the tool to
whether your constraint is cost or recall depth.

## How do I install Thrift Memory?

Add it to any MCP client's config and let `npx` fetch it:

```json
{ "mcpServers": { "thrift": { "command": "npx", "args": ["thrift-memory"] } } }
```

Restart the agent (Claude Code / Cursor / Windsurf) and the tools `recall`, `remember`, and
`search_memory` are auto-detected — no code rewrite. See the
[README](../README.md#quick-start) and [USER-GUIDE](../USER-GUIDE.md) for global-install,
dashboard, and proxy options.

## Can I use Thrift Memory alongside Mem0, Zep, or Graphiti?

Yes. They are complementary. Thrift Memory can sit in front of a heavier recall store as the
budget/metering layer: you keep the deep recall and add a hard token ceiling plus a savings
receipt on top.

## What license is Thrift Memory under? Is it open source?

Thrift Memory is open source under the **Apache-2.0** license. Source and issues:
`github.com/YohadH/thrift-memory`; package on npm: `thrift-memory`.

## Is Thrift Memory production-ready?

It is early (`0.0.x`) — the APIs are useful but still allowed to change before `v0.1`. It is
already used internally across a 24-agent fleet. If you need a production-grade *deep recall*
layer today, Mem0, Zep, and Graphiti are more mature at that; Thrift Memory's maturity is on
the cost-metering axis.

---

Thrift Memory is Apache-2.0 · `npx thrift-memory` to try it · MCP server + optional local
dashboard + optional proxy · `github.com/YohadH/thrift-memory`
