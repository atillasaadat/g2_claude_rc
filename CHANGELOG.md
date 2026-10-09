# Changelog

Every release has a git tag and a GitHub Release with the full commit list. App versions (`app-vX.Y.Z`) need an Even Hub upload. Plugin versions (`plugin-vX.Y.Z`) reach users through `/plugin marketplace update g2cc`.

Add the entry here before running `scripts/release.sh`, which refuses a version without one.

## App 0.4.1
- The setup guide explains the new pairing QR: run /g2:pair show, open its link on a screen, and tap Scan QR.

## App 0.4.0
- Scan QR in Pairing: photograph the QR code from /g2:pair show with the phone camera instead of typing the code. Needs the camera permission, used only for this.

## App 0.3.9
- The package no longer contains web addresses outside its network whitelist: setup guide links became plain text, and library strings that only look like URLs are escaped. Fixes the Even Hub review notice for 0.3.8.

## App 0.3.8
- A question answered in the terminal disappears from the glasses.

## App 0.3.7
- Reviewing a spoken prompt, swipes scroll your own transcript instead of the timeline behind it. The box shows which lines you are on.
- Display sleep (phone view, Display): always on by default, or off after 5 s to 5 min while Claude works. It wakes for a reply, the end of a turn, an approval card, a question, or an alert from another session, and stays on until you turn it off or start a new prompt.
- Display off in the tap menu. Any gesture wakes the glasses, and that first gesture does nothing else.

## App 0.3.6
- No app changes. First release cut with `scripts/release.sh`, with the `.ehpk` attached on GitHub.

## App 0.3.5
- The tap menu's **End session** unpairs this phone after a confirm that starts on Cancel. `/g2:pair` reconnects.
- **Exit app** moved to the glasses' side menu, where it is always available.

## App 0.3.4
- Fixed the phone view freezing while entering a pairing code.
- Pairing sits above the setup guide and is open until the app is paired.

## App 0.3.3
- While pairing, the app says it is looking for your computer. After 30 seconds without an answer, it names the likely causes: a stale code, a closed session, or an out-of-date plugin.
- Links to the source code, now that the repository is public.

## App 0.3.2
- Voice shows the saved Groq key masked (`gsk_…abcd`), with a fingerprint and a live check with Groq. A new key replaces the old one only if Groq accepts it, and keys can be removed.

## App 0.3.1
- The phone view works with the on-screen keyboard: a complete code pairs on its own, and Enter submits.

## App 0.3.0
- Pairing by one-time code replaces the QR code.
- Security audit fixes:
  - pairing by PAKE (CPace)
  - the relay only admits key holders
  - `#pair=` links work in dev builds only
  - security headers on the hosted pages
- An in-app setup guide that opens until the app is paired.

## App 0.2.0
- First deployed version, on atillasaadat.com/g2-claude.
- **Glasses screens:** live feed, reply view, approval cards, question cards, and a stop menu.
- **Voice prompts** through Groq Whisper.
- **Display:** redesigned UI with a continuous timeline, overlay boxes and subtle animations. Gestures can be changed in the phone view.
- **Sessions:** switch between Claude Code sessions in the side menu, with alerts from other sessions, and clear the ones you no longer use.

## App 0.1.0
- Project spike: channel probe, Even Hub template and design notes.

## Plugin 0.4.1
- /g2:pair show links to a page with a real QR image instead of drawing one with text characters, which viewers space into stripes that cameras could not read.

## Plugin 0.4.0
- /g2:pair show puts the code and a small QR code in the conversation, so you can pair from the Claude app or the web viewer. It is opt-in and lasts 3 minutes; plain /g2:pair keeps the private terminal dialog.
- The session is told when a phone pairs.
- /g2:unpair gives the computer a new key, cutting off every paired phone; running sessions switch to the new key on their own.

## Plugin 0.3.4
- Claude's questions show on the glasses and in the terminal at the same time. Answer in either; the other closes, and Claude gets the choice in the same turn instead of a later message.

## Plugin 0.3.3
- `/g2:setup` installs Bun with its official installer, after you approve the command.

## Plugin 0.3.2
- The pairing dialog stays open until the phone pairs, then closes itself. An early Accept brings the code back, and Decline or Esc cancels.

## Plugin 0.3.1
- Tells you when a session starts on a computer without Bun, instead of failing silently.

## Plugin 0.3.0
- First versioned plugin release. Install from the `g2cc` marketplace; no clone needed.
- `/g2:pair` shows the code in a dialog only you see, never in Claude's context.
- Security audit fixes:
  - hooks use a private Unix socket for each session instead of port 27183
  - auto-allow covers only the plugin's own tools
  - stronger redaction
  - the version is pinned, so updates come only with releases
