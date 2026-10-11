#!/usr/bin/env bun
// @bun

// channel/version-check.ts
import { readFileSync as readFileSync2 } from "fs";
import { homedir } from "os";
import { join as join2 } from "path";

// channel/src/version-check.ts
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
var LATEST_URL = "https://raw.githubusercontent.com/atillasaadat/g2_claude_rc/main/plugin/.claude-plugin/plugin.json";
var CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
var FETCH_TIMEOUT_MS = 2000;
var VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
var CACHE_FILE = "latest-version.json";
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
function readCache(home) {
  try {
    const c = JSON.parse(readFileSync(join(home, CACHE_FILE), "utf8"));
    return typeof c.checkedAt === "number" && typeof c.latest === "string" && VERSION.test(c.latest) ? { checkedAt: c.checkedAt, latest: c.latest } : null;
  } catch {
    return null;
  }
}
async function latestVersion(o) {
  const cached = readCache(o.home);
  if (cached && o.now - cached.checkedAt < CHECK_EVERY_MS)
    return cached.latest;
  try {
    const res = await o.fetch(LATEST_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok)
      return null;
    const latest = (await res.json()).version;
    if (typeof latest !== "string" || !VERSION.test(latest))
      return null;
    try {
      mkdirSync(o.home, { recursive: true, mode: 448 });
      writeFileSync(join(o.home, CACHE_FILE), JSON.stringify({ checkedAt: o.now, latest }), { mode: 384 });
    } catch {}
    return latest;
  } catch {
    return null;
  }
}
async function updateNotice(o) {
  if (o.disabled)
    return "";
  const latest = await latestVersion(o);
  if (!latest || !isNewer(latest, o.installed))
    return "";
  return `g2 plugin ${latest} is out (this session runs ${o.installed}). ` + "Run /plugin marketplace update g2cc, then /reload-plugins. " + "To get updates on their own: /plugin, Marketplaces, g2cc, turn on auto-update.";
}

// channel/version-check.ts
try {
  const manifest = JSON.parse(readFileSync2(join2(import.meta.dir, "..", ".claude-plugin", "plugin.json"), "utf8"));
  const notice = typeof manifest.version === "string" ? await updateNotice({
    installed: manifest.version,
    home: process.env.G2CC_HOME ?? join2(homedir(), ".g2cc"),
    now: Date.now(),
    fetch: (url, init) => fetch(url, init),
    disabled: Boolean(process.env.G2CC_NO_UPDATE_CHECK)
  }) : "";
  if (notice)
    process.stdout.write(JSON.stringify({ systemMessage: notice }));
} catch {}
process.exit(0);
