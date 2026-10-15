#!/usr/bin/env bun
// @bun

// channel/launcher.ts
import { dirname as dirname2, join as join2 } from "path";

// channel/src/launcher.ts
import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";

// channel/src/version-check.ts
var CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
var VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
function isNewer(a, b) {
  if (!VERSION.test(a) || !VERSION.test(b))
    return false;
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0;i < 3; i++)
    if (pa[i] !== pb[i])
      return pa[i] > pb[i];
  return false;
}

// channel/src/launcher.ts
var SWAP_METHOD = "g2/swap";
var REPLAY_ID = "g2-swap-initialize";
var SWAP_PROBATION_MS = 15000;
function pluginVersion(root) {
  try {
    const m = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8"));
    return m.name === "g2" && typeof m.version === "string" ? m.version : null;
  } catch {
    return null;
  }
}
function validSwapTarget(current, target) {
  if (typeof target !== "string")
    return false;
  const t = resolve(target);
  const cur = resolve(current);
  if (dirname(t) !== dirname(cur) || t === cur)
    return false;
  const [vt, vc] = [pluginVersion(t), pluginVersion(cur)];
  return vt !== null && vc !== null && isNewer(vt, vc) && existsSync(join(t, "dist", "channel.js"));
}

class Launcher {
  io;
  child;
  root;
  previousRoot = null;
  swappedAt = 0;
  initialize = null;
  initialized = null;
  fromClaude = new Set;
  fromChannel = new Set;
  held = null;
  swallowId = null;
  ending = false;
  constructor(root, io) {
    this.io = io;
    this.root = root;
    this.child = this.start(root);
  }
  fromParent(line) {
    if (!line.trim())
      return;
    const msg = parse(line);
    if (msg?.method === "initialize")
      this.initialize = msg;
    if (msg?.method === "notifications/initialized")
      this.initialized = msg;
    if (msg && msg.id != null && msg.method)
      this.fromClaude.add(key(msg.id));
    if (msg && msg.id != null && !msg.method)
      this.fromChannel.delete(key(msg.id));
    if (this.held)
      this.held.push(line);
    else
      this.child.write(line);
  }
  end(sig) {
    this.ending = true;
    if (sig)
      this.child.signal(sig);
    else
      this.child.closeInput();
  }
  start(root) {
    const child = this.io.spawn(root);
    child.onLine((line) => this.fromChild(child, line));
    child.onExit((code) => this.childExited(child, code));
    return child;
  }
  fromChild(child, line) {
    if (child !== this.child || !line.trim())
      return;
    const msg = parse(line);
    if (msg?.method === SWAP_METHOD) {
      this.swap(msg.params?.root);
      return;
    }
    if (msg && this.swallowId !== null && msg.id === this.swallowId && !msg.method) {
      this.swallowId = null;
      return;
    }
    if (msg && msg.id != null && msg.method)
      this.fromChannel.add(key(msg.id));
    if (msg && msg.id != null && !msg.method)
      this.fromClaude.delete(key(msg.id));
    this.io.out(line);
  }
  swap(target) {
    if (this.held || this.ending || !this.initialize)
      return;
    if (!validSwapTarget(this.root, target))
      return this.io.log("swap refused: not a newer g2 version beside this one");
    if (this.fromClaude.size || this.fromChannel.size)
      return this.io.log("swap deferred: requests in flight");
    this.held = [];
    this.previousRoot = this.root;
    this.root = resolve(target);
    this.child.signal("SIGUSR2");
  }
  childExited(child, code) {
    if (child !== this.child)
      return;
    if (this.ending)
      return this.io.exit(code ?? 0);
    if (this.held) {
      this.io.log(`swapping to ${this.root}`);
      this.swappedAt = this.io.now();
      this.replace();
      return;
    }
    if (this.previousRoot && this.io.now() - this.swappedAt < SWAP_PROBATION_MS) {
      this.io.log("the new channel exited at once: going back to the previous version");
      this.root = this.previousRoot;
      this.previousRoot = null;
      this.held = [];
      this.replace();
      return;
    }
    this.io.exit(code ?? 1);
  }
  replace() {
    this.child = this.start(this.root);
    if (this.initialize) {
      this.swallowId = REPLAY_ID;
      this.child.write(JSON.stringify({ ...this.initialize, id: REPLAY_ID }));
    }
    if (this.initialized)
      this.child.write(JSON.stringify(this.initialized));
    const held = this.held ?? [];
    this.held = null;
    for (const line of held)
      this.child.write(line);
    this.io.out(JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }));
  }
}
function parse(line) {
  try {
    const v = JSON.parse(line);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
var key = (id) => `${typeof id}:${id}`;

// channel/launcher.ts
var log = (msg) => {
  process.stderr.write(`g2 launcher: ${msg}
`);
};
var ownRoot = process.env.CLAUDE_PLUGIN_ROOT ?? join2(dirname2(import.meta.path), "..");
function spawnChannel(root) {
  const proc = Bun.spawn(["bun", join2(root, "dist", "channel.js")], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: root, G2CC_LAUNCHER: "1" }
  });
  const lineCbs = [];
  (async () => {
    const dec = new TextDecoder;
    let buf = "";
    for await (const chunk of proc.stdout) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf(`
`)) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        for (const cb of lineCbs)
          cb(line);
      }
    }
  })();
  return {
    write: (line) => {
      try {
        proc.stdin.write(line + `
`);
        proc.stdin.flush();
      } catch {}
    },
    onLine: (cb) => void lineCbs.push(cb),
    onExit: (cb) => void proc.exited.then((code) => cb(code)),
    signal: (sig) => proc.kill(sig),
    closeInput: () => {
      try {
        proc.stdin.end();
      } catch {
        proc.kill("SIGTERM");
      }
    }
  };
}
var launcher = new Launcher(ownRoot, {
  spawn: spawnChannel,
  out: (line) => process.stdout.write(line + `
`),
  exit: (code) => process.exit(code),
  log,
  now: Date.now
});
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"])
  process.on(sig, () => launcher.end(sig));
var dec = new TextDecoder;
var buf = "";
process.stdin.on("data", (chunk) => {
  buf += dec.decode(chunk, { stream: true });
  let i;
  while ((i = buf.indexOf(`
`)) >= 0) {
    launcher.fromParent(buf.slice(0, i));
    buf = buf.slice(i + 1);
  }
});
process.stdin.on("end", () => launcher.end());
