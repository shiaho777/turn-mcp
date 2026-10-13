---
name: turn-mcp-web
description: "Route human-in-the-loop checkpoints through Turn MCP Web by calling `turn.wait` (aliases: `turn_wait`, `turn`). Use when an agent has access to the Turn MCP server and must pause for approvals, clarifications, branch choices, or operator handoffs without ending the current run."
---

# Turn MCP Web

Use this skill to keep one agent run alive while a human replies in the Turn MCP browser console.

## Verify Tool Access

Check whether `turn.wait`, `turn_wait`, or `turn` is available before first use.

If none of them exist, say that clearly and do not pretend the checkpoint loop is active.

## Send Checkpoints Through Turn MCP

Call `turn.wait` whenever you need:

- approval before a consequential action
- missing information that blocks the next step
- a branch decision with a small, known option set
- a human handoff after finishing a meaningful step

Do not answer the human directly when the next reply should stay inside the same agent run.

## Call Contract

```python
turn.wait(
  context="What you finished, what you found, and what happens next.",
  question="The exact decision or information you need.",
  options=["Proceed", "Revise", "Stop"],
  agentName="ReleaseAgent"
)
```

- `context` is required. Write it for a cold reader.
- The tool result is the operator's exact reply. A closed session or a server shutdown comes back as `[interrupted]`.
- `question` should ask one concrete thing.
- `options` should be used when the branch set is known.
- `agentName` should stay stable within the workflow.

## Write for Cold Reads

Every wait message should let a human understand the situation without scrolling through prior logs.

- Summarize completed work.
- State the current blocker or decision.
- State the next action that follows each answer.
- Prefer short option buttons over free-form typing when possible.

## Keep the Loop Alive

Follow this loop:

1. Work until a human checkpoint exists.
2. Call `turn.wait`.
3. Resume from the returned reply.
4. Call `turn.wait` again at the next meaningful checkpoint.

The human ends the session. Do not end it on your own while the task is still active.

## Immediate Behavior

After loading this skill:

1. Confirm that `turn.wait` is available.
2. If the user has not already given a concrete task, call `turn.wait` immediately, say that you are ready, and ask what they want done.
3. If the user already gave a task, start work and call `turn.wait` at the first real checkpoint.

For a Chinese handoff copy, read [`references/skill.zh-CN.md`](./references/skill.zh-CN.md).
