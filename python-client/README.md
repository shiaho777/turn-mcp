# turn-mcp-client

Python client for [turn-mcp-web](https://github.com/shiahonb777/turn-mcp) — a self-hosted human-in-the-loop server for AI agents.

## Installation

```bash
pip install turn-mcp-client
```

Or directly from the repo:

```bash
pip install ./python-client
```

## Quick Start

Make sure the turn-mcp-web server is running first:

```bash
npx turn-mcp-web           # or: node dist/server.js
```

Then call `wait()` from any Python AI workflow:

```python
from turn_mcp_client import TurnMcpClient, TurnMcpTimeout, TurnMcpCanceled

client = TurnMcpClient("http://127.0.0.1:3737")

try:
    reply = client.wait(
        context="Analysed schema: plan to drop the `old_users` table (32 rows, no FK refs).",
        question="Should I proceed with the DROP TABLE?",
        options=["Yes, proceed", "No, stop", "Show me the migration first"],
    )
    print("Human replied:", reply)
except TurnMcpTimeout:
    print("Nobody responded — skipping.")
except TurnMcpCanceled:
    print("Operator canceled the request.")
```

The `wait()` call blocks until a human replies in the browser console at `http://127.0.0.1:3737/`.

## With Authentication

```python
client = TurnMcpClient(
    base_url="http://127.0.0.1:3737",
    api_key="your-operator-key",   # or set TURN_MCP_API_KEY env var
)
```

## Async Support

```python
import asyncio
from turn_mcp_client import TurnMcpClient

client = TurnMcpClient()

async def main():
    reply = await client.async_wait(
        context="About to deploy to production.",
        question="Confirm deploy?",
    )
    print(reply)

asyncio.run(main())
```

## LangChain Tool Integration

```python
from langchain.tools import tool
from turn_mcp_client import TurnMcpClient

_client = TurnMcpClient()

@tool
def human_checkpoint(context: str) -> str:
    """Ask a human for approval or guidance before proceeding."""
    return _client.wait(context=context, question="How should I proceed?")
```

## Environment Variables

| Variable | Description |
|---|---|
| `TURN_MCP_URL` | Server base URL (default: `http://127.0.0.1:3737`) |
| `TURN_MCP_API_KEY` | Operator API key |

## API Reference

### `TurnMcpClient(base_url, api_key, default_timeout_seconds)`

### `client.wait(context, question, options, agent_name, session_id, timeout_seconds) → str`

Blocks until a human replies. Returns that reply unchanged.

Raises `TurnMcpTimeout`, `TurnMcpCanceled`, `TurnMcpInterrupted`, or `TurnMcpError`.

### `await client.async_wait(...)` 

Async version of `wait()`. Same parameters.
