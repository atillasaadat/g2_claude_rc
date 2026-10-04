# G2 Claude Code

Hands-free Claude Code on Even Realities G2 glasses. See what a Claude Code session is doing, speak prompts into it, stop it, approve tool use, answer Claude's questions, and switch between sessions, all from the glasses.

- Website: **https://atillasaadat.com/g2-claude/**
- Releases and changelog: **https://github.com/atillasaadat/g2_claude_rc/releases** (see also [CHANGELOG.md](CHANGELOG.md))

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

- **No listening ports, no VPN, no daemon.**
  - The only local process is the channel, which Claude Code starts over stdio.
  - Hooks reach it over a private Unix socket for each session (`~/.g2cc/sessions/<session>.sock`, owner-only).
  - Before connecting, the hook checks who owns the directory and the socket, so another program cannot stand in for the channel. Any number of sessions run side by side.
- **No claude.ai credentials outside Claude Code.** Everything uses official extension points: a channel (`notifications/claude/channel`, permission relay), command hooks, and MCP tools (`ask`, `glance`, `pair`). Remote Control keeps working alongside.
- **End-to-end encryption.**
  - AES-256-GCM with a 32-byte key made at pairing time. Each frame is bound to its room and direction.
  - The relay forwards ciphertext only, and only admits sockets that prove they hold the key.
  - The channel drops anything that fails decryption, schema checks, or replay checks (duplicate IDs, older than 60 s, or older than its last accepted command) before Claude Code sees it.

## Set up

