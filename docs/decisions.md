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

### Auto mode

Glasses work in auto mode. Hooks, stop, voice prompts, `ask` and `glance` are all independent of the permission mode. Probe tests 1 and 2 ran with `permission_mode: "auto"`, and the feed and the stop halt worked.

The difference is that auto mode opens no permission dialogs, so the channel gets no `permission_request` and the permission card never appears. The feed header should show the mode, which comes from `permission_mode` in every hook payload, so the user knows whether approvals will reach the glasses.

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

## Phase 1: protocol + relay (2026-10-03)

### Protocol (`packages/protocol`)

- **Crypto: WebCrypto AES-256-GCM**, not libsodium. There are no dependencies, and the same code runs in Bun and in the phone WebView.
  - Frame = `[version 1B][nonce 12B][ciphertext+tag]`, with a random nonce per frame.
  - The additional data is `g2cc/v1/<roomId>/<dir>`, so the relay cannot move a frame to another room or reflect it back to its sender. Both are tested.
- **Room ID** = the first 128 bits of `SHA-256("g2cc-room-v1" || key)`, as hex. It is public, and the key cannot be derived from it.
- **Direction is enforced twice:** once by the additional data, and once by kind sets (`C2G_KINDS`, `G2C_KINDS`).
- **Replay windows differ by direction.**
  - Commands to the computer: 60 s, plus duplicate-ID rejection.
  - Display data to the glasses: 24 h, because the relay replays history to late joiners. The glasses dedupe by ID.
- `SecureChannel` wraps seal and open, which do schema validation on both send and receive, the replay check, and the 64 KB cap. `open()` returns `null` on any failure, so callers cannot act on a bad frame.
- Additions to the CLAUDE.md protocol:
  - an optional `sid` (Claude Code session ID) on every envelope, for multi-session routing later
  - `mode` on `session`
  - `origin` on `event`
  - the `permission_resolved` kind
- Pairing payload = `{v, relayUrl, roomId, key(base64url)}`. `roomId` is checked against the key. The relay URL must be `wss://`, or `ws://` on localhost only.

### Relay (`relay`)

- Worker route: `GET /v1/room/<32 hex>?role=computer|glasses` as a WebSocket upgrade. One SQLite-backed DO per room via `getByName`, using hibernation and a `ping`/`pong` auto-response.
- **Buffers.** The relay cannot tell a real peer from an impostor that knows the room ID, so no socket may deprive another of frames:
  - To glasses: a history ring of the last 100 frames, also capped at 1 MB, replayed on every connect. It is pruned every 10 inserts, which keeps free-tier row writes near one per frame.
  - To computer: every command is kept until it expires (60 s, max 20) and delivered to every computer socket, live and on connect.
  - Redelivery is safe because `SecureChannel` dedupes by ID, and on the computer side it also **rejects commands stamped before the channel started** (5 s margin for phone clock lag). A restarted channel, whose replay guard is empty, therefore cannot be fed a captured command.
  - This replaces the first design (deliver once and delete), which let an impostor connect as `computer` and swallow a queued `stop`.
- **Slots:** when a role is full (8 sockets), the newcomer evicts the oldest socket with close code 4000, instead of getting a 429. Otherwise an impostor holding every slot could lock the real peer out.
- **Room TTL:** an alarm 7 days after the last connect wipes the room's storage.
- **Presence:** the relay sends a plaintext `{"t":"presence","computer":n,"glasses":n}` text frame to everyone on connect and close. This is the glasses connection indicator. It is metadata only.
- **Limits:**
  - Binary frames only; a text frame other than `ping` closes with 1003.
  - Frames over 64 KB close with 1009.
  - At most 8 sockets per role.
  - A token bucket **per socket**, 20 frames/s with a burst of 60. Excess frames are dropped, and the sender gets a `{"t":"rate_limited"}` notice at most once a second. It is in memory and resets when the DO wakes from hibernation, which is acceptable for a soft limit.
- Observability is off, so nothing is logged.
- Tests: `relay/test/relay.e2e.test.ts` starts `wrangler dev` (wrangler 4.147.0) and covers 13 cases. The three added after review are the impostor-cannot-swallow-commands case, eviction, and the byte cap. The original 10 cover:
  - routing errors
  - a two-way encrypted exchange
  - presence
  - late-join history
  - the history cap
  - deliver-once commands
  - room isolation
  - ping
  - closes on bad frames
  - the rate limit

### Security review follow-ups (deferred)

- **Stale permission cards from history replay (Phase 5):**
  - On every glasses connect, the channel sends the current pending permission and question state.
  - The glasses discard cards whose `request_id` was resolved, and permission frames older than a few minutes.
  - The channel only honors verdicts for request IDs that are currently pending. Claude Code also drops unknown IDs, so a stale Allow is harmless.
- **Per-IP rate limit in the Worker:** consider the Workers rate limiting binding when deploying (Phase 8). Room IDs are 128-bit and known only to the paired devices and the relay, which bounds the abuse.

## Phase 2: read-only channel (2026-10-03)

- **Redaction in the channel.** Hook payloads are *not* redacted by Claude Code; only permission previews are. So `channel/src/redact.ts` masks secrets in every outbound string (summaries, replies, glance) before sealing:
  - known token shapes: OpenAI/Anthropic `sk-`, Groq `gsk_`, GitHub, Slack, AWS, Google, Stripe, JWT
  - private key blocks, `Bearer` tokens, `Authorization:` header values, and credentials in URLs
  - secret-named assignments (`PASSWORD=`, `--token x`, `api_key: ...`)

  It is best effort, so summaries are also flattened to one line and clipped to 200 characters.
- **Session filter.** The channel only handles hooks whose `session_id` equals its own `CLAUDE_CODE_SESSION_ID`. Other sessions using the same settings.json are answered with `{}` and ignored. This is the base for multi-session later.
- **Hook server hardening.**
  - It binds 127.0.0.1 only.
  - It requires `Content-Type: application/json`, so a browser must send a CORS preflight, which the server never answers.
  - It requires `Host` to be `127.0.0.1:<port>` or `localhost:<port>`, which defeats DNS rebinding.
  - Bodies are capped at 5 MB.
  - Errors return non-2xx, which Claude Code treats as fail-open.
- **Port taken:** the channel logs it and keeps running. MCP and `glance` still work, but that session has no feed.
- **Session state** comes from the hook stream:
  - UserPromptSubmit, PreToolUse and PostToolUse mean `working`.
  - A Notification of type `permission_prompt` means `waiting`, and one of type `idle_prompt` means `idle`.
  - Stop means `idle`.

  A `session` envelope goes out on every change and on every relay connect. Envelopes are sealed through a promise chain, so they keep hook order.
- **Permission capability is not declared yet** (Phase 5). Read-only means inbound envelopes are decrypted and validated, then logged by kind and dropped.
- **Pairing file.** `~/.g2cc/pairing.json` is 0600 in a 0700 directory and is written atomically.
  - A corrupt file is an error, never a silent re-key.
  - `bun channel/pair.ts [--relay URL] [--rotate]` prints a QR code and the pairing text.
  - The default relay is `ws://127.0.0.1:8789` (`wrangler dev`, configured in `relay/wrangler.jsonc`) until Phase 8. Port 8787 is avoided because fakechat also uses it.
- Tools added:
  - `channel/tools/feed.ts`, a CLI glasses stand-in
  - `scripts/make-sandbox.sh`, which wires `~/g2cc-sandbox` to the real channel
- Tests:
  - 77 channel tests, 5 of them end to end: the real `server.ts` plus `wrangler dev` plus a glasses client, checking order, redaction, the session filter and glance
  - 149 tests across the repo
