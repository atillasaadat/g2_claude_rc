// Fails the build if anything secret-shaped ended up in the public bundle.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const OUT = join(import.meta.dir, '..', '..', '..', 'relay', 'public', 'g2-claude', 'app')
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
console.log(`bundle clean: ${files(OUT).length} files in ${OUT}`)