You need:
- Claude Code signed in with a claude.ai account
- [Bun](https://bun.sh); `/g2:setup` can install it for you
- Even Realities G2 with the Even app
- optionally, a free [Groq API key](https://console.groq.com/keys) for voice

No clone needed.

1. **Install the plugin.** In Claude Code:
   ```
   /plugin marketplace add atillasaadat/g2_claude_rc
   /plugin install g2@g2cc
   ```
2. **Check Bun.** Run `/g2:setup`. It confirms Bun is installed, or installs it with Bun's official installer after you approve the command.
3. **Add the launch command** to `~/.zshrc` or `~/.bashrc`, then open a new terminal:
   ```bash
   alias cc-g2='claude --dangerously-load-development-channels plugin:g2@g2cc'
   ```
   The flag is required because channels are a Claude Code research preview and g2 is not on Anthropic's allowlist. The first launch shows a warning; choose that you are using it for local development. Add `--rc` if you also want Remote Control (the Claude phone app). The glasses do not need it.
4. **Install the glasses app:** G2 Claude Code from Even Hub in the Even app. Until the listing is live, see [Private build](#private-build-before-the-even-hub-listing).
5. **Pair.** In a `cc-g2` session, run `/g2:pair`. A dialog shows a one-time code and stays open until the phone has paired. In the app's phone view, type the code under Pairing; it pairs as soon as all 8 characters are in. A code works once, for 10 minutes.
6. **Voice:** paste your Groq key in the app under Voice. The app shows it masked with a fingerprint, checks it with Groq, and keeps it on the phone.

Then run `cc-g2` instead of `claude` in any project.

Without the flag (plain `claude`), the plugin still sends the feed and Stop still works. Voice prompts, approvals, and answers to Claude's questions need the channel, so they do not work.

**Alerts while you are in another app:** in `/config`, enable `inputNeededNotifEnabled` and `agentPushNotifEnabled` (Remote Control push notifications). Allow notifications for the Claude app on your phone, then enable the Claude app in the Even app's notification mirroring.

**Updates:** run `/plugin marketplace update g2cc` and restart the session, or turn on auto-update for the marketplace under `/plugin`. The plugin pins a version, so only a release reaches users, not every commit.

**Coming from the old `scripts/install.sh` setup?** Run `scripts/install.sh --remove` (from a clone) to drop its http hooks on port 27183, or they fire alongside the plugin. Existing pairings keep working.

### Private build (before the Even Hub listing)

1. Download `g2-claude-X.Y.Z.ehpk` from the [latest app release](https://github.com/atillasaadat/g2_claude_rc/releases).
2. Upload it in your project's **Private builds** tab at hub.evenrealities.com.
3. In the Even app, open Even Hub (Developer Mode), then Me, Apps, Private builds, and Install.

### How pairing works

`/g2:pair` asks the channel for a one-time code and shows it in a Claude Code dialog (MCP elicitation). The code never enters Claude's context, where a prompt injection could leak it.

The first 3 characters pick a rendezvous room on the relay. The last 5 are the password for CPace, a PAKE over ristretto255 (@noble/curves):
- The messages give nothing to test guesses against offline.
- The channel closes the code after 3 wrong attempts.
- The pairing travels sealed under the PAKE key.

For self-hosting, `bun channel/pair.ts --text` prints the pairing text to paste instead. Or enter your relay's address in the app and pair by code.

The relay admits a socket to a room only with the room's auth token (an HMAC of the room ID under the pairing key). Knowing a room ID is not enough to join, evict, or flood it.

## Using it

| Gesture | Action |
|---|---|
| Swipe up / down | Scroll the timeline 3 lines (the R1 ring works the same) |
| Tap | Menu: Talk, Stop Claude, Display off, End session. On a card: confirm |
| Double tap | Jump to the newest line. On a card: leave it for later. In the menu: back |
| OS side menu | Switch sessions, clear other sessions, or Exit app |

- **Display off** blanks the glasses until something needs you. Any gesture wakes them, and that first gesture does nothing else.
- **Display sleep** (phone view, Display): keep the display always on (the default), or let it turn off after 5 s to 5 min while Claude works. It wakes for a reply, the end of a turn, an approval card, a question, or an alert from another session. It then stays on until you turn it off or start a new prompt.
- **End session** unpairs this phone, after a confirm that starts on Cancel. Every session leaves the glasses, and `/g2:pair` reconnects.
- **Voice:**
  - Choose Talk. The words fill in as you speak; tap to finish. Review the prompt (swipe to scroll a long one), then tap to send or double tap to cancel.
  - Spoken keywords are handled on the glasses and never sent: **stop**, **cancel**, and **approve** / **deny** (the last two only while a card is showing).
- **Approvals:** permission cards start on Deny, and taps within 0.5 s of a card appearing are ignored.
- **Gestures** can be remapped in the phone view.

## Repository

| Path | What it is |
|---|---|
| `plugin/` | The Claude Code plugin: MCP server and hook script (bundled channel in `dist/`), hooks, `/g2:pair` and `/g2:setup` |
| `.claude-plugin/` | The `g2cc` plugin marketplace |
| `channel/` | The g2 channel source (`server.ts`, `hook.ts`), terminal pairing (`pair.ts`), and a CLI glasses stand-in (`tools/feed.ts`) |
| `apps/glasses/` | The Even Hub app (Vite + TypeScript + Even Hub SDK); `scripts/store-screenshots.ts` makes the listing screenshots |
| `relay/` | Cloudflare Worker + Durable Object relay. Also serves the landing page and the hosted app |
| `packages/protocol/` | Shared envelope schemas (zod), crypto, replay guard, pairing (CPace), relay client and URLs |
| `scripts/` | `release.sh` (cut a release), `make-sandbox.sh` (throwaway test repo), `install.sh` (removes the old pre-plugin setup) |
| `docs/` | `decisions.md` (every design decision and what was verified), `even-hub-listing.md` (store copy) |

## Develop

```bash
bun install
(cd packages/protocol && bun test)
(cd channel && bun test)                   # includes end to end tests through wrangler dev
(cd relay && bun test)                     # relay end to end through wrangler dev
(cd apps/glasses && bun test --path-ignore-patterns 'test/sim.e2e.test.ts')
(cd apps/glasses && G2CC_SIM=1 bun test test/sim.e2e.test.ts)   # simulator end to end (opens a window)
bun run build:plugin                       # after channel or protocol changes; commit plugin/dist
claude plugin validate . && claude plugin validate ./plugin

bun channel/tools/smoke-prod.ts           # check the live site and relay
scripts/smoke-plugin.sh                    # fresh plugin install from the public marketplace

cd relay && bunx wrangler dev              # local relay on ws://127.0.0.1:8789
cd apps/glasses && bun run dev             # Vite on :5173
cd apps/glasses && bun run simulate        # Even Hub simulator, automation API on :9898
scripts/make-sandbox.sh                    # throwaway repo wired to the channel source (server:g2)
```

For development, put a Groq key in `apps/glasses/.env.local` (`VITE_STT_API_KEY=...`). The dev server uses it, and builds never include it: `bun run build` and `bun run pack:bundled` fail if anything secret-shaped lands in the bundle.

**Keep the docs current.** A change that users see updates this README, the website (`relay/public/g2-claude/index.html`) and the in-app guide (`apps/glasses/src/guide.ts`) in the same commit. A test checks that all three show the same launch command and install steps.

## Releases

Every version is a git tag with a GitHub Release:

- `app-vX.Y.Z`: the glasses app. The version is in `apps/glasses/app.json`. The release has `g2-claude-X.Y.Z.ehpk`, to upload to Even Hub, plus its SHA-256.
- `plugin-vX.Y.Z`: the Claude Code plugin. The version is in `plugin/.claude-plugin/plugin.json`. Users get it with `/plugin marketplace update g2cc`.

To cut one, add an entry to [CHANGELOG.md](CHANGELOG.md), commit, then run `scripts/release.sh app 0.3.7` or `scripts/release.sh plugin 0.3.4` on a clean `main`. The script sets the version, runs the checks, commits `release: <kind> vX.Y.Z`, tags and pushes. For the app, it also leaves `build/g2-claude-X.Y.Z.ehpk` (byte-identical to the one on the GitHub Release) and `build/g2-claude-X.Y.Z-notes.txt` (the changelog entry as plain text, for Even Hub's release notes) ready to upload. `bun scripts/changelog.ts app X.Y.Z` prints those notes for any version.

`.github/workflows/release.yml` then checks that the tag matches the file, builds, and publishes the release. The notes list the commits since the previous tag of the same kind. Feature commits leave the version numbers alone.

## CI and deploy

| Workflow | When | What |
|---|---|---|
| `deploy.yml` | Push to `main` (app, relay, protocol, channel) | Unit tests, app build and secret scan, `.ehpk` packs, then deploys the Worker |
| `plugin.yml` | Push and pull requests (channel, protocol, plugin) | Channel tests; the committed plugin bundle matches the source |
| `release.yml` | `app-v*` and `plugin-v*` tags | Version check, build, GitHub Release |
| `nightly.yml` | Daily at 09:17 UTC, and on demand | Every test suite, including the relay and channel end-to-end tests; the simulator under Xvfb; the live site and relay (`channel/tools/smoke-prod.ts`); a fresh plugin install with the latest Claude Code (`scripts/smoke-plugin.sh`). GitHub emails you when it fails |

All workflows pin action SHAs, install without dependency scripts, and get a read-only token. The exception is `release.yml`, which may write releases.

Deploys need the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Without them the deploy step is skipped. To deploy by hand:

```bash
cd apps/glasses && bun run build           # writes relay/public/g2-claude/app/
cd relay && bunx wrangler deploy           # routes atillasaadat.com/g2-claude and /g2-claude/*
```

The Worker serves:
- `/g2-claude/`: the landing page
- `/g2-claude/app/`: the hosted app, used by the launcher build and the browser
- `/g2-claude/v1/room/<id>`: key rooms
- `/g2-claude/v1/pair/<id>`: pairing rooms

Connects are rate limited per IP (IPv6 per /64), and frames per socket and per room. A store-installed app is self-contained and changes only with an Even Hub release.

## Limits

- Channels are a Claude Code research preview and need `--dangerously-load-development-channels`.
- Stop takes effect at Claude's next tool call.
- Permission cards appear only when Claude Code asks for permission. In auto mode it doesn't ask.
- The glasses can only draw while the app is open. Alerts from other apps rely on phone notification mirroring.
- Tested on Linux. The hook socket is Unix-only, so Windows is untested.