- **Live check (2026-10-03): pass.**
  - A real `--rc` sandbox session, running in auto mode, streamed its whole turn through the local relay to `tools/feed.ts`, in order: session header, prompt, `working · auto`, Bash start and end, glance, the full reply, `idle`.
  - Follow-up: `ToolSearch` and the channel's own `mcp__g2__*` tools are now hidden from the feed. They were noise, and glance already arrives as its own envelope.
- **Phase 2 status: done.**

## Phase 3: glasses feed (2026-10-03)

- **SDK upgrade:** even_hub_sdk 0.0.10 to **0.0.16**, simulator 0.7 to 0.9.5, CLI 0.1.14, pretext 0.1.4. `app.json` now has `min_sdk_version: 0.0.16`.
  - 0.0.16 has `zOrderIndex` but **no `setBackgroundState`**; the background-state skill is ahead of the published SDK.
  - We don't need it: when the phone backgrounds the WebView and the host reloads it headless, the relay's history replay rebuilds the feed on connect.
- **Font glyphs** were checked with pretext `getAdvW`.
  - Present: `● ○ · … ↑ ↓ ▶ × • → ━ ─ ■ □ »` (the em dash also exists, but the writing rule forbids it in UI text).
  - Missing, rendered as a 4 px blank: `► ✓ ✗ ⏸`.
- **Two containers for every screen:** a header (1 line, 576x35) and a body (9 lines, 576x253, event capture), both with padding 4.
  - Switching screens is always `textContainerUpgrade`, which is flicker-free, never `rebuildPageContainer`.
  - Only containers whose text changed are upgraded, with a 120 ms debounce.
- **Every line is measured** with pretext against a 560 px budget, which is the 568 px inner width minus an 8 px safety margin.
  - Feed lines use `pxTruncate`.
  - The reply text is word-wrapped into explicit lines (long words are hard-broken) and paginated into 9-line pages, so LVGL never rewraps.
- **All bridge calls are serialized** through `BridgeQueue` with a 4 s timeout each: render and storage share one BLE link.
- **Feed:**
  - The header is `● name · state · mode`. `●` means the computer is connected, `○` the relay only, `×` offline.
  - The body shows the last 4 events, a newer-events marker when scrolled back, the glance line, and a `↓ reply (n pages)` hint.
  - `tool_start` and `tool_end` merge into one line (`▶ Bash: x` becomes `• Bash: x → ok`).
- **Reply:** a reply newer than 60 s opens the reply view. Older ones come from history replay and are stored without taking over the screen.
- **Gestures:** a typed `(screen, gesture) -> action` map with the agreed defaults, plus a validator.
  - The feed must be able to exit.
  - Reply and card screens must be able to go back.
  - Voice must be able to send and cancel.
  - The companion UI has an editor that only offers the actions valid for each screen. Invalid stored maps fall back to the defaults.
- **Pairing:** paste the text in the companion UI, or open the app with `#pair=<base64url(pairing text)>`, which is a dev convenience. The fragment is cleared from the URL immediately. The pairing is validated before it is saved, so a bad paste never replaces a good one.
- `RelayClient` moved into `@g2cc/protocol` and is shared by the channel and the glasses app.
- **Tests:**
  - 40 unit tests (gestures, layout, reducer, render), all asserting that output fits.
  - `G2CC_SIM=1 bun test test/sim.e2e.test.ts` runs the real app in the simulator against `wrangler dev`. It asserts the exact drawn frames, lit pixels in the header and body regions, reply paging and back, and scrolling to older events. Screenshots go to `test/artifacts/`.
- **Live check (2026-10-03): pass.**
  - The simulator, paired from `~/.g2cc/pairing.json`, replayed history on connect.
  - It showed a real sandbox session live and auto-opened its 4-page reply, which the user paged through.
  - After a reload, the app reconnected from the pairing stored in local storage.
- Follow-ups from the live run:
  - **Replies are converted from Markdown to plain text** (`src/plain.ts`) before pagination. Emphasis, inline code, links, headings, rules, fences and quotes are stripped, and list markers become `•`. The same reply went from 4 pages to 3.
  - **A fresh prompt returns to the feed.** While the user was reading the previous reply, a whole new turn streamed into a feed they could not see. Replayed old prompts do not switch screens.
- **Phase 3 status: done.**

## Phase 4: stop (2026-10-03)

