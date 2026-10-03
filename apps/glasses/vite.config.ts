import { defineConfig, loadEnv } from 'vite'

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
    server: { host: '127.0.0.1', port: 5173 },
    // G2CC_OUT_DIR / G2CC_APP_BASE build the self-contained .ehpk variant (relative paths).
    build: { target: 'esnext', outDir: process.env.G2CC_OUT_DIR ?? '../../relay/public/g2-claude/app', emptyOutDir: true },
  }
})
