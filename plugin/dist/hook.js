#!/usr/bin/env bun
// @bun

// channel/hook.ts
import { homedir } from "os";
import { join as join2 } from "path";

// channel/src/hook-socket.ts
import { chmodSync, lstatSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
var SAFE_SID = /^[A-Za-z0-9-]{1,64}$/;
var MAX_BODY_BYTES = 5 * 1024 * 1024;
var uid = () => process.getuid?.();
function isPrivateDir(path) {
  try {
    const st = lstatSync(path);
    const me = uid();
    return st.isDirectory() && !st.isSymbolicLink() && (me === undefined || st.uid === me) && (st.mode & 63) === 0;
  } catch {
    return false;
  }
}
function socketPath(home, sid) {
  if (!SAFE_SID.test(sid))
    throw new Error("unsafe session id");
  return join(home, "sessions", `${sid}.sock`);
}
async function forwardHook(input, home, timeoutMs = 1500) {
  try {
    if (input.length > MAX_BODY_BYTES)
      return "";
    const sid = JSON.parse(input).session_id;
    if (typeof sid !== "string" || !SAFE_SID.test(sid))
      return "";
    if (!isPrivateDir(home) || !isPrivateDir(join(home, "sessions")))
      return "";
    const path = socketPath(home, sid);
    const st = lstatSync(path);
    if (!st.isSocket() || uid() !== undefined && st.uid !== uid())
      return "";
    const res = await fetch("http://g2/hook", {
      unix: path,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: input,
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok)
      return "";
    const text = (await res.text()).trim();
    return text.startsWith("{") && text.endsWith("}") && text !== "{}" ? text : "";
  } catch {
    return "";
  }
}

// channel/hook.ts
var home = process.env.G2CC_HOME ?? join2(homedir(), ".g2cc");
var out = await forwardHook(await Bun.stdin.text(), home);
if (out)
  process.stdout.write(out);
process.exit(0);
