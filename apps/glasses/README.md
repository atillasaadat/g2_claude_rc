# G2 Claude Code: glasses app

Even Hub app for the G2 glasses. It shows a live feed of a Claude Code session, the final reply, permission cards, and a menu to stop Claude. See the repo `CLAUDE.md` and `docs/decisions.md` for the design.

## Run in the simulator

```bash
bun install                      # from the repo root
cd relay && bunx wrangler dev    # local relay on ws://127.0.0.1:8789
cd apps/glasses && bun run dev   # Vite on http://127.0.0.1:5173
bun run simulate                 # Even Hub simulator, automation API on 9898
```

Pair by pasting the output of `bun channel/pair.ts` into the Pairing section of the companion UI. For development you can also open the app with `#pair=<base64url of the pairing text>`.

## Tests

```bash
bun test                         # unit tests (layout, reducer, render, gestures, cards)
bun run test:sim                 # real app in the simulator against wrangler dev
```

## Layout

| File | Purpose |
|---|---|
| `src/main.ts` | Entry: wires the bridge, display, storage, relay link, and input. |
| `src/state.ts` | Pure reducer: feed, reply, menu, permission cards. |
| `src/render.ts` | Pure renderer: state to the text of the two containers. |
| `src/layout.ts` | Geometry and pixel-accurate fitting with `@evenrealities/pretext`. |
| `src/gestures.ts` | Configurable (screen, gesture) to action map with validation. |
| `src/display.ts` | Creates the containers once, then upgrades them in place. |
| `src/bridge-queue.ts` | Serializes every bridge call with a timeout. |
| `src/link.ts` | Encrypted relay connection (`@g2cc/protocol`). |
| `src/storage.ts` | Pairing and gesture map in SDK local storage. |
| `src/ui.ts` | Companion phone UI: status, mirror, pairing, gesture editor. |
| `src/asr/stt.ts` | Speech to text stub, wired to Groq Whisper in Phase 6. |
