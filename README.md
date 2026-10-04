# G2 Claude Code

Hands-free Claude Code on Even Realities G2 glasses. See what a Claude Code session is doing, speak prompts into it, stop it, approve tool use, answer Claude's questions, and switch between sessions, all from the glasses.

Website: **https://atillasaadat.com/g2-claude/**

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
- **No claude.ai credentials outside Claude Code.** Everything uses official extension points: a channel (`notifications/claude/channel`, permission relay), command hooks, and MCP tools (`ask`, `glance`). Remote Control keeps working alongside.
- **End-to-end encryption.**
  - AES-256-GCM with a 32-byte key made at pairing time. Each frame is bound to its room and direction.
  - The relay forwards ciphertext only.
  - The channel drops anything that fails decryption, schema checks, or replay checks (duplicate IDs, older than 60 s, or sent before the channel started) before Claude Code sees it.
- **No listening ports.** Each channel serves its own session's hooks on a private Unix socket (`~/.g2cc/sessions/<session>.sock`, owner-only). The hook checks the directory and socket owner before connecting, so another program cannot stand in for the channel. Any number of sessions run side by side.

## Repository

| Path | What it is |
|---|---|
| `plugin/` | The Claude Code plugin: MCP server (bundled channel in `dist/`), hooks, and `/g2:pair` |
| `.claude-plugin/` | The `g2cc` plugin marketplace |
| `channel/` | The g2 channel source (`server.ts`), terminal pairing (`pair.ts`), and a CLI glasses stand-in (`tools/feed.ts`) |
| `apps/glasses/` | The Even Hub app (Vite + TypeScript + Even Hub SDK) |
| `relay/` | Cloudflare Worker + Durable Object relay. Also serves the setup page and the built app |
| `packages/protocol/` | Shared envelope schemas (zod), crypto, replay guard, pairing, relay client |
| `scripts/` | `make-sandbox.sh` (throwaway test repo), `install.sh` (developer setup from a clone) |
| `docs/decisions.md` | Every design decision and what was verified, phase by phase |

## Set up

