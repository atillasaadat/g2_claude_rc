// Fails the build if anything secret-shaped ended up in the public bundle, or
// if the bundle names a URL outside app.json's network whitelist (Even Hub's
// review flags those, even when they are only string literals).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// The hosted build by default; `pack:bundled` passes the Even Hub package's directory.
const OUT = process.argv[2] ?? join(import.meta.dir, '..', '..', '..', 'relay', 'public', 'g2-claude', 'app')
const SECRET = /gsk_[A-Za-z0-9]{20,}|"key":"[A-Za-z0-9_-]{40,}"|sk-[A-Za-z0-9_-]{20,}/

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? files(p) : [p]
  })
}

const leaks = files(OUT).filter(f => SECRET.test(readFileSync(f, 'utf8')))
if (leaks.length) {
  console.error(`secret-shaped strings in the public bundle:\n${leaks.join('\n')}`)
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(join(import.meta.dir, '..', 'app.json'), 'utf8')) as {
  permissions: { name: string; whitelist?: string[] }[]
}
const allowed = manifest.permissions.flatMap(p => p.whitelist ?? [])
const URL_SHAPE = /\b(?:https?|wss?):\/\/[^\s"'`<>)\\]+/g
const strays = new Set<string>()
for (const f of files(OUT).filter(f => /\.(js|html|css)$/.test(f))) {
  for (const [url] of readFileSync(f, 'utf8').matchAll(URL_SHAPE)) {
    if (!allowed.some(origin => url === origin || url.startsWith(`${origin}/`))) strays.add(url)
  }
}
if (strays.size) {
  console.error(`URLs outside app.json's network whitelist (Even Hub flags these):\n${[...strays].join('\n')}`)
  process.exit(1)
}
console.log(`bundle clean: ${files(OUT).length} files in ${OUT}`)
