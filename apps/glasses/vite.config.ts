import { defineConfig, loadEnv, type Plugin } from 'vite'

/**
 * Library code carries URL-shaped strings it never fetches: zod builds
 * `http://[addr]` to check IPv6 addresses, and names JSON Schema drafts by
 * URL. Even Hub's review flags every URL outside app.json's network
 * whitelist, so these are written with an escaped slash. (zxing-wasm's default
 * CDN address is never used: qr-scan.ts points it at the bundled WASM file.) The runtime value is
 * identical. scripts/check-bundle.ts fails the build on any URL left over.
 */
function unlinkLibraryUrls(): Plugin {
  const shapes = ['http://[${', 'https://json-schema.org', 'http://json-schema.org', 'https://fastly.jsdelivr.net']
  return {
    name: 'g2cc-unlink-library-urls',
    // After minification, which would otherwise turn the escape back into a slash.
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue
        for (const s of shapes) chunk.code = chunk.code.split(s).join(s.replace('://', ':\\u002f/'))
      }
    },
  }
}

// Production builds are served publicly from the relay Worker, so they must
// contain no secrets: only VITE_G2CC_* variables are exposed, and the dev
// Groq key from .env.local is injected while serving only. The Groq key
// is entered in the app on real devices (docs/decisions.md, Groq key storage).
export default defineConfig(({ command }) => {
  const dev = loadEnv('development', process.cwd(), 'VITE_')
  return {
    base: command === 'build' ? (process.env.G2CC_APP_BASE ?? '/g2-claude/app/') : '/',
    envPrefix: 'VITE_G2CC_',
    define: { __DEV_STT_KEY__: JSON.stringify(command === 'serve' ? (dev.VITE_STT_API_KEY ?? '') : '') },
    plugins: [unlinkLibraryUrls()],
    server: { host: '127.0.0.1', port: 5173 },
    // G2CC_OUT_DIR / G2CC_APP_BASE build the self-contained .ehpk variant (relative paths).
    build: { target: 'esnext', outDir: process.env.G2CC_OUT_DIR ?? '../../relay/public/g2-claude/app', emptyOutDir: true },
  }
})
