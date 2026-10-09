// Scan QR (phone view): reads the pairing QR from /g2:pair show's link page,
// from a photo taken with the phone camera.
//
// The decoder is ZXing (zxing-wasm). jsQR missed real photos of a screen
// (moire); ZXing reads them at every size (docs/decisions.md). Its WASM file
// ships inside the app and loads only when Scan QR is used: by default the
// library fetches it from a CDN, which the network whitelist does not allow.

import { normalizePairCode } from '@g2cc/protocol'

/** The code inside a scanned QR ("G2CC:ABCD-EFGH", or a bare code), formatted "ABCD-EFGH". */
export function pairCodeFromQrText(text: string): string | null {
  const code = normalizePairCode(text.trim().replace(/^G2CC:/i, ''))
  return code ? `${code.slice(0, 4)}-${code.slice(4)}` : null
}

const MAX_SIDE = 1600

/** Finds a QR in a photo and returns its text, or null. */
export async function readQrFromPhoto(base64: string, mimeType: string): Promise<string | null> {
  const [{ prepareZXingModule, readBarcodes }, { default: wasmUrl }] = await Promise.all([
    import('zxing-wasm/reader'),
    import('zxing-wasm/reader/zxing_reader.wasm?url'),
  ])
  prepareZXingModule({ overrides: { locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path) } })
  // createImageBitmap decodes directly; an <img> may never finish decoding in a hidden page.
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0))
  const img = await createImageBitmap(new Blob([bytes], { type: mimeType }))
  const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height))
  const w = Math.max(1, Math.round(img.width * scale))
  const h = Math.max(1, Math.round(img.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(img, 0, 0, w, h)
  img.close()
  const [found] = await readBarcodes(ctx.getImageData(0, 0, w, h), { formats: ['QRCode'], tryHarder: true, tryInvert: true, maxNumberOfSymbols: 1 })
  return found?.text ?? null
}
