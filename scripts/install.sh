#!/usr/bin/env bash
# Removes the old global setup (before the plugin): the user-scope g2 MCP
# server, its http hooks on 127.0.0.1:27183, and its tool permissions.
# Install the g2 plugin instead (see README); run this first if you used the
# old script, or every hook fires twice.
#
#   scripts/install.sh --remove     undo the old setup (backs up settings first)
#
# For development from source, use scripts/make-sandbox.sh.
set -euo pipefail

if [ "${1:-}" != "--remove" ]; then
  echo "The global install is gone: install the g2 plugin instead (README, Set up)." >&2
  echo "Run 'scripts/install.sh --remove' to clean up an old install." >&2
  exit 1
fi

SETTINGS="${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"
HOOK_URL="http://127.0.0.1:27183/hook"
command -v jq >/dev/null || { echo "missing: jq (sudo apt install jq / brew install jq)" >&2; exit 1; }

if [ -f "$SETTINGS" ]; then
  cp "$SETTINGS" "$SETTINGS.bak.$(date +%Y%m%d%H%M%S)"
  jq --arg url "$HOOK_URL" '
    .hooks |= (if . == null then {} else . end)
    | .hooks |= with_entries(.value |= map(select(((.hooks // []) | map(.url) | index($url)) | not)))
    | .hooks |= with_entries(select(.value | length > 0))
    | if .hooks == {} then del(.hooks) else . end
    | if .permissions.allow then .permissions.allow -= ["mcp__g2__ask", "mcp__g2__glance"] else . end' \
    "$SETTINGS" > "$SETTINGS.tmp" && mv "$SETTINGS.tmp" "$SETTINGS"
fi
if command -v claude >/dev/null; then claude mcp remove --scope user g2 >/dev/null 2>&1 || true; fi
echo "removed the old g2 server, hooks and permissions (settings backed up next to $SETTINGS)"
