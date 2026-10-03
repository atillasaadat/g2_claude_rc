# Decisions log

## Phase 0 spike (2026-10-02)

Environment: WSL2 Ubuntu 24.04, Bun 1.3.14, Node 24.14.1, Claude Code 2.1.288, claude.ai login (Max, personal org, so no channel policy gate).

### Sources read

- Channels reference and overview: https://code.claude.com/docs/en/channels-reference, https://code.claude.com/docs/en/channels
- Hooks: https://code.claude.com/docs/en/hooks
- Remote Control: https://code.claude.com/docs/en/remote-control
- fakechat source: `claude-plugins-official/external_plugins/fakechat/server.ts`
- Even Hub `asr` template and `@evenrealities/even_hub_sdk` 0.0.10 type definitions

### Confirmed from docs and code

**Channels**

- Capabilities match CLAUDE.md: `experimental['claude/channel']`, `experimental['claude/channel/permission']`, `tools`.
- Permission IDs are 5 letters from `[a-km-z]`. A wrong ID is dropped silently. The terminal dialog stays open, and the first answer wins.
- Only tool approvals are relayed. Project trust and MCP consent dialogs are not, so the first launch in a new repo needs the keyboard.
- Since v2.1.234, `input_preview` has recognizable credentials replaced with `[REDACTED]`. It is still untrusted text.
- Permission relay is only offered to servers named in `--channels` or `--dangerously-load-development-channels`.
- Launch: `claude --dangerously-load-development-channels server:g2`. The server must also be in `.mcp.json` or `~/.claude.json`. Both flags are hidden from `--help`.
- Channel events that arrive while Claude is busy queue and are delivered together on the next turn. This confirms that stop must go through a hook. Permission verdicts are handled by Claude Code itself, not queued for Claude.
- Possible trap: a server that negotiates MCP revision 2026-07-28 is not registered as a channel on the v2 MCP client runtime. That negotiation is the default from v2.1.285 when flags are fetched. If the startup banner does not show the channel, relaunch with `MCP_PROTOCOL_NEGOTIATION=legacy`. The probe's SDK (1.32.0) answered `2025-06-18` in the smoke test.

**Hooks**

- A `type: "http"` hook exists. It POSTs the hook JSON and treats a 2xx JSON body as normal hook output. Non-2xx responses and connection failures are non-blocking, so it fails open.
  - **Decision:** use http hooks pointing at the channel instead of curl scripts.
  - This collapses `POST /hook` and `GET /stop` into one call: PreToolUse gets `{"continue": false, ...}` straight from `/hook` when the stop flag is set.
  - **Consequence:** the URL lives in settings.json, so the channel needs a **fixed port** (proposed default 8790, overridable) rather than a random port written to `~/.g2cc/port`. This needs a CLAUDE.md update.
- `timeout` is in seconds. A timed-out PreToolUse hook does not block. Use `"timeout": 2`.
- Stop hook input includes `last_assistant_message`. The docs warn that the transcript may not contain the final message yet at Stop time.
  - **Decision:** use `last_assistant_message` and only fall back to `transcript_path`. This needs a CLAUDE.md update.
- PostToolUse `tool_response` for Bash is `{stdout, stderr, interrupted, isImage}`. There is no exit code field, so the summary must say "ok/interrupted" plus the first stderr line, not an exit code.
- UserPromptSubmit and Stop take no matcher. The Notification matcher works on `notification_type`.
- PreToolUse deny uses `hookSpecificOutput.permissionDecision: "deny"` plus `permissionDecisionReason`. The reason is shown to Claude.

**Remote Control**

- `claude --remote-control [name]` (alias `--rc`) or `/rc` inside a session. It requires claude.ai auth, which we have.
- The docs do not say whether RC and development channels can share a session. Tested below.

**Glasses (Even Hub SDK 0.0.10)**

- **No built-in speech recognition.** The mic gives raw PCM s16le 16 kHz mono, and the `asr` template leaves `startSttStream()` as a stub.
  - We must pick a third-party STT provider. It needs a `network` whitelist entry in `app.json` and an API key in the app.
  - **Open decision for the user** (see below).
