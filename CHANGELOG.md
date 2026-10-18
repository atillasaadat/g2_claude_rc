# Changelog

Every release has a git tag and a GitHub Release with the full commit list. App versions (`app-vX.Y.Z`) need an Even Hub upload. Plugin versions (`plugin-vX.Y.Z`) reach users through `/plugin marketplace update g2cc`.

Add the entry here before running `scripts/release.sh`, which refuses a version without one.

## App 0.4.15
- Messages from your computers are handled in the order they arrive. Before, a short message could overtake a long one while both were being decrypted, so a session could show as idle before its reply was in, or a tool's result could arrive before its start.

## Plugin 0.4.11
- Commands from the glasses are handled in the order they arrive (the same fix as app 0.4.15, in the shared relay client).

## App 0.4.14
- Scrolling up is quicker. The glasses always show new text from its top line, so every swipe up past the top of what they hold needs new text from the phone. That step now sends one screen instead of a whole block (about a quarter of the text), and a swipe redraws at once, without the 100 ms render delay. Half a second after you stop, the rest of the block is preloaded from the same top line, so nothing moves and reading back down scrolls on the glasses again.

## App 0.4.13
- The guide says approvals and questions can also be answered in the terminal or the web view, and that the card on the glasses then clears (with plugin 0.4.10).

## Plugin 0.4.10
- Answer from anywhere: Claude's questions (the `ask` tool) wait for the first answer from the terminal, the web or phone view, or the glasses, however long that takes. Before, after 30 minutes the dialog stayed open in the terminal and web view but its answer was lost.
- The question dialog also takes an answer in your own words, as AskUserQuestion's "Other" does.
- An open question is cleared from the glasses when you type or say a new prompt instead of answering it.
- An approval card on the glasses now clears when you answer No in the terminal or the web view, when the call fails, or when you interrupt the turn there. Before, it stayed until the next prompt, and the glasses kept showing the session as working.
- Needs one `/reload-plugins` (or a new session) for the new failure hook; the rest arrives with the automatic update.

## App 0.4.12
- Glances (the `»` line Claude sends at the end of a turn) and notes wrap onto the next lines instead of being cut off at the screen edge.
- Replies keep their shape: list and numbered items wrap with a hanging indent, code keeps its indent, and tables show as one item per row with each value labelled by its column. Nested quotes, strikethrough, images, escaped characters and `<br>` are cleaned up too.

## App 0.4.11
- The tap menu's End session is now **Close session**: it takes only the session on screen off the glasses, with its cards and questions. Other sessions and every computer's pairing stay. Before, it unpaired the phone from every computer. Reconnect in the phone view brings a closed session back; Forget all there still unpairs everything.

## Plugin 0.4.9
- `/g2:pair` always shows the code and a link to its QR code in the conversation, so it works the same in the terminal, the Claude app and Claude Code on the web. The terminal dialog (with its Accept and Decline buttons) and the `show` argument are gone. A code works once, for 3 minutes.

## App 0.4.10
- The pairing help matches the new `/g2:pair`: run it anywhere, then type the code or scan its QR.

## App 0.4.9
- Every long reply opens at its first line, so you read it from the start and swipe down to the end. Before, only the first reply did: after it, later replies stayed off screen until a double tap jumped to their last lines. A reply still leaves the text alone if you scrolled during that turn.

## Plugin 0.4.8
- Sessions update themselves. When a newer g2 release is out, one session per computer installs it with Claude Code's own installer (`claude plugin update g2@g2cc`), and every running session switches to it once it is idle, with no `/reload-plugins`. The glasses keep the session and its history. `G2CC_NO_AUTO_UPDATE=1` turns it off. Sessions already running an older version need one last `/reload-plugins` (or a new session) to get this.

## App 0.4.8
- Opening the app shows each session's earlier activity, so you can scroll back through it without sending a new prompt. Needs plugin 0.4.7.
- A reconnect no longer repeats lines on the timeline.

## Plugin 0.4.7
- Each session sends its recent activity (up to 160 items) whenever the phone connects, so a phone that opens later sees what happened before. It is kept in `~/.g2cc/sessions/<session>.history.json` (owner-only) so it survives `/reload-plugins`; files of sessions unused for a week are deleted.

## App 0.4.7
- Scrolling the timeline is smooth. Once you scroll back, the glasses get a block of older lines and scroll through it themselves, one line per swipe with a scroll bar, without waiting on the phone. A long reply arrives whole and scrolls the same way. Swiping up past the top of the block loads the lines above it, and swiping down past its end goes on toward the newest lines. While you read, new activity does not move the text; double tap jumps back to live.

## App 0.4.6
- Voice prompts no longer get lost on a weak phone connection. The computer now confirms each prompt, and the header shows "→ Sent". Until then the prompt is resent every few seconds, and each resend checks the connection and reopens it if it died silently. If it still cannot get through within 50 s, it comes back as "Not delivered. Send again?", and one tap sends it again. A resend is never run twice. Returning the app to the foreground also checks the connection.
- The tap menu is a native list, so the glasses scroll it themselves: moving the highlight no longer waits on Bluetooth.

## Plugin 0.4.6
- Confirms every command from the glasses (an ack), so the app can resend a prompt that got lost and tell you when one could not be delivered. A resend of a prompt the session already has is confirmed again but never sent to Claude twice.

## App 0.4.5
- The phone pairs with several computers at once. Pairing another computer adds it instead of replacing the first, and sessions from every paired computer show together on the glasses, in the side menu and in the phone view (up to 8 computers). Pairing lists your computers with their status, each with Forget; Forget all and End session still unpair everything. An existing pairing carries over.

## Plugin 0.4.5
- A new session tells you when a newer g2 plugin is out, and how to update or turn on auto-update. It reads the released version number from GitHub at most every 6 hours; `G2CC_NO_UPDATE_CHECK=1` turns it off.

## App 0.4.4
- The phone view has a Sessions section: every connected session with its state and folder. Show on glasses switches to it. Disconnect makes this phone stop showing it and its approvals (Claude Code keeps running, and the terminal still asks), and Reconnect brings it back.
- A connection to the relay that dies without closing (the phone sleeps, the network changes) is noticed within about a minute and reopened.

## Plugin 0.4.4
- A channel whose relay connection died without closing (a laptop slept, Wi-Fi changed) now notices within about a minute and reconnects. Before, it could sit on the dead link for many minutes, and its session disappeared from the glasses.

## App 0.4.3
- The side menu drops Exit app, which repeated the glasses' own Close. With one session the app adds nothing to that menu.
- A session that died without saying goodbye (a closed terminal, a killed process) leaves the session list as soon as its computer drops off the relay, instead of showing up twice next to its replacement.

## Plugin 0.4.3
- When another session's channel leaves the relay, every channel announces its session again, so the glasses can drop the one that is gone.
- A closed terminal (SIGHUP) now tells the glasses the session ended.

## Plugin 0.4.2
- The QR page from `/g2:pair show` counts down to when the code expires, then hides the QR.

## App 0.4.2
- Scan QR reads real photos of a screen. The old decoder (jsQR) missed them; the app now uses ZXing, bundled in the app and loaded only when you tap Scan QR.

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
