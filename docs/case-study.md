# Sanitized Case Study

This case study uses synthetic fixture data from `benchmark/fixtures/`. It is
not a production trace.

## Setup

A small team has three agents:

| Agent | Job |
| --- | --- |
| `developer` | Implements code changes |
| `qa` | Reviews tests and risk |
| `writer` | Updates documentation |

They share org-level memories and each agent has a few scoped memories. Without
Thrift, each run would load all relevant memory in scope. With Thrift, each run
calls `recall` with a token budget and receives only the best matching slice.

## Example Result

The fixture meter contains five synthetic runs:

| Metric | Value |
| --- | ---: |
| Baseline tokens | 1,740 |
| Injected tokens | 358 |
| Saved tokens | 1,382 |
| Savings rate | 79.4% |

## How To Read It

The important number is not the absolute token count. The important number is
the ratio between:

- `baselineTokens`: what the agent would have loaded without Thrift, and
- `injectedTokens`: what Thrift actually returned under budget.

This is why the dashboard and CLI always show all three numbers. If savings look
good, validate quality separately by replaying representative tasks with full
memory and with Thrift recall.

## Run It

```bash
npm run build
node benchmark/run.mjs
```
