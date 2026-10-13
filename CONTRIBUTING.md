# Contributing

## Local Setup

```bash
git clone https://github.com/shiahonb777/turn-mcp.git
cd turn-mcp
npm install
npm run build
npm test
npm start
```

The console runs at `http://127.0.0.1:3737/` and the MCP endpoint is `http://127.0.0.1:3737/mcp`.

## Working Rules

- Keep the runtime dependency surface small.
- Prefer the existing TypeScript and vanilla JS style.
- Update `README.md` when behavior or configuration changes.
- Run `npm test` before opening a pull request.

## Pull Requests

Open focused pull requests with a clear problem statement, the concrete change, and any user-facing impact.

## Issues

For bugs, include reproduction steps, expected behavior, actual behavior, and your Node.js version.
