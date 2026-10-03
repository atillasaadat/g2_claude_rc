#!/usr/bin/env bash
# Creates (or refreshes) a throwaway repo wired to the real g2 channel.
# Usage: scripts/make-sandbox.sh [dir]   (default ~/g2cc-sandbox)
# Never point this at a real work repo: end-to-end tests run there.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="${1:-$HOME/g2cc-sandbox}"
mkdir -p "$DIR/.claude"
cd "$DIR"
[ -d .git ] || git init -q
[ -f README.md ] || echo "hello from the sandbox" > README.md
cat > .mcp.json <<JSON
{ "mcpServers": { "g2": { "command": "bun", "args": ["$ROOT/channel/server.ts"] } } }
JSON
cp "$ROOT/channel/settings.example.json" .claude/settings.json
echo "sandbox ready: $DIR"
echo "launch: cd $DIR && claude --dangerously-load-development-channels server:g2 --rc"