- **Input events** are `CLICK`, `DOUBLE_CLICK`, `SCROLL_TOP`, `SCROLL_BOTTOM`, plus lifecycle and IMU events. **There is no long press.**
  - CLAUDE.md's "long press = push-to-talk" is not possible.
  - The template binds double tap to `shutDownPageContainer(1)`, the system exit dialog.
  - The gesture map must be redesigned. Proposal: on the feed, tap = talk. On cards, tap = confirm the highlighted option and scroll = move the highlight. Double tap = back, and exit only from the feed.
- The display is 576x288. The template uses a single full-screen text container with 120 ms debounced `textContainerUpgrade`, because BLE writes are slow.
- The **Linux simulator needs WebKitGTK**: `libwebkit2gtk-4.1-0` and `libsoup-3.0-0`. These are not installed and sudo needs a password. See the to-do list.

### Spike artifacts

- `spike/channel-probe/server.ts`: a probe channel registered as `g2`.
  - Logs every hook, permission request and tool call to `~/.g2cc/spike.jsonl`.
  - Has HTTP controls on `127.0.0.1:8790`: `/say`, `/stop`, `/unstop`, `/verdict`, `/log`.
  - Smoke tested over stdio. Initialize, tools/list, the channel notification, the permission relay round trip, the stop hook response and the AskUserQuestion deny all work.
- `spike/make-sandbox.sh`: builds `~/g2cc-sandbox` with `.mcp.json` and http hooks for all five events.

### Live checks (need an interactive session)

| # | Question | How | Result |
|---|---|---|---|
| 1 | fakechat works | `claude --channels plugin:fakechat@claude-plugins-official`, chat at localhost:8787 | **Pass** (user confirmed the UI loads) |
| 2 | Probe registers as a dev channel | handshake logged from claude-code 2.1.288 | **Pass**, no `MCP_PROTOCOL_NEGOTIATION` override needed |
| 3 | `/say` starts a turn | `curl localhost:8790/say` | **Pass**: the idle session started a turn in under 0.1 s |
| 4 | UserPromptSubmit fires for channel messages | log after #3 | **Pass**: `prompt` is the full `<channel source="g2" source_kind="probe">...</channel>` wrapper |
| 5 | PreToolUse halts Claude | `/stop` after the first of 5 tool calls | **Pass with both fields.** `continue:false` alone lets the pending tool run and then ends the turn. `continue:false` plus `hookSpecificOutput.permissionDecision: "deny"` blocks the pending tool (no PostToolUse) and ends the turn. **Decision: send both.** The Stop hook does not fire after a halt. |
| 6 | Permission relay round trip | default mode (`permission_mode: "default"`), `touch perm-test-1.txt`, `/verdict allow` | **Pass**: `permission_request` arrived 0.6 s after PreToolUse with `{request_id:"wokkv", tool_name, description, input_preview}` (input_preview is JSON text). The terminal dialog closed, the tool ran, and the file was created. No Notification hook fired for the prompt within the test window |
| 7 | RC coexists with the dev channel | `claude --dangerously-load-development-channels server:g2 --rc` | **Pass**: the session shows in the Claude mobile app, and the channel and hooks work at the same time |
| 8 | Who wins when RC, terminal and channel answer one prompt | Allow on the phone, then a late channel `deny` for the same `request_id` | **First answer wins.** The phone Allow ran the tool. The later channel deny was ignored silently. **The channel is never told that a request was settled elsewhere.** The signal is the PostToolUse for that call, plus a `Notification` hook with `notification_type: "permission_prompt"` about 6 s after the request |
| 9 | Stop hook `last_assistant_message` present | log | **Pass**: full final text present |
| 10 | ASR template runs in the simulator | `evenhub-simulator --automation-port 9898` plus a glasses screenshot | **Pass**: renders "Listening...". The stub STT error is expected. Mesa EGL warnings under WSLg are harmless |

### Other live findings

- Claude called `mcp__g2__glance` unprompted at the end of the turn, as the `instructions` asked. It first ran `ToolSearch`, because MCP tools are deferred, which adds about 3 s.
- Bash `tool_response` also has `noOutputExpected`. There is no exit code, as expected.
- **A fixed port allows only one channel session at a time.** A second `--dangerously-load-development-channels server:g2` session in the same repo started its probe, which then died on the port bind. The real channel must survive this: keep MCP running, skip HTTP, and log the error.
- `permission_mode` arrives in every hook payload. The sandbox session runs in `auto`, so #6 needs manual mode.

