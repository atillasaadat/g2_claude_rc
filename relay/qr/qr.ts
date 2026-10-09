// The pairing QR page (/g2-claude/qr/#G2CC:XXXX-XXXX). /g2:pair show links
// here so the phone camera gets a real QR image, not one drawn with text
// characters, which viewers space out into stripes that will not scan.
// The code travels in the #fragment, which browsers never send to a server.

import QRCode from 'qrcode'

const CODE = /^G2CC:[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/

const text = decodeURIComponent(location.hash.slice(1)).toUpperCase()
const canvas = document.getElementById('qr') as HTMLCanvasElement
const label = document.getElementById('code') as HTMLElement
const note = document.getElementById('note') as HTMLElement

if (CODE.test(text)) {
  label.textContent = text.slice(5)
  void QRCode.toCanvas(canvas, text, { errorCorrectionLevel: 'M', margin: 4, width: 320, color: { dark: '#000000', light: '#ffffff' } })
} else {
  canvas.hidden = true
  label.textContent = ''
  note.textContent = 'No pairing code in this link. Run /g2:pair show in Claude Code for a new one.'
}
// Keep the code out of the browser history once it is on screen.
history.replaceState(null, '', location.pathname)
