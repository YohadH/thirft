# Awesome-MCP-Servers Submission Draft

Ready-to-use draft for getting **Thrift Memory** listed on the community
"awesome-mcp-servers" lists. This file is a **local draft only** — actually
submitting requires forking a third-party GitHub repo and opening a pull request
there, which is intentionally left to a human. Do **not** push, fork, or open a PR
from an agent.

Project: `thrift-memory` · repo <https://github.com/YohadH/thrift-memory> ·
npm [`thrift-memory`](https://www.npmjs.com/package/thrift-memory) · Apache-2.0 ·
MCP tools: `remember`, `recall`, `search_memory`.

Naming rule (firm): always **"Thrift Memory"**, never bare "Thrift" — avoids
collision with Apache Thrift (the RPC framework).

---

## Pre-flight checklist (list requirements — all confirmed)

| Requirement | Status | Evidence |
| --- | --- | --- |
| Clear one-line description | ✅ | README line 3 / `package.json` `description` |
| Working install instructions | ✅ | `npm install -g thrift-memory` / `npx thrift-memory`; `.mcp.json` block in README + USER-GUIDE |
| Open-source license | ✅ | Apache-2.0 (`LICENSE`, `package.json` `"license": "Apache-2.0"`) |
| Actually an MCP server | ✅ | stdio MCP server exposing `remember` / `recall` / `search_memory` (README "MCP Tools") |
| Public GitHub repo | ✅ | <https://github.com/YohadH/thrift-memory> (public since 2026-07-01) |
| Published to npm | ✅ | <https://www.npmjs.com/package/thrift-memory> (v0.0.7) |

---

## Target 1 — punkpeye/awesome-mcp-servers (primary, most active)

- **List:** punkpeye/awesome-mcp-servers
- **URL:** <https://github.com/punkpeye/awesome-mcp-servers>
- **Target section:** `🧠 Knowledge & Memory`
- **Why this section:** it is where memory-MCP servers (the Official Memory MCP,
  memory-graph servers, etc.) are grouped. Thrift Memory is a memory server for
  coding agents, so it belongs alongside them — differentiated on the cost /
  token-budget axis rather than recall-quality.

### Legend badges that apply to Thrift Memory

Per this list's legend: `📇` TypeScript codebase · `🏠` Local Service.
(Optionally `🍎 🪟 🐧` — it is a cross-platform Node stdio server — but keep it to
`📇 🏠` unless the maintainer's convention in the section shows OS badges on
comparable local Node servers.)

### Exact entry line (matches this list's format)

```markdown
- [YohadH/thrift-memory](https://github.com/YohadH/thrift-memory) 📇 🏠 - Cost-first MCP memory server for coding agents. Recalls only task-relevant memory under a hard token budget and returns a savings receipt (baselineTokens vs injectedTokens vs savedTokens) on every recall.
```

Shorter variant if the maintainer prefers one-sentence descriptions:

```markdown
- [YohadH/thrift-memory](https://github.com/YohadH/thrift-memory) 📇 🏠 - Cost-first memory server for coding agents: recalls task-relevant memory under a hard token budget and proves the tokens saved on every recall.
```

---

## Target 2 — wong2/awesome-mcp-servers (secondary)

- **List:** wong2/awesome-mcp-servers
- **URL:** <https://github.com/wong2/awesome-mcp-servers>
- **Target section:** `Community Servers` (this list has no dedicated Memory
  section; memory servers such as "Memory", "Jean Memory", and "Memory-Plus" all
  live under Community Servers).
- **Entry format:** `**[Name](URL)** - Description` (no emoji badges), kept in the
  list's roughly alphabetical order within the section.

### Exact entry line (matches this list's format)

```markdown
**[Thrift Memory](https://github.com/YohadH/thrift-memory)** - Cost-first MCP memory server for coding agents; recalls task-relevant memory under a hard token budget and returns a savings receipt (baseline vs injected vs saved tokens) on every recall.
```

---

## Target 3 (optional) — appcypher/awesome-mcp-servers

- **List:** appcypher/awesome-mcp-servers
- **URL:** <https://github.com/appcypher/awesome-mcp-servers>
- **Target section:** the "Knowledge & Memory" / "Memory Management" grouping
  (verify the exact current heading at submission time — awesome lists reorganize).
- **Entry line:** reuse the punkpeye-style line above; drop the badges if that
  list doesn't use them.

---

## PR body / justification (paste into the pull request description)

> **Add Thrift Memory to Knowledge & Memory**
>
> Thrift Memory is an open-source (Apache-2.0), npm-published MCP server for coding
> agents. It exposes the standard memory tools `remember`, `recall`, and
> `search_memory` over stdio, and installs with `npx thrift-memory` or via a
> one-line `.mcp.json` entry (works in Claude Code, Cursor, Windsurf, and any
> MCP-capable client).
>
> What makes it distinct from other memory servers in this section: it is
> **cost-first**. Every `recall` runs under a hard token budget and returns a
> savings receipt — `baselineTokens` (everything that would have loaded),
> `injectedTokens` (what was actually returned), and `savedTokens` — so teams can
> *measure* the memory-token cost they avoid instead of assuming it. This targets
> the common waste where coding agents reload large `MEMORY.md` / `AGENTS.md` /
> project context files at every session start.
>
> - Repo: https://github.com/YohadH/thrift-memory
> - npm: https://www.npmjs.com/package/thrift-memory
> - License: Apache-2.0
> - MCP tools: `remember`, `recall`, `search_memory`
> - Language: TypeScript · Scope: local service
>
> I followed the contribution format for this list (alphabetical placement within
> the section, correct language/scope badges, single-line description). Thanks for
> maintaining the list!

---

## Human action still required (NOT done by the agent)

Actually landing these entries means, for **each** target list:

1. Fork the third-party repo on GitHub.
2. Add the exact entry line above into the correct section (keep alphabetical
   order; match the surrounding badge/format style exactly).
3. Commit on a branch and open a pull request against the upstream list using the
   PR body above.
4. Respond to any maintainer review comments.

An agent must **not** perform steps 1–4 (no fork, no push, no PR to any remote).
This draft is where the agent's work ends.
