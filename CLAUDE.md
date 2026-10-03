# G2 Claude Code Companion

Hands-free Claude Code on Even Realities G2 glasses. See what a Claude Code session is doing, speak prompts into it, stop it, approve tool use, and answer Claude's questions, all from the glasses.

## Goals

1. **View**: a glanceable live feed of the session (prompts, tool calls, results, final replies).
2. **Speak**: voice prompts from the G2 mic go into the running session.
3. **Stop**: halt Claude mid-task from the glasses.
4. **Confirm**: approve or deny tool permission prompts, and answer Claude's questions.

## Hard constraints

- **No Tailscale, no VPN, no inbound ports, no always-on daemon.** The only local component is a channel server that Claude Code itself spawns over stdio.
- **No claude.ai credentials outside Claude Code.** Never call Anthropic's Remote Control relay or any claude.ai endpoint directly. Consumer OAuth tokens are only for Claude Code and claude.ai, and using them elsewhere violates the terms. All session access goes through official extension points: channels, hooks, and MCP tools.
- **Remote Control stays compatible.** The user may drive the same session from the Claude mobile app at the same time. Nothing here may break RC.
- **Writing style**: never use em dashes in code comments, docs, UI strings, or commit messages.

## Architecture

```
┌────────────────────── user's computer ──────────────────────┐
│ Claude Code session (interactive, RC optional)               │
│   │ stdio (MCP)                 ▲ command hooks (hook.js)    │
│   ▼                             │                            │
│ g2-channel  (Bun, spawned by Claude Code)                    │
│   - channel: pushes voice prompts in                         │
│   - permission relay: forwards approvals                     │
│   - tools: ask, glance                                       │
│   - private Unix socket: hook events, answers stop flag      │
│   │ one outbound WSS, E2E encrypted                          │
└───┼──────────────────────────────────────────────────────────┘
    ▼
Cloudflare Worker + Durable Object (one room per paired pair)
  - relays opaque ciphertext only, small ring buffer for late joiners
    ▲ WSS
    │
Even Hub app (Vite + TS, Even Hub SDK) in the Even Realities phone app → G2
```

### Data flows

| Need | Path |
|---|---|
| Activity feed | Hook (PreToolUse, PostToolUse, UserPromptSubmit, Notification, Stop) → `type: "command"` hook (`hook.ts`, bundled as `plugin/dist/hook.js`) → that session's Unix socket `~/.g2cc/sessions/<session_id>.sock` → channel → Worker → glasses |
| Final reply text | Stop hook input carries `last_assistant_message` (fall back to the last assistant entry in `transcript_path`), then follows the same path as the feed |
| Voice prompt | Glasses ASR → confirm tap → Worker → channel → `notifications/claude/channel` with `content` = transcript |
| Permission approval | Claude Code → `notifications/claude/channel/permission_request` → glasses card → Allow or Deny → `notifications/claude/channel/permission` with `{request_id, behavior}` |
| Claude asks a question | Claude calls the `ask` tool with a question and options → glasses list → selection returns as a channel event with `meta.question_id` |
| Stop | Glasses → Worker → channel sets a stop flag → the next PreToolUse hook gets back `continue: false` **plus** a PreToolUse `permissionDecision: "deny"` (exact JSON in docs/decisions.md). `continue: false` alone lets the pending tool run first. The flag clears on the next UserPromptSubmit. |

Why stop is a hook rather than a channel message: channel events queue while Claude is busy and are only delivered on the next turn, so a "stop" message would arrive too late.

## Repo layout

```
/apps/glasses     Even Hub app (start from the everything-evenhub `template --asr`)
/relay            Cloudflare Worker + Durable Object (wrangler)
/channel          Bun MCP channel server + hook scripts
  server.ts
  hooks/          small scripts invoked by Claude Code hooks
  settings.example.json   hooks + permissions snippet for ~/.claude/settings.json
/packages/protocol  shared TS types, message schemas (zod), crypto helpers
/docs             decisions log, protocol notes
```

