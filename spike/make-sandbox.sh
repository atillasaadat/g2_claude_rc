#!/usr/bin/env bash
# Creates a throwaway repo wired to the Phase 0 probe channel.
# Usage: spike/make-sandbox.sh [dir]   (default ~/g2cc-sandbox)
set -euo pipefail
DIR="${1:-$HOME/g2cc-sandbox}"
PROBE="$(cd "$(dirname "$0")/channel-probe" && pwd)/server.ts"
mkdir -p "$DIR/.claude"
cd "$DIR"
[ -d .git ] || git init -q
echo "hello from the sandbox" > README.md
cat > .mcp.json <<JSON
{ "mcpServers": { "g2": { "command": "bun", "args": ["$PROBE"] } } }
JSON
hook() { printf '{ "type": "http", "url": "http://127.0.0.1:8790/hook", "timeout": 2 }'; }
cat > .claude/settings.json <<JSON
{
  "hooks": {
    "PreToolUse":       [ { "matcher": "*", "hooks": [ $(hook) ] } ],
    "PostToolUse":      [ { "matcher": "*", "hooks": [ $(hook) ] } ],
    "UserPromptSubmit": [ { "hooks": [ $(hook) ] } ],
    "Notification":     [ { "hooks": [ $(hook) ] } ],
    "Stop":             [ { "hooks": [ $(hook) ] } ]
  },
  "permissions": { "allow": [ "mcp__g2__ask", "mcp__g2__glance" ] }
}
JSON
echo "sandbox ready: $DIR"
