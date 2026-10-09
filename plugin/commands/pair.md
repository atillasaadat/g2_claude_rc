---
description: Pair the G2 Claude Code phone app with this computer. Add "show" to see the code in the Claude app or web viewer too.
argument-hint: "[show]"
---

Arguments: $ARGUMENTS

Call the g2 `pair` tool.

- **Without "show" in the arguments:** call it with no arguments. It shows a one-time code in a private Claude Code dialog that stays up until the phone has paired, then closes. The code never appears in this conversation, so do not ask for it. When the tool returns, tell the user its result in one line. If it says this session cannot show a dialog (for example in the Claude app or the web viewer), tell the user to run `/g2:pair show` instead.
- **With "show" in the arguments:** call it with `show: true`. It returns a code and a link to a page with its QR code. Reply with the code on its own line, then the link on its own line, then one line: type the code in the G2 Claude Code app under Pairing, or open the link on a screen and tap Scan QR in the app; it works once, for 3 minutes. Do not draw a QR code yourself, and do not send the code anywhere else or use it for anything else.