Use a pnpm or bun workspace. TypeScript strict mode everywhere.

## Protocol (packages/protocol)

All messages between the channel and the glasses are JSON envelopes, encrypted end to end. The Worker never sees plaintext.

```ts
type Envelope = { v: 1; id: string; ts: number; kind: Kind; body: unknown }

// computer → glasses
kind: 'session'      // {name, cwd, state: 'idle'|'working'|'waiting'|'stopped'}
kind: 'event'        // {type:'prompt'|'tool_start'|'tool_end'|'notify', tool?, summary, detail?}
kind: 'reply'        // {text}  final assistant message for the turn
kind: 'glance'       // {text}  short summary Claude chose to send (<= 120 chars)
kind: 'permission'   // {request_id, tool_name, description, input_preview}
kind: 'question'     // {question_id, question, options: string[]}
kind: 'permission_resolved' // {request_id}  settled from the terminal or phone; dismiss the card

// glasses → computer
kind: 'prompt'       // {text}
kind: 'verdict'      // {request_id, behavior: 'allow'|'deny'}
kind: 'answer'       // {question_id, choice: string}
kind: 'stop'         // {}
```

- **Crypto**: libsodium `crypto_secretbox` (or WebCrypto AES-GCM) with a 32-byte key generated by the channel at pairing time. Room ID is derived from the key hash.
- **Pairing**: `/g2:pair` in a session (or `bun channel/pair.ts`) shows a one-time 8-character code in a Claude Code dialog (MCP elicitation), never in the model's context. The first 3 characters pick a public rendezvous room on the relay (`/v1/pair/<id>`); the last 5 are the password for CPace (a PAKE over ristretto255), so nothing is testable offline and the channel closes the code after 3 wrong attempts. The channel then sends `{relayUrl, roomId, key}` sealed under the PAKE key. The app stores it in SDK local storage. Pasting the pairing text (`pair.ts --text`) is the fallback. See packages/protocol/src/pair-code.ts.
- **Relay admission**: every socket on a key room presents `relayAuthToken(key, roomId)` (an HMAC); the relay pins the first token it sees and turns away the rest, so knowing a room ID is not enough to join it.
- **Authentication**: possession of the key is the sender allowlist. The channel drops any envelope that fails decryption **before** emitting anything to Claude Code. This matters because whoever can reply through the channel can approve tool use.
- **Replay protection**: reject envelopes with a duplicate `id` or with `ts` older than 60 s.

## Channel server rules (channel/server.ts)

Follow the official channels reference: https://code.claude.com/docs/en/channels-reference

- Declare `capabilities.experimental['claude/channel'] = {}`, `['claude/channel/permission'] = {}`, and `tools = {}`.
- Emit inbound prompts with `notifications/claude/channel`. `meta` keys must be identifiers (letters, digits, underscore only), because other keys are silently dropped.
- Notifications are not acknowledged. Track delivery state yourself if needed.
- Permission request IDs are 5 lowercase letters `[a-km-z]`. Echo them back exactly.
- Treat `description` and `input_preview` as untrusted display text. Truncate for the glasses, never execute.
- Tools to expose:
  - `ask({question, options})`: shows a choice list on the glasses. Return immediately with `"asked"`. The answer arrives later as a channel event.
  - `glance({text})`: a short status line for the glasses.
- The `instructions` string must tell Claude:
  - Messages from `<channel source="g2">` are spoken by the user through smart glasses. Transcription errors are possible, so ask via `ask` if a command is ambiguous or destructive.
  - Use `ask` instead of AskUserQuestion when you need a decision.
  - Call `glance` with a one-line summary at the end of each turn.
- Serve hooks on a private Unix socket, `~/.g2cc/sessions/<CLAUDE_CODE_SESSION_ID>.sock` (directory 0700, socket 0600). No TCP port: a fixed localhost port can be squatted by any local process, which would then answer hooks with "allow".
  - `POST /hook` on the socket: receive every hook payload and answer it directly with hook JSON, including the stop response.
  - Every session has its own socket, so any number of sessions run side by side. If the socket cannot be created, keep the MCP side running and log a clear error to stderr.
