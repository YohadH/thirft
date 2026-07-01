---
description: Recall the memory slice relevant to a task under a token budget, then proceed
---

Use the Thrift `recall` tool to load only the memory relevant to the task below. Start with a small budget (600 tokens). Then check the receipt's budget-pressure signals: if `budgetPressure` is `high` or `hasMoreRelevantMemory` is `true`, do ONE more focused recall (narrower task or a larger budget, up to ~2000) before continuing — otherwise proceed with what you have. Briefly state the final savings receipt (`injected / baseline / saved` tokens, and whether you expanded) so the cost benefit stays visible.

Task: $ARGUMENTS
