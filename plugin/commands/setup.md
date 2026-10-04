---
description: Check that this computer can run the g2 plugin, and install Bun if it is missing
---

The g2 plugin's server and hooks run on Bun. Set this computer up:

1. Run `bun --version` with the Bash tool.
2. If it prints a version of 1.1 or newer, tell the user Bun is ready. Then tell them to restart Claude Code with `claude --dangerously-load-development-channels plugin:g2@g2cc` (if the plugin had failed to start) and run `/g2:pair`. Stop there.
3. If Bun is missing or older than 1.1, tell the user in one sentence that you are about to install Bun with its official installer from bun.sh, into their home folder. Then run the installer that fits this computer:
   - macOS or Linux: `curl -fsSL https://bun.sh/install | bash`
   - Windows (PowerShell): `powershell -c "irm bun.sh/install.ps1 | iex"`
   - If Bun is installed but old: `bun upgrade`
   Use exactly these commands and no other source.
4. Check the result with `~/.bun/bin/bun --version` (Windows: `%USERPROFILE%\.bun\bin\bun --version`).
5. Tell the user that Bun is installed, and that they need to open a new terminal (so Bun is on the PATH) and start Claude Code again with `claude --dangerously-load-development-channels plugin:g2@g2cc`. After that, `/g2:pair` pairs the phone app.

Do not change any other settings or install anything else.
