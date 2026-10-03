# Even Hub listing

Copy for the public Even Hub submission. The display name must match `apps/glasses/app.json` (`name`, at most 20 characters, no "Even").

## Name

G2 Claude Code

## Tagline

Claude Code on your glasses: watch, talk, approve, stop.

## Description

Follow a Claude Code session on your computer from your G2, without looking at a screen.

- **Watch:** prompts, tool calls, and Claude's replies scroll by as one live timeline.
- **Talk:** speak a prompt into the session. You see the words as you say them and confirm before anything is sent.
- **Approve:** when Claude asks to run a command or edit a file, approve or deny it with a tap. Cards start on Deny, so a stray tap never approves anything.
- **Answer:** Claude's questions appear as a short list you pick from.
- **Stop:** halt Claude at its next step, by tap or by saying "stop".
- **Switch:** run several sessions and move between them from the side menu.

Works with the R1 ring, and every gesture can be remapped in the phone view.

**What you need**
- Claude Code on your computer, signed in with a Claude account, plus Bun.
- The free G2 Claude Code plugin for Claude Code. The app's phone view walks you through it: install the plugin, run /g2:pair, and type the code into the app.
- For voice, a free Groq API key, entered in the app and stored on your phone only.

**Private by design**
Everything between your computer and your glasses is end-to-end encrypted with a key only your computer and your phone hold. The relay in between only passes ciphertext. Nothing on your computer listens to the internet, and your Claude account never leaves Claude Code.

Open source, the app and the Claude Code plugin alike: https://github.com/atillasaadat/g2_claude_rc

G2 Claude Code is an independent project. It is not made by or affiliated with Anthropic. Claude and Claude Code are trademarks of Anthropic.

## Release notes (0.3.2)

First public release. Pair with a one-time code from the Claude Code plugin, then watch, talk to, approve, and stop Claude Code from your glasses.

## Permissions (as declared in app.json)

- **Glasses microphone:** records voice prompts only while you choose Talk. Audio goes to Groq for transcription with your own key and is not stored by this app.
- **Network:** the encrypted relay at atillasaadat.com, and api.groq.com for transcription and for checking that the saved key works.

## Still needed before submitting

- A privacy policy page that covers both permissions and names the relay domain (atillasaadat.com) and Groq.
- A monochrome icon. Screenshots: `bun scripts/store-screenshots.ts` in apps/glasses writes them to build/store-screenshots/.
