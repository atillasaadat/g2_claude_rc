# G2 Claude Code

Hands-free Claude Code on Even Realities G2 glasses. See what a Claude Code session is doing, speak prompts into it, stop it, approve tool use, answer Claude's questions, and switch between sessions, all from the glasses.

Setup guide: **https://atillasaadat.com/g2-claude/**

## How it works

```
Claude Code session ── hooks + MCP ──▶ g2 channel (Bun, spawned by Claude Code)
                                              │ one outbound WSS, end-to-end encrypted
                                              ▼
              relay: Cloudflare Worker + Durable Object (atillasaadat.com/g2-claude)
                                              ▲
                                              │
                    glasses app (Even Hub) in the Even app ── Bluetooth ──▶ G2
```

- **No inbound ports, no VPN, no daemon.** The only local process is the channel, which Claude Code starts over stdio. Its hook server binds `127.0.0.1` only.
- **No claude.ai credentials outside Claude Code.** Everything uses official extension points: a channel (`notifications/claude/channel`, permission relay), http hooks, and MCP tools (`ask`, `glance`). Remote Control keeps working alongside.
- **End-to-end encryption.**
  - AES-256-GCM with a 32-byte key made at pairing time. Each frame is bound to its room and direction.
  - The relay forwards ciphertext only.
  - The channel drops anything that fails decryption, schema checks, or replay checks (duplicate IDs, older than 60 s, or sent before the channel started) before Claude Code sees it.
- **Several sessions.** Each channel serves its own hooks on a private port. Whichever channel holds the fixed port 27183 routes hooks to the right session, and another takes over when it exits.

## Repository

| Path | What it is |
|---|---|
| `channel/` | The g2 channel (`server.ts`), pairing (`pair.ts`), and a CLI glasses stand-in (`tools/feed.ts`) |
| `apps/glasses/` | The Even Hub app (Vite + TypeScript + Even Hub SDK) |
| `relay/` | Cloudflare Worker + Durable Object relay. Also serves the setup page and the built app |
| `packages/protocol/` | Shared envelope schemas (zod), crypto, replay guard, pairing, relay client |
| `scripts/` | `install.sh` (global setup), `make-sandbox.sh` (throwaway test repo) |
| `docs/decisions.md` | Every design decision and what was verified, phase by phase |

## Set up

Requirements: Claude Code signed in with a claude.ai account, [Bun](https://bun.sh), `jq`, Even Realities G2 with the Even app, and optionally a free [Groq API key](https://console.groq.com/keys) for voice.

```bash
git clone https://github.com/atillasaadat/g2_claude_rc && cd g2_claude_rc
scripts/install.sh                     # user-scope MCP server + http hooks (backs up settings; --remove undoes)
echo "alias cc-g2='claude --dangerously-load-development-channels server:g2 --rc'" >> ~/.zshrc
GROQ_API_KEY=gsk_... bun channel/pair.ts --relay wss://atillasaadat.com/g2-claude
```

Scan the printed QR code in the Even app (Even Hub). It loads the app and pairs it in one step. The QR contains your secret key and Groq key, so don't share it. `bun channel/pair.ts --rotate` issues a new key.

Then run `cc-g2` instead of `claude` in any project.

**Alerts while you are in another app:** in `/config`, enable `inputNeededNotifEnabled` and `agentPushNotifEnabled` (Remote Control push notifications). Allow notifications for the Claude app on your phone, then enable the Claude app in the Even app's notification mirroring.

## Using it

| Gesture | Action |
|---|---|
| Swipe up / down | Scroll the timeline 3 lines (the R1 ring works the same) |
| Tap | Menu: Talk, Stop Claude, Exit app. On a card: confirm |
| Double tap | Jump to the newest line. On a card: leave it for later |
| OS side menu | Switch sessions, or clear other sessions |

**Voice:**
- Choose Talk from the menu. The words fill in as you speak; tap to finish, then tap to send, or double tap to cancel.
- Spoken keywords are handled on the glasses and never sent: **stop**, **cancel**, and **approve** / **deny** (the last two only while a card is showing).

**Approvals:** permission cards start on Deny, and taps within 0.5 s of a card appearing are ignored. Gestures can be remapped in the phone view.

## Develop

```bash
bun install
bun test                                   # in packages/protocol, channel, relay, apps/glasses
cd relay && bunx wrangler dev              # local relay on ws://127.0.0.1:8789
cd apps/glasses && bun run dev             # Vite on :5173
cd apps/glasses && bun run simulate        # Even Hub simulator, automation API on :9898
G2CC_SIM=1 bun test test/sim.e2e.test.ts   # simulator end to end (opens a window)
scripts/make-sandbox.sh                    # throwaway repo wired to the channel
```

For development, put a Groq key in `apps/glasses/.env.local` (`VITE_STT_API_KEY=...`). The dev server uses it, and production builds never include it: `bun run build` fails if anything secret-shaped lands in the bundle.

## Deploy

Every push to `main` that touches the app, relay, or protocol deploys automatically (`.github/workflows/deploy.yml`). It needs the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

The Even app loads the glasses app from `https://atillasaadat.com/g2-claude/app/` every time, and that entry page is served with `Cache-Control: no-cache`, so the glasses get each deploy on their next launch. The channel on your computer updates with `git pull`.

Manual deploy:

```bash
cd apps/glasses && bun run build           # writes relay/public/g2-claude/app/
cd relay && bunx wrangler deploy           # Worker route atillasaadat.com/g2-claude*
```

The Worker serves `/g2-claude/` (the setup guide), `/g2-claude/app/` (the glasses app), and `/g2-claude/v1/room/<id>` (the relay). Rate limits apply to WebSocket connects per IP, to frames per socket, and to the history size.

## Limits

- Channels are a Claude Code research preview and need `--dangerously-load-development-channels`.
- Stop takes effect at Claude's next tool call.
- Permission cards appear only when Claude Code asks for permission. In auto mode it doesn't ask.
- The glasses can only draw while the app is open. Alerts from other apps rely on phone notification mirroring.