Requirements: Claude Code signed in with a claude.ai account, [Bun](https://bun.sh), Even Realities G2 with the Even app, and optionally a free [Groq API key](https://console.groq.com/keys) for voice. No clone needed.

1. **Install the plugin.** In Claude Code:
   ```
   /plugin marketplace add atillasaadat/g2_claude_rc
   /plugin install g2@g2cc
   ```
2. **Add the launch command** to your shell profile, then open a new terminal:
   ```bash
   alias cc-g2='claude --dangerously-load-development-channels plugin:g2@g2cc --rc'
   ```
3. **Install the glasses app** from Even Hub in the Even app (G2 Claude Code).
4. **Pair.** In a `cc-g2` session, run `/g2:pair`. Type the code it shows in the app's phone view under Pairing. A code works once, for 10 minutes.
5. **Voice:** paste your Groq key in the app under Voice. It stays on the phone.

Then run `cc-g2` instead of `claude` in any project.

**Alerts while you are in another app:** in `/config`, enable `inputNeededNotifEnabled` and `agentPushNotifEnabled` (Remote Control push notifications). Allow notifications for the Claude app on your phone, then enable the Claude app in the Even app's notification mirroring.

**Updates:** run `/plugin marketplace update g2cc`, or turn on auto-update for the marketplace under `/plugin`. The plugin pins a version, so only a release (a version bump in `plugin/.claude-plugin/plugin.json`) reaches users, not every commit.

**Bun is required on every computer that runs the plugin.** Without it the g2 server cannot start. The plugin says so when a session starts, and `/g2:setup` installs Bun with its official installer (you approve the command).

**Coming from the old `scripts/install.sh` setup?** Run `scripts/install.sh --remove` (from a clone) to drop its http hooks, or they fire alongside the plugin. Existing pairings keep working.

### How pairing works

`/g2:pair` asks the channel for a one-time code and shows it in a Claude Code dialog, so it never enters Claude's context, where a prompt injection could leak it. The first 3 characters pick a rendezvous room on the relay. The last 5 are the password for CPace, a PAKE over ristretto255 (@noble/curves): the messages give nothing to test guesses against offline, the channel closes the code after 3 wrong attempts, and the pairing travels sealed under the PAKE key. For self-hosting, `bun channel/pair.ts --text` prints the pairing text to paste instead, or enter your relay's address in the app and pair by code.

The relay admits a socket to a room only with the room's auth token (an HMAC of the room ID under the pairing key), so knowing a room ID is not enough to join, evict, or flood it.

### Before the Even Hub listing (private build)

Until the app is listed, install it as a private build: run `cd apps/glasses && bun run pack`, upload `build/g2-claude-bundled.ehpk` in your project's **Private builds** tab at hub.evenrealities.com, then in the Even app open Even Hub (Developer Mode), Me, Apps, Private builds, and Install. CI attaches the packages to every run.

## Using it

| Gesture | Action |
|---|---|
| Swipe up / down | Scroll the timeline 3 lines (the R1 ring works the same) |
| Tap | Menu: Talk, Stop Claude, End session (unpairs this phone, after a confirm). On a card: confirm |
| Double tap | Jump to the newest line. On a card: leave it for later |
| OS side menu | Switch sessions, clear other sessions, or Exit app |

**Voice:**
- Choose Talk from the menu. The words fill in as you speak; tap to finish, then tap to send, or double tap to cancel.
- Spoken keywords are handled on the glasses and never sent: **stop**, **cancel**, and **approve** / **deny** (the last two only while a card is showing).

**Approvals:** permission cards start on Deny, and taps within 0.5 s of a card appearing are ignored. Gestures can be remapped in the phone view.

## Develop

```bash
bun install
bun run build:plugin                       # after channel or protocol changes; commit plugin/dist
bun test                                   # in packages/protocol, channel, relay, apps/glasses
cd relay && bunx wrangler dev              # local relay on ws://127.0.0.1:8789
cd apps/glasses && bun run dev             # Vite on :5173
cd apps/glasses && bun run simulate        # Even Hub simulator, automation API on :9898
G2CC_SIM=1 bun test test/sim.e2e.test.ts   # simulator end to end (opens a window)
scripts/make-sandbox.sh                    # throwaway repo wired to the channel source
claude plugin validate . && claude plugin validate ./plugin
```

For development, put a Groq key in `apps/glasses/.env.local` (`VITE_STT_API_KEY=...`). The dev server uses it, and production builds never include it: `bun run build` fails if anything secret-shaped lands in the bundle.

## Releases

Every version is a git tag with a GitHub Release:

- `app-vX.Y.Z`: the glasses app. The version is in `apps/glasses/app.json`. The release has the `g2-claude-X.Y.Z.ehpk` to upload to Even Hub, plus its SHA-256.
- `plugin-vX.Y.Z`: the Claude Code plugin. The version is in `plugin/.claude-plugin/plugin.json`. Users get it with `/plugin marketplace update g2cc`.

To cut one, run `scripts/release.sh app 0.3.6` or `scripts/release.sh plugin 0.3.4` on a clean `main`. It sets the version, runs the checks, commits `release: <kind> vX.Y.Z`, tags and pushes. `.github/workflows/release.yml` then checks that the tag matches the file, builds, and publishes the release, with notes listing the commits since the previous tag of the same kind. Feature commits leave the version numbers alone.

## Deploy

Every push to `main` that touches the app, relay, or protocol deploys automatically (`.github/workflows/deploy.yml`). It needs the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

The Even app loads the glasses app from `https://atillasaadat.com/g2-claude/app/` every time, and that entry page is served with `Cache-Control: no-cache`, so the hosted app gets each deploy on its next launch. A store-installed app is self-contained and updates with each Even Hub release. The plugin updates through `/plugin`.

Manual deploy:

```bash
cd apps/glasses && bun run build           # writes relay/public/g2-claude/app/
cd relay && bunx wrangler deploy           # Worker route atillasaadat.com/g2-claude*
```

The Worker serves `/g2-claude/` (the landing page), `/g2-claude/app/` (the glasses app), and `/g2-claude/v1/room/<id>` (the relay). Rate limits apply to WebSocket connects per IP, to frames per socket, and to the history size.

## Limits

- Channels are a Claude Code research preview and need `--dangerously-load-development-channels`.
- Stop takes effect at Claude's next tool call.
- Permission cards appear only when Claude Code asks for permission. In auto mode it doesn't ask.
- The glasses can only draw while the app is open. Alerts from other apps rely on phone notification mirroring.
