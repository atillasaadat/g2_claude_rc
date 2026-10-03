#!/usr/bin/env bash
# Developer setup from a clone. Most people should install the plugin instead
# (see README): it does all of this without a clone.
#
# Makes every Claude Code session on this computer reachable from the glasses.
# Use --remove before switching to the plugin, so hooks do not fire twice.
#
#   scripts/install.sh            install (idempotent; backs up settings first)
#   scripts/install.sh --remove   undo
#
# It does three things, all in your own Claude Code config:
#   1. registers the g2 channel as a user-scope MCP server (~/.claude.json)
#   2. adds the http hooks for the feed and stop to ~/.claude/settings.json,
#      and allows the mcp__g2__ask and mcp__g2__glance tools
#   3. prints the cc-g2 alias to add to your shell profile
# Hooks fail open: sessions started without the channel are unaffected.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SETTINGS="${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"
HOOK_URL="http://127.0.0.1:27183/hook"

need() { command -v "$1" >/dev/null || { echo "missing: $1 ($2)" >&2; exit 1; }; }
need bun "https://bun.sh"
need claude "https://code.claude.com"
need jq "sudo apt install jq / brew install jq"

mkdir -p "$(dirname "$SETTINGS")"
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
cp "$SETTINGS" "$SETTINGS.bak.$(date +%Y%m%d%H%M%S)"

# Removes our hook entries and tool permissions, leaving everything else alone.
strip='
  .hooks |= (if . == null then {} else . end)
  | .hooks |= with_entries(.value |= map(select(((.hooks // []) | map(.url) | index($url)) | not)))
  | .hooks |= with_entries(select(.value | length > 0))
  | if .permissions.allow then .permissions.allow -= ["mcp__g2__ask", "mcp__g2__glance"] else . end'

if [ "${1:-}" = "--remove" ]; then
  jq --arg url "$HOOK_URL" "$strip" "$SETTINGS" > "$SETTINGS.tmp" && mv "$SETTINGS.tmp" "$SETTINGS"
  claude mcp remove --scope user g2 >/dev/null 2>&1 || true
  echo "removed the g2 channel and hooks (settings backed up next to $SETTINGS)"
  exit 0
fi

(cd "$ROOT" && bun install --silent)

claude mcp remove --scope user g2 >/dev/null 2>&1 || true
claude mcp add --scope user g2 -- bun "$ROOT/channel/server.ts" >/dev/null
echo "registered MCP server g2 -> bun $ROOT/channel/server.ts (user scope)"

hook='[{"type":"http","url":$url,"timeout":2}]'
jq --arg url "$HOOK_URL" "$strip
  | .hooks.PreToolUse += [{matcher: \"*\", hooks: $hook}]
  | .hooks.PostToolUse += [{matcher: \"*\", hooks: $hook}]
  | .hooks.UserPromptSubmit += [{hooks: $hook}]
  | .hooks.Notification += [{hooks: $hook}]
  | .hooks.Stop += [{hooks: $hook}]
  | .permissions.allow = ((.permissions.allow // []) + [\"mcp__g2__ask\", \"mcp__g2__glance\"] | unique)" \
  "$SETTINGS" > "$SETTINGS.tmp" && mv "$SETTINGS.tmp" "$SETTINGS"
echo "added g2 hooks and tool permissions to $SETTINGS (backup saved alongside)"

cat <<EOF

Add this to your shell profile (~/.zshrc or ~/.bashrc):

  alias cc-g2='claude --dangerously-load-development-channels server:g2 --rc'

Then start sessions in any repo with:  cc-g2
Pair the phone app with:                bun $ROOT/channel/pair.ts
EOF
