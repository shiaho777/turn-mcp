#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

echo ""
echo -e "  ${BOLD}Turn MCP Web${NC}  — Starting up…"
echo ""

if ! command -v node &>/dev/null; then
  echo -e "  ${RED}✗ Node.js not found.${NC}"
  echo ""
  echo "  Install Node.js >= 18 from https://nodejs.org"
  echo "  macOS (Homebrew) : brew install node"
  echo "  Linux            : https://nodejs.org/en/download/package-manager"
  echo ""
  read -rp "  Press Enter to exit…"
  exit 1
fi

MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$MAJOR" -lt 18 ] 2>/dev/null; then
  echo -e "  ${YELLOW}⚠  Node.js $(node --version) is too old. Required: >= 18.17${NC}"
  echo "  Please upgrade from https://nodejs.org"
  echo ""
  read -rp "  Press Enter to exit…"
  exit 1
fi
echo -e "  ${GREEN}✓${NC}  Node.js $(node --version)"

if [ ! -d "node_modules" ] || [ ! -d "node_modules/@modelcontextprotocol" ]; then
  echo ""
  echo -e "  ${CYAN}→${NC}  Installing dependencies (first run only)…"
  if ! npm install; then
    echo -e "  ${RED}✗ npm install failed.${NC}"
    read -rp "  Press Enter to exit…"
    exit 1
  fi
  echo -e "  ${GREEN}✓${NC}  Dependencies installed"
fi

if [ ! -f "dist/server.js" ]; then
  echo ""
  echo -e "  ${CYAN}→${NC}  Building project…"
  if ! npm run build; then
    echo -e "  ${RED}✗ Build failed.${NC}"
    read -rp "  Press Enter to exit…"
    exit 1
  fi
  echo -e "  ${GREEN}✓${NC}  Build complete"
fi

echo ""
echo -e "  ${BOLD}┌──────────────────────────────────────────────┐${NC}"
echo -e "  ${BOLD}│${NC}  🌐  Web Console   ${CYAN}http://127.0.0.1:3737/${NC}      ${BOLD}│${NC}"
echo -e "  ${BOLD}│${NC}  🔌  MCP Endpoint  ${CYAN}http://127.0.0.1:3737/mcp${NC}   ${BOLD}│${NC}"
echo -e "  ${BOLD}└──────────────────────────────────────────────┘${NC}"
echo ""
echo -e "  Press  ${BOLD}Ctrl+C${NC}  to stop the server."
echo ""

while IFS= read -r OLD_PID; do
  [ -z "$OLD_PID" ] && continue
  echo -e "  ${YELLOW}⚠${NC}  Port 3737 in use (PID $OLD_PID) — asking it to stop..."
  kill -TERM "$OLD_PID" 2>/dev/null
done < <(lsof -ti tcp:3737 2>/dev/null)
sleep 0.4
while IFS= read -r OLD_PID; do
  [ -z "$OLD_PID" ] && continue
  kill -9 "$OLD_PID" 2>/dev/null
done < <(lsof -ti tcp:3737 2>/dev/null)
for _i in 1 2 3 4 5 6; do
  lsof -ti tcp:3737 &>/dev/null || break
  sleep 0.5
done
if lsof -ti tcp:3737 &>/dev/null; then
  echo -e "  ${RED}✗ Port 3737 still in use. Close the existing server first.${NC}"
  read -rp "  Press Enter to exit..."
  exit 1
fi

(
  sleep 1.8
  if command -v open &>/dev/null; then
    open "http://127.0.0.1:3737/"
  elif command -v xdg-open &>/dev/null; then
    xdg-open "http://127.0.0.1:3737/" &
  fi
) &

node dist/server.js &
NODE_PID=$!

trap 'kill -SIGTERM $NODE_PID 2>/dev/null' SIGINT SIGTERM SIGHUP

wait $NODE_PID
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
  echo ""
  echo -e "  ${RED}✗ Server exited with code $EXIT_CODE${NC}"
  echo ""
  read -rp "  Press Enter to close..."
fi
