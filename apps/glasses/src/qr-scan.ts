// Scan QR (phone view): reads the pairing QR that /g2:pair show puts in the
// conversation, from a photo taken with the phone camera.

import jsQR from 'jsqr'
import { normalizePairCode } from '@g2cc/protocol'

/** The code inside a scanned QR ("G2CC:ABCD-EFGH", or a bare code), formatted "ABCD-EFGH". */
export function pairCodeFromQrText(text: string): string | null {
  const code = normalizePairCode(text.trim().replace(/^G2CC:/i, ''))
  return code ? `${code.slice(0, 4)}-${code.slice(4)}` : null
}

const MAX_SIDE = 1280

/**
 * Finds a QR in a photo and returns its text, or null. Tries both colourings:
 * a terminal in dark mode shows the QR light on dark.
 */
export async function readQrFromPhoto(base64: string, mimeType: string): Promise<string | null> {
  const img = new Image()
  img.src = `data:${mimeType};base64,${base64}`
  await img.decode()
  const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight))
  const w = Math.max(1, Math.round(img.naturalWidth * scale))
  const h = Math.max(1, Math.round(img.naturalHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(img, 0, 0, w, h)
  const found = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'attemptBoth' })
  return found?.data ?? null
}