### Multi-session findings

- The channel process gets `CLAUDE_CODE_SESSION_ID` in its environment, and it matches the `session_id` in every hook payload. It also gets `CLAUDE_PROJECT_DIR`. This makes multi-session routing possible without a daemon:
  - The first channel to start binds 27183 and becomes the **hook router**.
  - Every channel connects to the relay on its own, tagged with its session ID.
  - The router answers hooks for all sessions, keeping a stop flag per `session_id`, and forwards feed events to the right channel.
  - When the router's session exits, another channel takes over the port.
  - The glasses show a session picker.
- Scope: only sessions launched with the g2 channel (`cc-g2`) are reachable. Ordinary Remote Control sessions are only reachable through Anthropic's RC relay, which is off limits. Channels load at launch, so an existing session has to be resumed with `cc-g2 --resume`.

### STT findings

- **Even does not expose ASR to Even Hub apps** (SDK 0.0.10, the official skills, and the community list https://github.com/pangoleen/awesome-even-realities-g2).
- **Native side door:** Even App -> Conversate -> **Custom AI Agent** takes an OpenAI-compatible `/v1/chat/completions` endpoint and a bearer token. "Hey Even, ..." is transcribed by Even's own STT, and the text is POSTed there (used by https://github.com/wmoto-ai/cc-g2 "Voice Entry").
  - Free and native, but it runs outside our Even Hub app, so there is no confirm screen.
  - The endpoint would be our Worker, which would then see the prompt text in plaintext. Mitigation: the Worker seals it immediately to the channel's public key (`crypto_box_seal`) and never stores or logs it.
  - Not yet verified on this account or app version.
- Machine: i7-13700K (24 threads), **RTX 3090 Ti, 24 GB**, and `nvidia-smi` works inside WSL. Local Whisper on the GPU should transcribe a short utterance in well under a second.
- Prior art: g2-channels (Groq Whisper, needs a hub daemon), cc-g2 (Groq/Soniox/OpenAI, needs a hub plus Tailscale), claude-code-g2 (OpenAI Whisper). None fit all our constraints as is.

### Design consequences

- **Stop response** = `{"continue": false, "stopReason": "Stopped from glasses", "hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "Stopped from glasses"}}`.
- **Stale permission cards:** dismiss a card when a PostToolUse arrives for its tool, or when the turn ends.
  - `permission_request` carries no `tool_use_id`. Correlate it with the most recent PreToolUse of the same `tool_name` whose `tool_input` matches `input_preview`.
  - Also send the glasses a `permission_resolved` envelope, so a phone or terminal answer clears the card.
- The glasses must also accept prompts typed on the phone (RC) or in the terminal. These arrive as UserPromptSubmit without the `<channel source="g2">` wrapper.

### Phase 0 status: **done** (2026-10-02). All 10 live checks pass.

### Open decisions

1. ~~STT provider~~: **decided, Groq Whisper API, free tier** (user preference: fastest free option).
   - The glasses app records PCM while capture is open, wraps it as WAV on release, and POSTs it to `https://api.groq.com/openai/v1/audio/transcriptions`.
   - This is batch, so there is no live interim text. The transcript appears shortly after release, then the user confirms Send.
   - CORS preflight from a webview origin returns `access-control-allow-origin: *`, so the call can go directly from the WebView.
   - Add `https://api.groq.com` to the `network` whitelist in `app.json`.
   - The key is baked into the bundle via `VITE_STT_API_KEY`. That is acceptable for a personal sideload; never publish the `.ehpk`.
   - Keep `stt.ts` behind the template's `SttClient` interface so another provider can be swapped in.
   - Free-tier rate limits apply, so show a clear error on 429.
2. ~~Fixed port~~: **decided, 27183**, overridable with `G2CC_PORT`. It is free on Linux and Windows, not in /etc/services, and below both ephemeral ranges (Linux 32768+, Windows 49152+).
3. ~~Gestures~~: **decided**. The defaults are in CLAUDE.md, and the map is user-configurable from the companion UI.
