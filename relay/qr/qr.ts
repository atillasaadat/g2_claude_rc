// The pairing QR page (/g2-claude/qr/#G2CC:XXXX-XXXX&exp=<unix seconds>).
// /g2:pair show links here so the phone camera gets a real QR image, not one
// drawn with text characters, which viewers space out into stripes that will
// not scan. The code travels in the #fragment, which browsers never send to a
// server. `exp` is when the code closes; the page counts down to it and then
// takes the QR away. Links without it just show the QR.

import QRCode from 'qrcode'

const CODE = /^G2CC:[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/
/** A shown code lives 3 minutes; anything much further out is not a real expiry. */
const MAX_AHEAD_MS = 15 * 60 * 1000

const [rawCode = '', ...params] = decodeURIComponent(location.hash.slice(1)).split('&')
const text = rawCode.toUpperCase()
const expSeconds = Number(new URLSearchParams(params.join('&')).get('exp'))
const expiresAt = Number.isFinite(expSeconds) && expSeconds > 0 ? expSeconds * 1000 : null

const canvas = document.getElementById('qr') as HTMLCanvasElement
const label = document.getElementById('code') as HTMLElement
const timer = document.getElementById('timer') as HTMLElement
const note = document.getElementById('note') as HTMLElement

function gone(message: string): void {
  canvas.hidden = true
  label.textContent = ''
  timer.textContent = ''
  note.textContent = message
}

function tick(deadline: number): void {
  const left = deadline - Date.now()
  if (left <= 0) {
    gone('This code has expired. Run /g2:pair show in Claude Code for a new one.')
    return
  }
  const s = Math.ceil(left / 1000)
  timer.textContent = `Expires in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  timer.classList.toggle('soon', s <= 30)
  setTimeout(() => tick(deadline), left % 1000 || 1000)
}

if (!CODE.test(text)) {
  gone('No pairing code in this link. Run /g2:pair show in Claude Code for a new one.')
} else {
  label.textContent = text.slice(5)
  void QRCode.toCanvas(canvas, text, { errorCorrectionLevel: 'M', margin: 4, width: 320, color: { dark: '#000000', light: '#ffffff' } })
  if (expiresAt !== null && expiresAt - Date.now() < MAX_AHEAD_MS) tick(expiresAt)
}
// Keep the code out of the browser history once it is on screen.
history.replaceState(null, '', location.pathname)
