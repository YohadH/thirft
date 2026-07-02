# Thrift Memory vs Mem0 vs Zep vs Graphiti

**Short answer:** Mem0, Zep, and Graphiti compete on **recall quality** — how smart,
temporal, and entity-aware an agent's memory is. **Thrift Memory competes on cost** — it
caps every recall with a **hard token budget** and returns a **savings receipt**
(`baselineTokens` vs `injectedTokens` vs `savedTokens`) so you can *prove* how many tokens
you avoided. They solve different problems, and they are not mutually exclusive.

If your question is *"which memory layer gives the deepest, smartest recall?"* the answer is
Mem0, Zep, or Graphiti. If your question is *"my coding agents keep re-paying to reload big
`MEMORY.md` / `AGENTS.md` / project-context files every run — how do I cap and measure that
cost?"* the answer is Thrift Memory.

> Naming note: this project is always **Thrift Memory** — an MCP memory layer for coding
> agents. It is not affiliated with [Apache Thrift](https://thrift.apache.org/), the RPC
> framework.

## At a glance

| | **Thrift Memory** | Mem0 | Zep | Graphiti |
| --- | --- | --- | --- | --- |
| **Primary axis** | **Cost-first / budgeted recall** | Recall quality (personalization) | Recall quality (temporal memory service) | Recall quality (temporal knowledge-graph engine) |
| **Core idea** | Cap tokens per recall + prove the saving | Distill salient user facts across sessions | Batteries-included memory backend on a temporal graph | Build temporal knowledge graphs (entities/relations over time) |
| **Hard token budget on recall** | **Yes** | No | No | No |
| **Savings receipt (baseline vs injected vs saved)** | **Yes — every recall** | No | No | No |
| **Requires an LLM call to write a memory** | **No** (cheap write path) | Yes (LLM extraction) | Yes (extraction/summarization) | Yes (graph extraction) |
| **Backing store** | Local JSONL (no DB) | Vector store (pgvector), optional graph (Neo4j) | Managed / self-hosted service on Graphiti | Bring-your-own graph DB (typically Neo4j) |
| **Interface** | MCP server (+ optional dashboard & proxy) | SDK / managed platform | SDK / service | Library |
| **Best when** | A fleet of coding agents re-pays the "context tax" every run | One assistant should remember a user over time | You want temporal memory without building the graph | You want to own a temporal knowledge graph |
| **Maturity** | Early `0.0.x` | Production-grade | Production-grade | Production-grade |

Maturity is stated honestly: Thrift Memory is early `0.0.x`; Mem0, Zep, and Graphiti are more
mature at deep recall and we are not pretending otherwise.

## The one distinction that matters: cost accounting, not recall smartness

Every memory tool helps an agent remember *something*. Almost none of them tell you what that
memory **cost** you, or prove you cut it. That is the single axis on which Thrift Memory is
different.

The failure mode Thrift Memory targets is not "my agent forgot something." It is: **every
agent reloads its *entire* memory file — `MEMORY.md`, `AGENTS.md`, `CLAUDE.md`, project
context — at the start of every run, regardless of what that run needs.** That fixed, repeated
cost is the "context tax." A smarter knowledge graph does not fix it; a hard budget plus a
receipt does.

```text
savedTokens = baselineTokens - injectedTokens
```

- **`baselineTokens`** — the no-Thrift-Memory counterfactual: all in-scope memory that *would*
  have been loaded.
- **`injectedTokens`** — the slice Thrift Memory actually returned under the budget.
- **`savedTokens`** — the gap you stopped paying for, logged on every recall.

## How Thrift Memory differs from each one

### vs Graphiti

Graphiti is an open-source **library for building temporal knowledge graphs** — entities,
relationships, and facts that update incrementally over time. You bring your own graph
database (typically Neo4j) and own the retrieval wiring. It optimizes *how expressive and
time-aware* your recall is. Thrift Memory does not build a graph and does not try to be
smarter about recall; it caps recall cost and proves the saving. Different layer, different
job.

### vs Zep

Zep is a **memory service** (managed or self-hosted) built on Graphiti's temporal graph
model — session memory, entity extraction, temporal reasoning, summarization, without you
building the graph plumbing. It trades infrastructure ownership for a batteries-included
recall backend. Thrift Memory trades *nothing* on recall depth — it deliberately stays a thin,
local, cost-first layer — and instead gives you the one thing Zep does not: a per-recall token
budget and a savings receipt.

### vs Mem0

Mem0 is a **personalization memory layer** — writes go through LLM-based extraction to distill
salient facts into a vector store (pgvector, optional Neo4j graph mode) or Mem0's managed
platform. Its pitch is "your assistant remembers the user" with minimal engineering. Two
concrete differences from Thrift Memory: (1) Mem0 spends an LLM call on every write to extract
facts; Thrift Memory's write path is cheap with no mandatory LLM enrichment. (2) Mem0 has no
hard per-recall token budget and emits no savings receipt.

## Can I use them together?

Yes. They are complementary. Thrift Memory can sit **in front of** a heavier recall store as
the budget/metering layer — you keep the deep recall, and you add a hard token ceiling plus a
receipt on top. Pick the deep-recall layer for *what* to remember; add Thrift Memory to
control and measure *how much that recall costs*.

## The honest summary

- Need the deepest, smartest, most temporal recall? Use **Graphiti** (own the graph), **Zep**
  (managed temporal memory), or **Mem0** (single-assistant personalization). They are more
  mature at that than Thrift Memory is.
- Have a fleet of coding agents re-paying the context tax on `MEMORY.md` / `AGENTS.md` reloads
  every run, and want to **cap and measure** that cost with no extra infrastructure? That is
  the gap **Thrift Memory** fills — and it is the only one in this group that returns a savings
  receipt on every recall.

Pick by which sentence describes your actual problem, not by which table has more checkmarks.

See also: the condensed [How It Compares](../README.md#how-it-compares) table in the README
(which also covers the MCP-memory-server field), the longer
[Mem0 vs Zep vs Graphiti write-up](./blog-mem0-vs-zep-vs-graphiti.md), and the
[FAQ](./FAQ.md).

---

Thrift Memory is Apache-2.0 · `npx thrift-memory` to try it · MCP server + optional local
dashboard + optional proxy · `github.com/YohadH/thrift-memory`