- **Trigger (user's choice, option a):** feed tap opens a menu with `Talk` and `Stop Claude`.
  - Talk shows "(coming soon)" until Phase 6.
  - The menu shares the **card** row of the gesture map: scroll moves the highlight, tap selects, double tap goes back. So there is no new row in the editor.
  - Stored Phase 3 maps (`feed.tap = voice.start`) remain valid.
- **Channel:** hook and stop logic moved into `SessionController` (`channel/src/controller.ts`), which is transport-free and unit-tested.
  - `stop` sets a flag **only while Claude is working or waiting**. When Claude is idle, the controller replies "Nothing to stop" and re-sends the session, so a stray stop can never block the next turn's first tool.
  - **Stop applies even while a permission prompt is open** (state `waiting`).
  - The next PreToolUse gets `continue: false` plus PreToolUse `permissionDecision: "deny"`. The flag stays up until the next UserPromptSubmit, so **every call in a parallel batch is denied**. Denied calls are not reported as `tool_start`.
  - The channel sets `state: stopped` and posts "Stopped from glasses" itself, because the Stop hook does not fire after a halt. `stopped` is sticky: idle notifications do not overwrite it. Only a new prompt does.
  - Stops addressed to another session (`sid` mismatch) are ignored.
- **Glasses:**
  - The header shows `■ stopping…` from send until a session update says `idle` or `stopped`, or a fresh prompt arrives.
  - The stop is sealed with the glasses `SecureChannel` and buffered by the relay client if offline.
  - The relay keeps commands for 60 s if the channel is briefly away.
- **Known limit:** a stop only takes effect at the next tool call. A turn that is only generating text finishes normally. Stopping a pending permission prompt by auto-denying it belongs with Phase 5.
- **Tests:**
  - 12 controller unit tests.
  - Channel end to end: a glasses `stop` over `wrangler dev` makes the next PreToolUse return the stop JSON, then a new prompt clears it.
  - Glasses: menu, stop and stopping tests.
  - Simulator: tap, down and tap send a valid `stop` to the computer side.
- **Live check (2026-10-03): pass.**
  - A real sandbox session (auto mode) was given six sequential `sleep 4; echo N` commands.
  - After `echo one` finished, the simulator menu was driven through the automation API (tap, down, tap) to choose Stop.
  - The channel posted "Stop requested" at 12:58:02. At 12:58:04 the PreToolUse for `echo two` was halted, and the session went to `stopped` with "Stopped from glasses". Commands two through six never ran.
  - The glasses header went from `■ stopping…` to `stopped · auto`.
- **Phase 4 status: done.**

## Phase 5: permission relay (2026-10-03)

- **Channel** now declares `claude/channel/permission`. `notifications/claude/channel/permission_request` goes to `SessionController.onPermissionRequest`, which validates the request (IDs must match `[a-km-z]{5}`). Malformed requests are dropped.
  - The display fields are untrusted. They are redacted and clipped: description to 300 characters, preview to 2000. They are never executed.
  - The session goes to `waiting`.
- **Verdicts** are relayed as `notifications/claude/channel/permission` **only while the request is pending**, and at most once.
  - A verdict for an unknown or already-settled ID is never relayed, but the channel answers with `permission_resolved` so the glasses drop the card.
- **Settled elsewhere** (terminal or the RC phone app; Claude Code sends no signal):
  - A PostToolUse of the same `tool_name` resolves the oldest pending request for that tool.
  - The end of the turn (Stop) or a new prompt resolves everything, which also covers denials made elsewhere.
- **Stop denies open permission prompts** first. Otherwise the dialog would block and the halt could never happen.
- **Resync:** on relay reconnect, and whenever a new glasses socket joins (presence count goes up), the channel re-sends the session and every pending request with fresh timestamps.
- **Glasses:**
  - A permission card has the highest priority and preempts any screen.
  - Requests older than 60 s are ignored, since they come from history. Duplicate IDs are ignored too, which covers resync.
  - Cards queue, and the header shows `Allow Bash? · 1/2`.
  - **The highlight starts on Deny**, and **taps within 500 ms of a card appearing are ignored**. A card can preempt the screen at the moment the user taps for something else, so an accidental tap must never approve.
  - The card uses the card gesture row: swipe up for Allow, swipe down for Deny, tap to confirm, double tap to leave it pending.
  - With a card pending, the menu gains `Review: <tool>` as its first item. Stop stays in the menu.
- **Preview rendering:** the JSON `input_preview` is shown as its fields, with `command` shown bare and the `description` key dropped when it repeats the description line. It gets up to 4 wrapped lines, and the last one is cut with `...`.
- **Tests:**
  - 9 permission controller unit tests.
  - Channel end to end: a real `permission_request` on stdin, a card at the glasses client, an Allow over `wrangler dev`, the exact `notifications/claude/channel/permission` on stdout, and a replayed verdict is not relayed twice.
  - 14 glasses card tests.
  - A simulator test: card, swipe up, tap, verdict at the computer; `permission_resolved` closes the card.
- **Live check (2026-10-03): pass.**
  - A real sandbox session in manual mode (`permission_mode: default`) was asked to run `touch perm-test-3.txt`.
  - The card `Allow Bash?` appeared in the simulator, and the simulator approved it (swipe up, tap). The terminal dialog closed, and the command ran. The feed showed `! Allowed Bash from glasses` and `• Bash: touch perm-test-3.txt → ok`, then the reply opened. The file exists.
- **Writing-rule fix:**
  - The glance prefix was an em dash; it is now `»`.
  - The em dashes in the template leftovers (`apps/glasses/README.md`, now rewritten for this app, and `src/asr/stt.ts`) were removed too.
  - The only remaining em dashes are in generated Cloudflare types (`relay/worker-configuration.d.ts`).
- **Phase 5 status: done.**

## Phase 6: voice prompts (2026-10-03)

- **Flow:**
  1. Menu → Talk. The mic opens (`AudioInputSource.Glasses`) and the screen shows `Listening…`.
  2. Tap. The screen shows `Transcribing…` while the audio goes to Groq Whisper.
  3. The screen shows `Send to Claude?` with the transcript. Tap sends; double tap cancels at any phase. **Nothing is sent without that confirming tap.**
- **STT** is Groq `whisper-large-v3-turbo`, batch, called directly from the WebView. CORS was verified in Phase 0, and `app.json` whitelists `https://api.groq.com`.
  - Settings: `language=en`, `temperature=0`, and a `prompt` listing coding vocabulary (Claude, git, Bash, npm, bun, TypeScript…).
  - The client times out after 15 s, and 401 and 429 get readable errors.
  - Recordings are capped at 60 s. Under 0.3 s counts as "didn't catch that".
  - A real API smoke test with the user's key returned in 269 ms. One second of silence came back as "Thank you.", a known Whisper hallucination, which the parser treats as empty.
- **The mic is derived state.** `micWanted(state)` is true only while the voice screen is listening, and `main.ts` syncs `audioControl` to it through the bridge queue. So anything that leaves listening turns the mic off without a separate effect, including a preempting permission card.
- **Attempts:** each recording increments `voice.attempt`. Transcripts and errors carry their attempt, so a late result from a cancelled recording is ignored.
- **Keywords** (`src/voice.ts`) are strict whole-utterance matches. Leading filler (please, ok, yes…) and trailing filler (it, that, claude, now…) are stripped first.
  - "stop" stops immediately.
  - "cancel" discards.
  - "approve", "allow", "deny" and "reject" act only while a permission card is showing. Otherwise the screen shows "No approval is waiting" and nothing is sent.
  - A sentence like "stop the dev server" stays a prompt.
  - A card that appears while a transcription is in flight can be answered by it.
- **Channel:**
  - A `prompt` envelope becomes `notifications/claude/channel` with `content` set to the transcript and `meta.source_kind` set to `voice`.
  - When Claude is busy, the glasses are told the prompt is queued for the next turn.
  - The `instructions` now say that g2 channel messages are spoken and transcribed, may contain transcription errors, and that Claude should confirm ambiguous or destructive requests.
- **Testing:**
  - A dev-only `VITE_G2CC_FAKE_STT` makes the app return a canned transcript, so the simulator test drives the whole flow: menu, Talk, listening, done, review, send, and the prompt at the computer.
  - The Linux simulator under WSL only has `alsa:null` as an input device. Live speech needs the ALSA pulse plugin pointed at WSLg's PulseAudio, or real hardware (Phase 8).
- **Known gaps:**
  - The on-screen hints ("tap: send") are fixed text and do not follow a remapped gesture map.
  - The `ask` tool for clarifications arrives in Phase 7. For now Claude confirms in its reply.
- **Simulator mic under WSL:**
  - Install `libasound2-plugins` and route ALSA to WSLg's PulseAudio with `~/.asoundrc` (`pcm.!default { type pulse }`, `ctl.!default { type pulse }`).
  - Then launch with `evenhub-simulator --aid alsa:pulse`. `--list-audio-input-devices` shows `alsa:pulse`.
- **Dev pairing note:** relaunching the simulator wipes its local storage, so the dev launch passes `#pair=` on the command line. That puts the key in the local `ps` output, which is acceptable only on a single-user dev box. Real devices pair by paste.
- **Live check (2026-10-03): pass, with real speech.**
  - In the simulator the user chose Menu → Talk, said "List the files in this repo.", then tapped twice.
  - Timeline: `Listening…` 08:19:59, `Transcribing…` 08:20:08.4, `Send to Claude?` with the exact text at 08:20:08.9 (about 0.5 s on Groq).
  - Send: the channel injected the prompt, the hooks reported it with `origin: glasses`, and Claude ran `ls -la` and replied. The reply opened on the glasses.
- **Phase 6 status: done.**

## Phase 7: ask tool (2026-10-03)

- **`ask({question, options})`** is an MCP tool on the g2 channel. It validates the input (a non-empty question and 1 to 4 non-empty options), redacts and clips it (question 500 characters, options 100), stores it under a random `question_id` (`q` plus 8 hex), and sends a `question` envelope.
  - It **returns immediately** with text telling Claude to end its turn and that the answer will arrive as a channel message carrying `question_id`. Channel events are only delivered between turns, so Claude must not wait mid-turn.
  - If the relay is offline, the result says the question will be delivered when it reconnects.
- **Answers:**
  - Only a choice that is one of the offered options is accepted, and only once.
  - It is delivered as `notifications/claude/channel`. The content is `The user answered your question "<q>": <choice>`, and `meta` holds `question_id` and `source_kind: answer`.
  - Pending questions are **not** cleared by UserPromptSubmit or Stop, because the answer itself arrives as a prompt. They are re-sent on resync.
- **AskUserQuestion redirect (refines CLAUDE.md):** PreToolUse denies AskUserQuestion with a reason pointing at `mcp__g2__ask` **only while a glasses socket is present**, according to relay presence. Without glasses, the native dialog (terminal or RC app) is the better UI, so it is left alone.
- `settings.example.json` allows `mcp__g2__ask` and `mcp__g2__glance`. The instructions tell Claude to use `ask` for decisions and for confirming ambiguous or destructive spoken requests.
- **Glasses question card:**
  - It is its own screen and queue, using the card gesture row and the 500 ms input guard.
  - The highlight starts on the first option, since no option is inherently dangerous.
  - Permission cards outrank questions. A question that arrives behind a permission card waits, and comes back when the card closes. The menu shows `Review question` while one is pending.
- **Spoken answers:** after Talk, `matchOption` maps the transcript to an option.
  - Exact text matches.
  - Positions count in short answers of 4 words or fewer ("the second one", "option 3"). "run the tests first" is not a choice.
  - Otherwise a unique containment match.
  - An ambiguous answer matches nothing and stays a prompt for review. A match only highlights the option; a tap still confirms.
- **Tests:**
  - 16 channel ask and redirect tests.
  - Channel end to end: `tools/call ask`, then a question at the glasses, an answer, and a channel notification with `meta.question_id`, plus the redirect.
  - 26 glasses question and matching tests.
  - A simulator test: question card, swipe down, tap, answer at the computer.
- **Bug found in the live check:**
  - Claude called `ask`, the question card appeared (08:36:22), and Claude ended its turn as told. Its final reply then opened the reply view **on top of the question card** (08:36:29), and the user lost the options.
  - Fix: screen priority is enforced. A fresh reply opens only from the feed or reply view, and a fresh prompt returns to the feed only from those screens. Neither ever buries a permission card, question, voice capture or the menu.
  - Recovery worked as designed: when the app reloaded, the channel's presence-triggered resync re-sent the pending question with a fresh timestamp, and the card reappeared.
- **Live check (2026-10-03): pass.**
  - Prompt: "Ask me whether to write hello or goodbye into greeting.txt, then do what I pick." Claude called `ask`, and after the reload it was re-sent at 1:38:20 (`q794c9b5f`).
  - The user picked `hello` in the simulator at 1:40:31. The answer arrived as a g2 channel message (`origin: glasses` in the feed), and Claude ran `echo hello > greeting.txt` and replied.
  - The file contains `hello`.
- **Phase 7 status: done.**

## UI redesign (2026-10-03)

The user asked for boxes, overlays, a voice box that fills in while speaking, animations, autoscroll, and one continuous scroll (with the R1 ring in mind). Choices made by the user: a header pill plus timeline, the voice box at the top, landing at the start of long replies, and subtle animations.

- **Scenes, not screens.** `render(state)` returns containers:
  - a header pill (576x34, border 1, radius 8)
  - the timeline (576x250, 9 lines, always the input capture)
  - at most one overlay box (border 2, radius 10)

  Every container sets a unique `zOrderIndex` (the all-or-nothing rule).
- **Display diffing** (`display.ts`):
  - When the layout key (ids, names, boxes, capture, z) changes, the display does one `rebuildPageContainer`, which flickers briefly on hardware. That only happens when an overlay opens, closes or resizes.
  - Otherwise it does `textContainerUpgrade` with `textColor` (brightness 0 to 4) for only the changed containers, which is flicker-free.
- **Brightness is per container**, which drives the animations:
  - The timeline dims to 1 behind overlays.
  - Overlays fade in through 2, 3, 4 over 450 ms.
  - The listening label pulses (`●` and `○`).
  - The working dots in the header cycle (`·`, `··`, `···`).

  The animation clock ticks every 250 ms **only while something animates**, so it is idle otherwise. Per-line fades are not possible without one container per line, so they were dropped.
- **No background fill:** unpainted pixels are off, so a box cannot hide the text beneath it. The first screenshots showed the timeline straight through the card. **Occlusion:** the renderer blanks the timeline rows a full-width box covers, and clips rows short of the side menu, so boxes read as solid.
- **Continuous timeline** (`timeline.ts`):
  - Prompts are wrapped, with indented continuations and `(voice)` for glasses prompts.
  - Tool start and end merge into one line.
  - Notes are `!`, glances are `»`.
  - Replies are full plain text, with blank lines around replies and before each turn.
  - At most 80 entries.
- **Scrolling** is bottom-anchored (`fromBottom`):
  - Live content sticks to the newest line.
  - A scrolled-up view stays put while new lines arrive, and the header shows `▼ n newer`.
  - A fresh reply taller than the view lands on its first line; a fresh prompt returns to live.
  - A swipe moves 3 lines. Double tap jumps to live when scrolled, otherwise it opens the exit dialog (`live.or.exit`).
  - The R1 ring sends the same events, so it works unchanged.
- **Gesture map rows** are now `timeline`, `card` and `voice`. The menu and question cards use the card row. Stored Phase 3 to 7 maps fall back to the defaults.
- **The reply view and pagination are gone**; replies live in the timeline.
- **Live transcript** (`recorder.ts`):
  - While listening, the audio so far is re-transcribed every 2.5 s, so the box fills in. The final transcription runs when the user taps done.
  - Groq's free tier is 20 requests per minute, 7,200 audio-seconds per hour and 2,000 requests per day. Partials stay at or under 14 per minute, and an error (such as a 429) stops partials for that recording, keeping the quota for the final transcription.
  - The voice box keeps a fixed 3-line size while listening, so it never rebuilds as text grows.
- **Header hints:** while an overlay is open, the header shows its gestures, for example `↑ allow · ↓ deny · tap: confirm · 2× tap: later`.
- **Phone mirror** shows the dimmed timeline with the overlay box on top, and a CSS fade-in.
- **Tests:**
  - 129 glasses unit tests: timeline, scrolling, reply landing, priority, overlays, voice partials, render fit for every container, occlusion, the recorder rate cap, and display rebuild versus upgrade.
  - 7 simulator tests, rewritten for the scene frames.

## Multi-session and notifications (2026-10-03)

**Switching sessions (user request).** All `cc-g2` sessions share one pairing key and relay room. Each channel tags its envelopes with its session ID.

- **Hook routing without a daemon** (`channel/src/router.ts`):
  - Each channel serves its own session's hooks on a private random port and registers `{sid, port, pid}` in `~/.g2cc/sessions/<sid>.json` (0700 directory, 0600 file, UUID-shaped IDs only).
  - Whichever channel binds 27183 is the router. It answers its own session locally and forwards the rest to the owning channel by `session_id`, returning that channel's response. That includes the stop halt and the AskUserQuestion redirect.
  - The other channels retry 27183 every 3 s, so one takes over when the router's session ends.
  - Unknown, stale (dead PID) or unreachable sessions get `{}`, which fails open.
- **Commands must name their session:**
  - A channel ignores stop, prompt, verdict and answer envelopes whose `sid` is not its own, including a missing `sid`.
  - The glasses send stop and prompts to the session on screen, and verdicts and answers to the session that asked.
  - This also fixes a latent bug: a non-owning channel would otherwise answer an unknown verdict with `permission_resolved` and wrongly close another session's card.
- **The session lifecycle:** a channel emits `state: 'ended'` on shutdown (a new enum value), and the glasses drop that session.
- **Glasses:**
  - Each session has its own view (timeline, scroll position, stopping, unread). The first session seen is on screen, and the menu gains `Sessions (n)` when there are two or more.
  - The session list shows each session's state and an unread `◆`. Tapping switches.
  - Permission and question cards from any session pop up, labelled `· repo-b` or `repo-b asks:` when several sessions exist.
  - An ended on-screen session hands the screen to the most recent other one.
- **In-app toasts:**
  - A fresh reply, or a "waiting for your input" note, from a session that is not on screen shows `◆ repo-b: reply ready` (or `needs your input`) in the header for 5 s.
  - The session is marked unread, and the header's right side keeps a `◆` until you switch to it.

**Notifications outside the app (user request).**

- The Even Hub SDK has no notification API. There is no toast, banner or background wake, and an app only draws while it is the active one on the glasses.
- So notifications while the user is on the dashboard or in another Even app must come from the phone. The Even app mirrors phone notifications to the G2.
- Claude Code already sends **Claude mobile app push notifications for Remote Control sessions** (https://code.claude.com/docs/en/remote-control):
  - `inputNeededNotifEnabled` sends one when a permission prompt or question waits.
  - `agentPushNotifEnabled` sends one when Claude finishes longer work.
  - Both are toggled in `/config`.
- Our code cannot trigger them. The `PushNotification` tool is callable only by Claude, not by hooks or MCP servers, and calling Anthropic's push service directly would break the no-credentials rule.
- Setup is on the user's side: enable both settings, allow Claude app notifications on the phone, and allow the Claude app in the Even app's notification settings for the G2.

**Tests:**
- Channel: 12 registry and router tests, plus a two-session end to end. It covers per-session tagging through one router, a stop aimed at B halting only B, and B taking over routing after A ends.
- Glasses: 8 session tests (separate timelines, toasts, unread, the switch list, targeted commands, labelled cards, ended sessions). All 138 unit tests and 7 simulator tests pass.
- **Follow-up from live use:**
  - "Many sessions": every sandbox restart created a new session ID, and channels built before the `ended` state never said goodbye. Relay history then replayed them as live.
    - Fix: `connectEpoch` counts relay connections. Every live channel re-announces on connect (resync), so a session is listed only if it sent something fresh during the current connection, or it is the one on screen.
    - A dead session on screen hands over to the first live one.
    - The session list ends with `Clear other sessions`, which keeps only the one on screen. Live sessions reappear with their next envelope.
  - "Didn't see the notification": toasts now last 8 s at full header brightness, with the `◆`/`◇` marker pulsing.
- **Sessions moved to the glasses OS side menu (user request).** SDK 0.0.16 lets an app register a contextual side menu: `menuObject` on create and rebuild, with up to 10 `MenuItemProperty {itemID, itemName}` items (UTF-8 labels of at most 32 bytes). Clicks arrive as `event.menuItemClickEvent.itemID`.
  - The menu is part of the page: changing it needs a rebuild, and a rebuild without `menuObject` clears it. So the display always re-sends it, and the layout key includes it.
  - Labels are session names only, with `▶` marking the one on screen and a stable name order. Live states and unread markers would force a rebuild on every change, so they stay in our own UI (header and toasts).
  - The menu is installed only with 2 or more sessions, followed by `Clear other sessions` (item 99). With one session the OS default menu stays.
  - Choosing a session switches to it and keeps any open card or question.
  - The in-app Sessions entry and overlay were removed.
- **Double tap no longer exits (user bug report).**
  - A double tap at live opened the system exit dialog (`shutDownPageContainer(1)`). In the simulator that showed as a black screen that took no further input.
  - Timeline double tap now only jumps to live, and the tap menu gains `Exit app` as its last item.
  - Gesture validation now requires the timeline to reach the menu (which always has Exit) or to exit directly.

## Phase 8 (part 1): deployed (2026-10-03)

- **One Worker** (`g2cc-relay`) on the route `atillasaadat.com/g2-claude*`. The Pages site keeps every other path; `/` and `/about` were checked after deploy.
  - It serves `/g2-claude/` (the setup guide, `relay/public/g2-claude/index.html`), `/g2-claude/app/` (the built glasses app, base path `/g2-claude/app/`), and the relay at `/g2-claude/v1/room/<id>`.
  - Static assets have `run_worker_first` for relay paths, and `_headers` sets `no-cache` on the app entry and `immutable` on hashed assets. The Even app reloads the URL, so the glasses get every deploy.
  - A per-IP limit of 30 WebSocket connects per minute (`ratelimits` binding) runs before a Durable Object wakes. Tests disable it with `--var CONNECT_LIMIT_ENABLED:false`.
- **No secrets in public assets:**
  - Vite exposes only `VITE_G2CC_*`. The dev Groq key is injected only by the dev server.
  - `apps/glasses/scripts/check-bundle.ts` fails the build on secret-shaped strings.
  - The Groq key travels in the pairing as an optional `sttKey`, or is entered in the phone view, and is stored in SDK local storage.
- **Pairing:**
  - For a `wss://` relay, `bun channel/pair.ts --relay wss://atillasaadat.com/g2-claude` prints one QR, `https://atillasaadat.com/g2-claude/app/#pair=<base64url>`, which loads and pairs in one scan. The fragment never reaches the server.
  - The guide also has a public install-only QR.
- **Setup:** `scripts/install.sh` registers the channel at user scope (`claude mcp add --scope user g2`) and merges the http hooks and permissions into `~/.claude/settings.json`. It is idempotent, makes backups, and `--remove` undoes it. Users then launch with `cc-g2` in any repo.
- **CI:** `.github/workflows/deploy.yml` tests, builds and deploys on pushes to `main`, once the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets exist. Without them the deploy step skips with a notice.
- **Verified live:**
  - The guide, the app, the QR and the 404 are served with the intended cache headers.
  - The JS asset loads from the base path and contains no secrets.
  - An encrypted round trip through `wss://atillasaadat.com/g2-claude` took 86 ms, with presence `computer=1 glasses=1`.
- **Next:** hardware. Install and pair on the real G2 over cellular, check whether a QR-loaded app persists across Even app restarts, and pack the `.ehpk`.

## Phase 8 (part 2): keeping the app installed (2026-10-03)

- **Hardware result (user):** the app works on the real G2. But a QR-loaded app is a dev or prototype load: leaving it drops prototype mode, and the QR must be scanned again.
- **No public release is needed.** Even Hub has **Private builds** (https://hub.evenrealities.com/docs/test/private-testing):
  1. Pack an `.ehpk`.
  2. Upload it in the dev portal (hub.evenrealities.com, your project, **Private builds** tab).
  3. Install it from the Even app: Even Hub (Developer Mode), then Me, Apps, Private builds.

  Private builds are tied to your account and are not reviewed. Caveats from the docs:
  - Updates need a re-upload and re-install, and the CLI has no upload command.
  - Private builds "don't pass the 5-minute lock test"; surviving a locked phone needs Beta Testing.
- **Two packages** (`apps/glasses: bun run pack`, written to `build/`; CI attaches both as the `ehpk` artifact):
  - `g2-claude-launcher.ehpk` (1 KB): `launcher/index.html` calls `location.replace('https://atillasaadat.com/g2-claude/app/')`. If the Even app lets a packaged app navigate to a whitelisted site, one install keeps auto-updating from `main`. **To be verified on hardware.**
  - `g2-claude-bundled.ehpk` (111 KB): the whole app built with relative paths (`G2CC_APP_BASE=./`). It always works, but each update needs a re-upload.
- `package_id` is now `com.atillasaadat.g2claude`, replacing the template placeholder. `min_app_version` is 2.2.10, the floor for SDK 0.0.16 that the packer stamps.
- **Pairing an installed app:** it opens without the `#pair=` fragment, so its SDK storage may start unpaired. `bun channel/pair.ts --text` prints the pairing text to paste into the phone view.
- **Groq key storage (user decision, 2026-10-03): the key lives on the phone.**
  - Rationale: if the app is ever published, users install it from Even Hub, so entering their own Groq key in the app is the natural path. The phone view's Voice field is therefore the primary way in. The pairing QR carrying `sttKey` (read by `pair.ts` from `GROQ_API_KEY` or the dev `.env.local`) is a convenience for this self-hosted setup.
  - The key is stored with the SDK's `setLocalStorage` (`g2cc.sttKey`) in the Even app's storage for this app. It is not encrypted by us, and it is never in the public bundle, on the glasses, or seen by the relay. Each user's key is their own, so there is no shared secret to protect.
  - The considered alternative was to keep the key only on the computer and route encrypted audio through the relay to the channel, which would call Groq. It was rejected because of the added latency (about 100 to 200 ms) and relay audio traffic, and because a key on the computer fits a published phone app poorly.

## Phase 9: Claude Code plugin and pairing by code (2026-10-03)

- **User decision:** setup should not need a clone, an install script, or a QR code, because the app is headed for a public Even Hub listing (no Developer Mode).
- **Plugin** (`plugin/`, marketplace `g2cc` in `.claude-plugin/marketplace.json`, install id `g2@g2cc`):
  - `.mcp.json` runs `bun ${CLAUDE_PLUGIN_ROOT}/dist/server.js`. Plugins cannot reference files outside their root or workspace packages, so the channel is bundled with `bun build --target=bun --minify` (about 650 KB) and committed. The build is deterministic; `.github/workflows/plugin.yml` fails on a stale bundle.
  - `hooks/hooks.json` holds the same five `type: "http"` hooks as `channel/settings.example.json` (a test keeps them equal). **Verified:** http hooks work from a plugin. A `claude -p` run in a scratch project with `--plugin-dir` produced `prompt`, `tool_start`, `tool_end`, `glance` and `reply` on the CLI feed.
  - No `version` in the manifest, so the version is the commit SHA and every push to `main` is an update. Third-party marketplaces do not auto-update by default: users run `/plugin marketplace update g2cc` or turn auto-update on.
  - **Names change under a plugin:** tools are `mcp__plugin_g2_g2__ask|glance|pair` (confirmed in the test run), and the channel tag source is `plugin:g2:g2`. The hook translator and the `AskUserQuestion` deny reason accept both forms, so a from-source `server:g2` setup still works.
  - **Permissions:** a plugin cannot add allow rules. The PreToolUse hook answers `permissionDecision: "allow"` for our own `ask` and `glance` (confirmed: glance ran in `-p` mode without `--allowedTools`). `pair` keeps the normal prompt.
  - Launch: `claude --dangerously-load-development-channels plugin:g2@g2cc --rc`. `--channels` alone does not work, because only `claude-plugins-official` channel plugins are on the allowlist.
  - The default relay is now the hosted one (`wss://atillasaadat.com/g2-claude`). `G2CC_RELAY_URL=ws://127.0.0.1:8789` selects a local `wrangler dev`.
  - `bin/` was considered for a `g2-pair` command. It was rejected: `!` output only appears after the command exits, so a blocking pairing command could not show its code, and `bin/` blocks claude.ai and Cowork installs.
- **Pairing by code** (`packages/protocol/src/pair-code.ts`, `channel/src/code-pairing.ts`, `apps/glasses/src/code-pair.ts`):
  - `/g2:pair` calls the channel's `pair` tool, which opens a pairing in the long-running channel and returns at once with an 8-character Crockford base32 code (40 bits) that expires in 10 minutes. `bun channel/pair.ts` does the same from a terminal and waits.
  - PBKDF2-SHA256 (200k iterations) of the code gives a one-off room ID and an HMAC key. The channel sends `hello {pk, HMAC("c|"pk)}`, the phone answers `join {pk, HMAC("g|"pkC"|"pkG)}`, the channel sends the pairing text sealed with AES-GCM under SHA-256(salt || ECDH P-256 secret), and the phone confirms with `done`. Both sides drop frames that fail their checks.
  - What this protects: the code never contains the key, and relay traffic alone reveals nothing. A passive observer who also learns the code later cannot decrypt a finished exchange. An active attacker would need the code and the relay position during the 10-minute window.
  - The code appears in the session transcript. That adds no exposure beyond what Claude's Bash tool already has, since it can read `~/.g2cc/pairing.json`.
  - It reuses the relay as is: the channel joins the code room as `computer`, so its `hello` sits in history for a phone that joins later, and the phone's `join` waits in the 60 s command buffer.
  - **Verified:** a phone stand-in typing the code got the pairing through `wrangler dev`, and `pair.ts` printed `Paired.`.
  - Pasting the pairing text (`pair.ts --text`) stays as the fallback for self-hosting. The QR (`qrcode` dependency, `appUrlFor`, the public install QR) is gone; `#pair=` stays as a dev convenience.
- **Website:** still needed. The relay and the hosted app live at that address, and the page is the plugin's `homepage` and the place to point an Even Hub listing. It is now a shorter landing page with the plugin steps.

## Phase 10: security audit and fixes (2026-10-03)

Four read-only reviews (crypto and pairing, the local channel surface, the relay, the app and supply chain) found no way for a party without the key to send prompts, verdicts, answers or stop, and no secrets in git history. The committed plugin bundle rebuilt byte for byte from source. Fixes, by finding:

- **Pairing code leaked through the model (high).** The `pair` tool returned the code to Claude, so a prompt injection could make it call `pair` and send the code out, and whoever joined first got the key. Now the code is shown with an MCP elicitation dialog that only the user sees. The tool result never contains it. Without elicitation support (for example `claude -p`) the tool refuses. **Verified:** in `-p` the dialog auto-cancels, and the model only saw "Pairing cancelled". The interactive dialog still needs a check by the user.
- **Offline-crackable code (medium) and a join race (high).** The PBKDF2 and HMAC scheme let the relay test guesses offline (40 bits, global salt), and two concurrent joins could both receive the key. Replaced with CPace over ristretto255 (`@noble/curves` 2.4, audited, no dependencies):
  - code = 3 rendezvous characters (public room) + 5 password characters (25 bits, online guessing only)
  - `MAX_ATTEMPTS = 3` wrong attempts close the code
  - frames are handled one at a time, so only the first good join wins
  - a random session id lets several computers share a rendezvous room
- **Fixed port 27183 could be squatted (high).** Any local process that bound the port first saw every hook payload and could answer "allow" for every session, even ones without a channel. Hooks are now exec-form `type: "command"` hooks (`plugin/dist/hook.js`), which talk to `~/.g2cc/sessions/<session_id>.sock`. The hook refuses a home or sessions directory that is not owned by this user or is open to others (or is a symlink), and a socket owned by anyone else. The router, the registry files and `G2CC_PORT` are gone, so every session simply has its own socket.
  - This replaces the CLAUDE.md rule "all hooks are http, no shell scripts", by the user's decision to do the audit's B items.
  - Cost: one Bun start per hook, about 20 to 40 ms.
  - A same-user process could still stand in for the channel, but it could already edit settings.json.
  - Bun unlinks a Unix socket's path when its server stops, so an old channel of the same session must not stop a socket that a newer one has re-bound (inode check).
- **Relay free-tier exhaustion and room disruption (high).**
  - The per-IP connect limit now runs before every other check and groups IPv6 by /64.
  - Key rooms pin the first `relayAuthToken(key, roomId)` they see (HMAC-SHA256, stored as SHA-256) and refuse other tokens (401 missing, 403 wrong). Knowing a room ID no longer lets anyone evict peers, flood the history, or see presence.
  - Pairing rooms (`/v1/pair/<id>`, a separate Durable Object name) stay open but keep 20 frames, refuse newcomers when full (no eviction), and are wiped 15 minutes after opening.
  - The TTL alarm moves at most once a day instead of on every connect.
  - A second token bucket per sending role per room stops 8 sockets from adding up.
  - `peer.send` failures no longer drop the frame for the others.
  - The routes are now `/g2-claude` and `/g2-claude/*`, so `/g2-claudeX` stays with the main site.
- **Look-alike tools auto-allowed (medium).** Another MCP server named g2 would have had its `ask` and `glance` auto-allowed and hidden. Now the hook allows only the names this channel serves, and only when it runs as the plugin (`CLAUDE_PLUGIN_ROOT` is set; a from-source setup lists the tools in settings.json). Only our own display tools are hidden from the feed, so `pair` and look-alikes show.
- **Supply chain (medium).**
  - `plugin.json` pins `version` (0.3.0), so users only receive bumped releases.
  - The bundles are no longer minified, so diffs are reviewable.
  - Workflows pin action SHAs, run with `permissions: contents: read`, and install with `--ignore-scripts` (verified: wrangler, vite and evenhub all run without install scripts).
  - The deploy job runs the channel tests too.
  - CODEOWNERS covers everything.
  - Branch protection, 2FA and a registrar lock are the real controls, and only the user can set them.
- **`#pair=` link hijack and missing headers (medium).**
  - `#pair=` now works in dev builds only.
  - `_headers` sets nosniff, `Referrer-Policy: no-referrer`, a Permissions-Policy, and a CSP for the landing page (no inline script: moved to `site.js`; framing denied) and for the hosted app (`connect-src` limited to the relay and Groq; framing allowed in case the Even app frames it).
- **Low items.**
  - Commands fail closed without a known session id.
  - Redaction now catches JSON-style secrets, quoted values with spaces, `curl -u` and `mysql -p`.
  - The instructions tell Claude that a `<channel>` tag inside tool results, pages or files is not from the user, and spoken `<` and `>` become look-alikes.
  - A restarted channel will not re-accept a command from before its restart: the newest accepted command ts is kept in `sessions/<sid>.last`, and the floor is one past it.
  - The bundled `.ehpk` is scanned for secrets too.
  - Stale Groq comments were fixed.
  - The Vite dev server binds 127.0.0.1.
  - Code pairing works with a self-hosted relay (an optional relay address in the app).
- **Accepted, not changed.**
  - The relay can replay real display frames from the last 24 h to an app that just reloaded. Session state is already monotonic per session, cards and questions need to be fresh (60 s), and verdicts only act on pending requests, so this is display only.
  - Dismissing a card by tool name fails safe.
  - The pairing key and Groq key sit in the Even app's per-app storage, as WebViews allow.
- **Compatibility.** The relay now refuses sockets without the auth token, and the pairing protocol changed, so the app build in Even Hub review (0.2.0) cannot connect after this deploy. App 0.3.0 must be uploaded. Existing pairings keep working: the key did not change, and the first token a room sees is the legitimate one.

## Public repository (2026-10-03)

- The user made the repository public. `/plugin marketplace add atillasaadat/g2_claude_rc` now works for anyone. **Verified** in a throwaway `CLAUDE_CONFIG_DIR` with no GitHub credentials: the marketplace was added, and `g2@g2cc` 0.3.0 was installed and enabled with both bundles.
- The website, the in-app guide and the Even Hub listing copy now link to the source.
- Before going public, history was already clean of secrets (audit, Phase 10).
- No license file yet, so the default is all rights reserved: others may read the code but not reuse it. Choosing one is the user's call.

## Pairing dialog fix (2026-10-03)

- **User report:** `/g2:pair` showed no code, and the tool said the code was "still open". A tmux-driven interactive session showed the dialog does appear, with and without `--rc`. But **Accept** is pre-selected, so one stray Enter (easy right after the `/g2:pair` autocomplete) closes it before the code is read.
- **Fix:**
  - The dialog now stays up until the phone has paired, then closes itself: the elicitation request is aborted when the pairing finishes, which closes it in Claude Code. **Verified** in tmux.
  - An early Accept shows the same code again, with "Not paired yet". **Verified** in tmux.
  - Decline or Esc cancels the code.
  - The request timeout is set to the code's remaining lifetime, because the SDK default of 60 s would cut the dialog short.
- Plugin 0.3.2.

## End session and Exit app (2026-10-03, user decision)

- The tap menu's **Exit app** became **End session**. It unpairs this phone: the pairing is forgotten, every session, card and question goes, and `/g2:pair` reconnects. The user chose this over detaching just the one session on screen.
- Unpairing is one tap from losing everything, so End session asks first ("End session: unpair?") and starts on **Cancel**, the same idea as permission cards starting on Deny.
- **Exit app** moved to the glasses' OS side menu, which now always exists. It holds the session list and Clear when there are two or more sessions, and Exit app always, paired or not. The forget button in the phone view and End session share the same unpair path.

## Release tags (2026-10-03, user request)

- Versions are tracked with git tags and GitHub Releases: `app-vX.Y.Z` for the glasses app (`app.json`) and `plugin-vX.Y.Z` for the plugin (`plugin.json`). There are two tag kinds because the two version independently: an app release needs an Even Hub upload, while a plugin release reaches users through `/plugin`.
- `scripts/release.sh` sets the version, runs the checks, commits, tags and pushes. `release.yml` checks that the tag matches the file and publishes.
  - App releases attach `g2-claude-X.Y.Z.ehpk` and `SHA256SUMS`.
  - Plugin releases re-run the channel tests and the bundle check.
  - The notes list the commits since the previous tag of the same kind.
- The workflow is the only one with `contents: write`.
- Backfilled from history: the app tags sit where `app.json` first had each version (0.1.0, 0.2.0, 0.3.0 to 0.3.5). The plugin tags 0.3.0 to 0.3.3 already existed. 0.1.0 and 0.2.0 get notes-only releases, because the release build steps postdate them.

## Nightly health check (2026-10-03, user request)

`.github/workflows/nightly.yml` runs daily (09:17 UTC) and on demand, to catch breakage nobody pushed: a Claude Code update, a Cloudflare change, a moved dependency. It has four independent jobs:
1. **Test suites:** every suite, including the relay and channel end-to-end tests through `wrangler dev`, plus the plugin-bundle and build checks.
2. **Simulator:** the end-to-end test under Xvfb. It needs `libwebkit2gtk-4.1-0` and `libsoup-3.0-0` from apt. The screenshots are kept as a run artifact.
3. **Production:** `channel/tools/smoke-prod.ts` checks the pages and their security headers, that a room refuses a missing or forged token, an encrypted round trip with the right one, and pairing by code. It uses throwaway keys and rooms.
4. **Fresh install:** `scripts/smoke-plugin.sh` installs `g2@g2cc` from the public marketplace with the latest Claude Code from npm, deliberately unpinned. It uses a fresh `CLAUDE_CONFIG_DIR` and no login, then starts the MCP server (it must answer initialize as a channel) and checks that the hook fails open.

No secrets or Anthropic credentials are involved. **Verified:** the first run passed all four jobs, and the simulator ran 7 of 7 tests on the runner.

## Voice review scrolling and display sleep (2026-10-03, user request)

- **Voice review scrolling:** swipes in the voice box now scroll the transcript under review (`voice.up` / `voice.down`, 3 lines at a time, 5 shown, with a "4-8 of 12" marker). Before, they did nothing there. Gesture maps saved before this, with both voice swipes set to `none`, are upgraded on load.
- **Display sleep:** the SDK has no screen-off or brightness call, so "off" means the app draws nothing: empty containers and no borders. The G2 lenses show only lit pixels, and the timeline container still captures input. **Verified** in the simulator: 0 lit pixels.
  - **Setting:** phone view, Display. Always on (the default), or 5 s to 5 min, stored as `g2cc.displaySleep`. It is a picker, so no keyboard is needed.
  - **Goes dark** only while the session on screen is working, with no card, question, menu or voice box up, and no gesture for the set time. The timer restarts when a new turn starts and on every gesture.
  - **Wakes** on fresh envelopes only, never history replays. The triggers are a reply or a session state change other than working for the session on screen, a permission card or a question (from any session), and a toast from another session. After waking it stays on, because the timer only runs while working.
  - **Display off** in the tap menu turns it off by hand, with or without the setting.
  - **First gesture:** on a dark display it only wakes, so a blind tap cannot open the menu or confirm a card.
  - The animation clock stops while dark.

## Questions in both places (2026-10-03, user request)

- **User report:** Claude's `ask` questions only showed on the glasses, and the terminal could not answer them.
- **Now:** `ask` sends the question card and, at the same time, opens a terminal choice dialog: an MCP elicitation with an enum field built from the options. It then waits for whichever answer comes first.
  - **Glasses first:** the dialog is aborted, which closes it, the same mechanism pairing uses. The tool returns the choice.
  - **Terminal first:** the channel sends `question_resolved` (a new c2g kind) and the app drops the card. A late glasses tap is ignored.
  - **Dismissed:** Decline or Esc in the terminal withdraws the question everywhere, and Claude is told not to assume an answer.
- Claude now gets the answer as the tool result in the same turn, instead of a channel message on the next turn. When elicitation is unavailable (`claude -p`), the call is cancelled, or 30 minutes pass, it falls back to the old behaviour: the card stays, and its answer arrives as a channel message.
- **Verified** in a tmux-driven interactive session with a glasses stand-in on the production relay:
  - Choosing "blue" in the terminal returned it to Claude, and the stand-in saw the card dismissed.
  - The stand-in answering "medium" closed the open terminal dialog and returned "medium (answered on the glasses)".
- Old app builds drop the unknown `question_resolved` kind, so their card simply stays until answered. Answering it then does nothing.

## Even Hub URL scan (2026-10-08)

- **Review notice for 0.3.8:** the bundle named URLs outside `app.json`'s `network.whitelist`, even though the app never fetches them:
  - `wss://your-relay.example`, the relay field placeholder
  - `https://bun.sh` and `https://console.groq.com/keys`, guide links
  - zod's IPv6 check, which builds `` `http://[${addr}]` `` to test an address
- **Fixes:**
  - The guide shows addresses as plain text. A link would also leave the app inside the Even WebView.
  - The placeholder no longer has a URL.
  - A Vite `generateBundle` step (after minification, which would undo it) writes the zod and JSON Schema strings with an escaped slash (`:\u002f/`), so the runtime value is unchanged.
- `scripts/check-bundle.ts` now fails the build on any URL outside the whitelist. `pack:bundled` and `build` both run it, and so do CI and releases.
- **Verified:** the built 0.3.9 bundle names only `https://api.groq.com` and `wss://atillasaadat.com`, and it starts in the simulator (`[g2cc] ready`, no errors).

## Pairing from the Claude app and web viewer (2026-10-08, user decision)

- **Problem:** the pairing dialog (MCP elicitation) only shows in the terminal. Remote Control viewers (the Claude app, claude.ai) show only the conversation.
- **User decision:** an opt-in `/g2:pair show` puts the code and a QR in the conversation, with Scan QR in the app. Plain `/g2:pair` keeps the private dialog.
- **Accepted risk:** a shown code is in the model's context, so a prompt injection could try to exfiltrate it. Mitigations:
  - it lives 3 minutes instead of 10
  - it is single use, with CPace, first good join wins
  - the session gets a channel message when a phone pairs
  - `/g2:unpair` rotates the key, and every running channel watches `pairing.json` (`watchFile`, 2 s) and reconnects under the new key, so cut-off phones lose every session at once
- **QR:** the text `G2CC:XXXX-XXXX` (alphanumeric, version 1, 21x21), rendered with `qrcode` as UTF-8 half blocks, 11 lines.
  - Claude repeats it in its reply, and copying it exactly is part of the command's instructions.
  - **Verified** in a tmux session: Claude's reply, rasterized from the captured screen, decodes with jsQR to the exact code.
- **App:** Scan QR uses `bridge.captureImageFromCamera()`, which needs the new `camera` permission. jsQR decodes with `inversionAttempts: 'attemptBoth'`, because dark terminals show the QR light on dark.

## Text QR codes do not scan (2026-10-09)

- **User report:** Scan QR said "no QR code found". The code was in the photo, and the decoder ran.
- **Cause, found by simulating photos of the half-block QR:** every terminal, app and web viewer leaves space between lines, which cuts stripes through the QR.
  - With no gap, it decodes every time.
  - With gaps of 20% of a line or more, jsQR failed in every case.
  - ZXing (`zxing-wasm`, tryHarder) read the 20% case in light mode only.
  - Neither read 50% or more.
  - A vertical morphological closing before decoding fixed up to 50%, but it is custom code, and slow on a phone.
- **Fix, user preference "no lot of custom code":** do not scan text. `/g2:pair show` links to `/g2-claude/qr/#G2CC:XXXX-XXXX`, a static page that draws a real QR with the `qrcode` package, bundled by wrangler's `build` command from `relay/qr/qr.ts`.
  - The code stays in the fragment, so no server sees it.
  - The page removes the fragment from history once the QR is drawn.
  - The page has a strict CSP.
  - **Verified:** a half-scale JPEG screenshot of the whole browser window with the page open decodes with jsQR to the code.
- The app needed no change: Scan QR reads a clean QR as it is.

## Scan QR decoder: ZXing instead of jsQR (2026-10-09)

- **User's iPhone photo of the clean QR page did not scan.** Running the same photo through both decoders:
  - jsQR read it only at a few lucky sizes: 320 and 800 px with smooth downscaling, 500 px with nearest-neighbour. It failed at 1280 px, which the app used.
  - ZXing (`zxing-wasm` 3.1.5, `tryHarder`) read it at every size.
  - The likely cause is moire from photographing a screen.
- **Switched to `zxing-wasm`:**
  - **Bundled locally.** By default it fetches its WASM from jsDelivr, which the network whitelist forbids. `locateFile` points at the bundled `zxing_reader.wasm?url` asset (967 KB; the `.ehpk` is 566 KB compressed).
  - **Loaded only on Scan QR**, through dynamic imports.
  - **Library URL escaped.** The library's default CDN address is escaped like the other library URLs, so the URL check still passes.
  - **Security headers.** The hosted app's CSP allows `'wasm-unsafe-eval'`.
- **Image loading:** the image is now decoded with `createImageBitmap`. `img.decode()` never resolved in a hidden tab.
- **Verified:** in Chrome, the app's own `readQrFromPhoto` reads the user's photo as `G2CC:49Z3-R11P` in 0.75 s, including loading the WASM.

## QR page countdown (2026-10-09)
- **User request:** show on the QR page when the code expires.
- **How:** `/g2:pair show` adds the expiry to the link's fragment, `#G2CC:XXXX-XXXX&exp=<unix seconds>`. The QR still holds only `G2CC:XXXX-XXXX`, so the app is unchanged.
- **Page:** counts down ("Expires in 2:41"), turns red in the last 30 seconds, then hides the QR and says to run `/g2:pair show` again. Links without `exp` (older plugins) show the QR with no timer. An `exp` more than 15 minutes ahead is ignored.
- **Limits:** the timer trusts the viewing device's clock. The page does not learn when the phone pairs, so the QR stays up until the timer ends; the code itself works only once either way.
- **Verified:** headless Chromium against the static page: countdown, red under 30 s, expiry hides the QR, no timer without `exp`.