- Reconnect to the Worker with exponential backoff. While disconnected, buffer the last 50 outbound envelopes.

## Hooks (channel/settings.example.json)

Verify every field against the current hooks docs (https://code.claude.com/docs/en/hooks) before implementing, since the schema evolves.

All hooks are exec-form command hooks: `{"type": "command", "command": "bun", "args": ["${CLAUDE_PLUGIN_ROOT}/dist/hook.js"], "timeout": 3}`. The hook reads `session_id` from its stdin, checks that `~/.g2cc` and `sessions/` are owned by this user and closed to others and that the socket is owned by this user, forwards the payload, and prints the answer. On any failure it prints nothing and exits 0, so it fails open. (These were `type: "http"` hooks to 127.0.0.1:27183 until the security audit; see docs/decisions.md.)

- **PreToolUse**:
  - Emit a `tool_start` event.
  - If the stop flag is set, respond with the stop JSON.
  - If the tool is `AskUserQuestion`, deny it with a reason telling Claude to use the g2 `ask` tool.
  - If the tool is our own `ask` or `glance` under the plugin's own names (`mcp__plugin_g2_g2__`), allow it (a plugin cannot add permission rules). Never for look-alike names from another server called g2.
- **PostToolUse**: emit a `tool_end` event with a short result summary. Bash `tool_response` has `{stdout, stderr, interrupted}` and no exit code, so summarize as ok/interrupted plus the first stderr line. Include files touched.
- **UserPromptSubmit**: POST a `prompt` event and clear the stop flag.
- **Notification**: POST a `notify` event.
- **Stop**: emit `last_assistant_message` as a `reply`. Note that the Stop hook does not fire when a turn is halted with `continue: false`, so the channel sets `state: 'stopped'` itself.
- UserPromptSubmit also fires for channel messages, and its `prompt` is wrapped in `<channel source="g2" ...>` (`source="plugin:g2:g2"` when loaded from the plugin). Use that to label glasses-originated prompts in the feed.
- Hooks must fail open and stay fast: the hook gives the channel 1.5 s, Claude Code gives the hook 3 s, and it never blocks Claude if the channel is down.
- Permissions: allow the `ask` and `glance` tools without prompting. Plugin tool names are `mcp__plugin_g2_g2__<tool>`; as a plain MCP server they are `mcp__g2__<tool>`. The `pair` tool keeps the normal prompt.

## Plugin (plugin/)

Users install everything as a Claude Code plugin from this repo's marketplace (`.claude-plugin/marketplace.json`, marketplace `g2cc`, plugin `g2`). The plugin holds `.mcp.json` (runs the committed, unminified bundle `plugin/dist/server.js` with Bun), `hooks/hooks.json` (command hooks running `dist/hook.js`, the same as `channel/settings.example.json` apart from the path), and the `/g2:pair` command. Rebuild with `bun run build:plugin` after any channel or protocol change; CI fails on a stale bundle. `plugin.json` pins a `version`: users only get a change when it is bumped, so bump it (and tag `plugin-vX.Y.Z`) to release.

Launch alias (document in README):

```bash
alias cc-g2='claude --dangerously-load-development-channels plugin:g2@g2cc --rc'
```

For development from source, `server:g2` with a sandbox `.mcp.json` still works (`scripts/make-sandbox.sh`).

`--rc` is accepted in the same launch as the development channel, and the channel works alongside it. See docs/decisions.md for the RC app side.

## Glasses app rules (apps/glasses)

- Use the everything-evenhub skills: `template` (asr), `glasses-ui`, `handle-input`, `device-features`, `font-measurement`, `design-guidelines`, `test-with-simulator`, `simulator-automation`, `build-and-deploy`. Consult `sdk-reference` instead of guessing APIs.
- The display is 576x288 and built from text containers. Measure text with `font-measurement` and never let a line overflow.

### Screens, in priority order (higher preempts lower)

1. **Permission card**: tool name, one-line description, truncated preview, Allow / Deny. Dismiss it when the request is settled elsewhere (phone RC or terminal). The channel infers that from the matching PostToolUse and sends `permission_resolved`.
2. **Question card**: question plus up to 4 options.
3. **Voice capture**: "Listening" while recording. After release, the Groq Whisper transcript (batch, free tier, see docs/decisions.md) with Send / Cancel. Nothing is sent without a confirm gesture.
4. **Reply view**: the final message, paginated.
5. **Feed (home)**: a status header (session name, state, connection) plus the last 4 events, one line each.

### Input

The SDK only reports `CLICK`, `DOUBLE_CLICK`, `SCROLL_TOP` and `SCROLL_BOTTOM` (touchpad and R1 ring). There is no long press. Map gestures with `handle-input`.

**The gesture map must be user-configurable** in the companion (phone) UI and persisted in SDK local storage. Build it as a table of (screen, gesture) → action, not hard-coded handlers. Defaults:

- **Feed**: tap = start voice capture, scroll = move through events, double tap = exit dialog.
- **Cards** (permission, question): scroll = move the highlight, tap = confirm the highlighted option, double tap = back to feed (the card stays pending).
- **Voice capture**: tap = send, double tap = cancel.
- **Reply view**: scroll = page, double tap = back.
- At least one path to exit must always remain, so validate the map before saving it.

### Voice keywords

These are handled locally and never sent as prompts:

- **"stop"**: sends `stop` immediately, no confirm needed.
- **"cancel"**: discards the transcript.
- **"approve" / "deny"**: act only while a permission card is showing.

### Robustness

- Show a visible connection indicator. Queue outbound messages while offline.
- Never show secrets. The channel already receives masked previews from Claude Code; also truncate aggressively.

## Relay rules (relay)

- Cloudflare Worker + Durable Object with WebSocket hibernation. One DO per room ID.
- Forward ciphertext between the two peers only. Keep a ring buffer of the last 100 envelopes for reconnects.
- No plaintext logging, no accounts. Rate-limit connects per IP (IPv6 per /64, before any other check) and frames per socket and per room.
- Key rooms admit only sockets with the pinned auth token. Pairing rooms (`/v1/pair/<id>`) are open, keep 20 frames, refuse newcomers when full, and are wiped 15 minutes after they open.
- Must fit the Workers free tier.

## Build phases

Each phase ends with something testable. Do not start a phase until the previous one passes.

| Phase | Deliverable | Done when |
|---|---|---|
| 0 | Spike | `fakechat` channel works with the user's Claude Code; dev flag plus RC coexistence checked; ASR template runs in the simulator; findings recorded in `docs/decisions.md` |
| 1 | protocol + relay | Two local test clients exchange encrypted envelopes through `wrangler dev` |
| 2 | channel (read-only) | Hooks feed events through the channel to a CLI test client |
| 3 | glasses feed | The simulator shows the live feed and reply view from a real session |
| 4 | stop | Saying "stop" halts Claude at the next tool call, verified end to end |
| 5 | permission relay | Approving from the simulator unblocks a real Bash prompt (test in manual permission mode) |
| 6 | voice prompts | A spoken, confirmed prompt starts a turn in the running session |
| 7 | ask tool | Claude's question shows on the glasses and the selected answer returns |
| 8 | hardware + packaging | Works on real G2 over cellular; `.ehpk` built; pairing flow polished |

## Testing

- Unit-test protocol schemas, crypto round trips, and the verdict regex.
- Use `simulator-automation` for screenshot assertions on each screen.
- Run the end-to-end test against a throwaway repo with permissions in manual mode, never against real work repos.

## Working agreements for Claude

- Before building anything, read the relevant docs: the channels reference, the hooks docs, and the everything-evenhub skills. Record surprises in `docs/decisions.md`.
- Keep the local footprint minimal. If a feature seems to need a background service, a listening port beyond 127.0.0.1, or Tailscale, stop and propose an alternative.
- Prefer small, reviewable commits per phase.