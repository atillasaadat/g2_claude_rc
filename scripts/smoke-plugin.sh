#!/usr/bin/env bash
# Installs the g2 plugin the way a new user does (public marketplace, a fresh
# Claude Code config, no login), then starts its MCP server and hook script.
# Run by the nightly workflow; safe to run locally (it never touches ~/.claude).
#
#   scripts/smoke-plugin.sh [owner/repo]
set -euo pipefail
REPO="${1:-atillasaadat/g2_claude_rc}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export CLAUDE_CONFIG_DIR="$WORK/claude" G2CC_HOME="$WORK/g2cc" GIT_TERMINAL_PROMPT=0
mkdir -p "$CLAUDE_CONFIG_DIR"
fail() { echo "FAIL $*" >&2; exit 1; }

echo "claude $(claude --version)"
claude plugin marketplace add "$REPO" >/dev/null || fail "marketplace add $REPO"
claude plugin install g2@g2cc >/dev/null || fail "plugin install g2@g2cc"
ROOT="$(ls -d "$CLAUDE_CONFIG_DIR"/plugins/cache/g2cc/g2/*/ | head -1)"
[ -f "$ROOT/dist/server.js" ] && [ -f "$ROOT/dist/hook.js" ] || fail "bundles missing in $ROOT"
echo "ok   installed g2@g2cc $(basename "$ROOT")"
claude plugin validate "$ROOT" >/dev/null || fail "plugin validate"
echo "ok   plugin validates"

# The MCP server answers initialize as a channel with tools.
init='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
reply="$( (echo "$init"; sleep 4) | CLAUDE_PLUGIN_ROOT="$ROOT" CLAUDE_CODE_SESSION_ID=00000000-0000-4000-8000-000000000000 \
  timeout 10 bun "$ROOT/dist/server.js" 2>/dev/null | head -1 || true)"
echo "$reply" | grep -q '"claude/channel"' || fail "server did not answer initialize as a channel: ${reply:0:200}"
echo "ok   MCP server starts and declares the channel"

# The hook fails open: no channel socket, so it prints nothing and exits 0.
out="$(echo '{"session_id":"00000000-0000-4000-8000-000000000001","hook_event_name":"PreToolUse"}' | bun "$ROOT/dist/hook.js")" || fail "hook exited non-zero"
[ -z "$out" ] || fail "hook printed output without a channel: $out"
echo "ok   hook fails open"
echo "all checks passed"
