// Companion UI shown on the phone: connection status, a mirror of the glasses
// display, pairing, and the gesture map editor. Dynamic values only ever go
// through textContent, never innerHTML.

import { normalizePairCode } from '@g2cc/protocol'
import { GUIDE_CSS, GUIDE_HTML, wireGuide } from './guide'
import { dismissKeyboard, keyboardFriendly, onEnter } from './keyboard'
import { checkGroqKey, keyFingerprint, maskKey, type KeyCheck } from './asr/key-status'
import { ACTIONS, DEFAULT_GESTURES, GESTURES, SCREENS, validateGestureMap, type GestureMap } from './gestures'
import type { Frame } from './render'
import type { Link } from './state'

export interface UiCallbacks {
  savePairing(text: string): Promise<void>
  pairWithCode(code: string, relayUrl?: string): Promise<void>
  forgetPairing(): Promise<void>
  saveGestures(map: GestureMap): Promise<void>
  /** Saves (replacing any saved key) after Groq accepts it. Empty removes the key. */
  saveSttKey(key: string): Promise<KeyCheck | null>
}

const GESTURE_LABELS: Record<(typeof GESTURES)[number], string> = {
  tap: 'Tap',
  double_tap: 'Double tap',
  scroll_up: 'Swipe up',
  scroll_down: 'Swipe down',
}

let els: {
  status: HTMLDivElement
  header: HTMLDivElement
  body: HTMLPreElement
  overlay: HTMLPreElement
  guide: HTMLDetailsElement
  pairInput: HTMLTextAreaElement
  pairMsg: HTMLDivElement
  gestures: HTMLDivElement
  gestureMsg: HTMLDivElement
  sttStatus: HTMLDivElement
  sttCheck: HTMLDivElement
  sttInput: HTMLInputElement
  sttSave: HTMLButtonElement
  sttRemove: HTMLButtonElement
}
let currentMap: GestureMap = DEFAULT_GESTURES

export function mountUi(cb: UiCallbacks): void {
  const app = document.querySelector<HTMLDivElement>('#app')!
  app.innerHTML = `
    <main class="panel">
      <header>
        <h1>G2 Claude Code</h1>
        <div id="status" class="status status-offline">Offline</div>
      </header>
      <section class="mirror" aria-label="Glasses display">
        <div id="m-header" class="m-header"></div>
        <div class="m-stage">
          <pre id="m-body" class="m-body"></pre>
          <pre id="m-overlay" class="m-overlay" hidden></pre>
        </div>
      </section>
      <details id="guide">
        <summary>Setup guide</summary>
        ${GUIDE_HTML}
      </details>
      <details>
        <summary>Pairing</summary>
        <p class="hint">In Claude Code on your computer, run <code>/g2:pair</code>. Type the code it shows here.</p>
        <input id="code-input" autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false" placeholder="ABCD-EFGH" maxlength="12" />
        <p class="hint">It pairs as soon as all 8 characters are in.</p>
        <div class="row">
          <button id="code-pair">Pair</button>
          <button id="pair-forget" class="secondary">Forget</button>
        </div>
        <div id="pair-msg" class="msg"></div>
        <details class="sub">
          <summary>Paste pairing text instead</summary>
          <p class="hint">For self-hosting or a local relay: <code>bun channel/pair.ts --text</code> prints it. It contains a secret key.</p>
          <p class="hint">Or pair by code through your own relay: enter its address, then the code above.</p>
          <input id="relay-input" type="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="wss://your-relay.example" />
          <textarea id="pair-input" rows="4" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder='{"v":1,"relayUrl":...}'></textarea>
          <div class="row"><button id="pair-save">Save pairing</button></div>
        </details>
      </details>
      <details>
        <summary>Voice (Groq key)</summary>
        <p class="hint">Talk needs a free Groq API key from console.groq.com/keys. Paste it here. It is stored on this phone only.</p>
        <div id="stt-status" class="key-status"></div>
        <div id="stt-check" class="hint"></div>
        <input id="stt-input" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="gsk_..." />
        <div class="row"><button id="stt-save">Save key</button><button id="stt-remove" class="secondary" hidden>Remove key</button></div>
        <div id="stt-msg" class="msg"></div>
      </details>
      <details>
        <summary>Gestures</summary>
        <div id="gestures" class="gestures"></div>
        <div class="row">
          <button id="g-save">Save gestures</button>
          <button id="g-reset" class="secondary">Reset to defaults</button>
        </div>
        <div id="g-msg" class="msg"></div>
      </details>
    </main>
  `
  els = {
    status: app.querySelector('#status')!,
    header: app.querySelector('#m-header')!,
    body: app.querySelector('#m-body')!,
    overlay: app.querySelector('#m-overlay')!,
    guide: app.querySelector('#guide')!,
    pairInput: app.querySelector('#pair-input')!,
    pairMsg: app.querySelector('#pair-msg')!,
    gestures: app.querySelector('#gestures')!,
    gestureMsg: app.querySelector('#g-msg')!,
    sttStatus: app.querySelector('#stt-status')!,
    sttCheck: app.querySelector('#stt-check')!,
    sttInput: app.querySelector('#stt-input')!,
    sttSave: app.querySelector('#stt-save')!,
    sttRemove: app.querySelector('#stt-remove')!,
  }
  const sttInput = app.querySelector<HTMLInputElement>('#stt-input')!
  const sttMsg = app.querySelector<HTMLDivElement>('#stt-msg')!
  app.querySelector('#stt-save')!.addEventListener('click', () => {
    if (!sttInput.value.trim()) {
      message(sttMsg, 'Paste a key first.', true)
      return
    }
    dismissKeyboard()
    els.sttSave.disabled = true
    message(sttMsg, 'Checking the key with Groq...', false)
    void cb
      .saveSttKey(sttInput.value)
      .then(check => {
        sttInput.value = ''
        message(sttMsg, check === 'unknown' ? 'Saved, but Groq could not be reached to check it.' : 'Saved.', check === 'unknown')
      })
      .catch(err => message(sttMsg, (err as Error).message, true))
      .finally(() => (els.sttSave.disabled = false))
  })
  els.sttRemove.addEventListener('click', () => {
    void cb
      .saveSttKey('')
      .then(() => message(sttMsg, 'Key removed. Talk is off.', false))
      .catch(err => message(sttMsg, (err as Error).message, true))
  })

  app.querySelector('#pair-save')!.addEventListener('click', () => {
    void cb
      .savePairing(els.pairInput.value)
      .then(() => {
        els.pairInput.value = ''
        message(els.pairMsg, 'Paired.', false)
      })
      .catch(err => message(els.pairMsg, `Not saved: ${(err as Error).message}`, true))
  })
  const codeInput = app.querySelector<HTMLInputElement>('#code-input')!
  const codeButton = app.querySelector<HTMLButtonElement>('#code-pair')!
  let lastTried = ''
  const pairNow = (): void => {
    if (codeButton.disabled) return
    dismissKeyboard()
    lastTried = normalizePairCode(codeInput.value) ?? codeInput.value
    codeButton.disabled = true
    message(els.pairMsg, 'Looking for your computer (up to 30 seconds)...', false)
    void cb
      .pairWithCode(codeInput.value, app.querySelector<HTMLInputElement>('#relay-input')!.value.trim())
      .then(() => {
        codeInput.value = ''
        message(els.pairMsg, 'Paired.', false)
      })
      .catch(err => message(els.pairMsg, `Not paired: ${(err as Error).message}`, true))
      .finally(() => (codeButton.disabled = false))
  }
  codeButton.addEventListener('click', pairNow)
  onEnter(codeInput, pairNow)
  // A complete code pairs on its own, so the keyboard never has to be got out of the way.
  codeInput.addEventListener('input', () => {
    const code = normalizePairCode(codeInput.value)
    if (code && code !== lastTried) pairNow()
  })
  onEnter(sttInput, () => app.querySelector<HTMLButtonElement>('#stt-save')!.click())
  onEnter(app.querySelector<HTMLInputElement>('#relay-input')!, () => codeInput.focus())
  app.querySelector('#pair-forget')!.addEventListener('click', () => {
    void cb
      .forgetPairing()
      .then(() => message(els.pairMsg, 'Pairing removed.', false))
      .catch(err => message(els.pairMsg, (err as Error).message, true))
  })
  app.querySelector('#g-save')!.addEventListener('click', () => {
    const map = readGestureEditor()
    const errors = validateGestureMap(map)
    if (errors.length) {
      message(els.gestureMsg, errors.join('; '), true)
      return
    }
    void cb
      .saveGestures(map)
      .then(() => message(els.gestureMsg, 'Saved.', false))
      .catch(err => message(els.gestureMsg, (err as Error).message, true))
  })
  app.querySelector('#g-reset')!.addEventListener('click', () => {
    setGestureMap(DEFAULT_GESTURES)
    message(els.gestureMsg, 'Defaults restored. Save to keep them.', false)
  })

  wireGuide(els.guide)
  keyboardFriendly(app)
  injectStyles()
}

function message(el: HTMLDivElement, text: string, error: boolean): void {
  el.textContent = text
  el.className = error ? 'msg msg-error' : 'msg'
}

let guideShown = false

export function setStatus(link: Link, paired: boolean): void {
  if (!els) return
  // Open the guide once for an unpaired app; after that, respect the user's toggle.
  if (!guideShown) {
    guideShown = true
    els.guide.open = !paired
  }
  const [cls, text] = !paired
    ? ['offline', 'Not paired']
    : link === 'online'
      ? ['online', 'Connected']
      : link === 'relay'
        ? ['relay', 'Waiting for computer']
        : ['offline', 'Offline']
  els.status.className = `status status-${cls}`
  els.status.textContent = text
}

let voiceRender = 0

/**
 * Shows whether a Groq key is saved, as a masked form and a fingerprint the
 * user can compare, and whether Groq accepts it. Pass `known` when the key
 * was just checked, to skip a second request.
 */
export function setVoiceStatus(key: string, opts: { known?: KeyCheck | null; fake?: boolean } = {}): void {
  if (!els) return
  const n = ++voiceRender
  const e = els
  e.sttRemove.hidden = !key
  e.sttSave.textContent = key ? 'Replace key' : 'Save key'
  e.sttInput.placeholder = key ? 'Paste a new key to replace the saved one' : 'gsk_...'
  e.sttCheck.className = 'hint'
  if (!key) {
    e.sttStatus.textContent = opts.fake ? 'No key saved (this dev build fakes transcripts).' : 'No Groq key saved: Talk is off.'
    e.sttCheck.textContent = ''
    return
  }
  void keyFingerprint(key).then(fp => {
    if (n === voiceRender) e.sttStatus.textContent = `Saved key ${maskKey(key)} · fingerprint ${fp}`
  })
  const show = (c: KeyCheck): void => {
    if (n !== voiceRender) return
    e.sttCheck.textContent =
      c === 'valid' ? '✓ Groq accepts this key. Talk is on.'
      : c === 'invalid' ? '✗ Groq rejects this key. Paste a working one to replace it.'
      : 'Could not reach Groq to check this key right now.'
    e.sttCheck.className = c === 'valid' ? 'hint key-ok' : c === 'invalid' ? 'hint msg-error' : 'hint'
  }
  if (opts.known) show(opts.known)
  else {
    e.sttCheck.textContent = 'Checking with Groq...'
    void checkGroqKey(key).then(show)
  }
}

export function mirror(frame: Frame): void {
  if (!els) return
  els.header.textContent = frame.header
  els.body.textContent = frame.timeline
  els.body.classList.toggle('dimmed', Boolean(frame.overlay))
  els.overlay.hidden = !frame.overlay
  els.overlay.textContent = frame.overlay?.content ?? ''
  els.overlay.dataset.kind = frame.overlay?.name ?? ''
}

export function setGestureMap(map: GestureMap): void {
  currentMap = map
  if (!els) return
  els.gestures.replaceChildren()
  for (const screen of SCREENS) {
    const group = document.createElement('fieldset')
    const legend = document.createElement('legend')
    legend.textContent = screen
    group.append(legend)
    for (const g of GESTURES) {
      const label = document.createElement('label')
      label.textContent = GESTURE_LABELS[g]
      const select = document.createElement('select')
      select.dataset.screen = screen
      select.dataset.gesture = g
      for (const action of ACTIONS[screen]) {
        const opt = document.createElement('option')
        opt.value = action
        opt.textContent = action
        opt.selected = map[screen][g] === action
        select.append(opt)
      }
      label.append(select)
      group.append(label)
    }
    els.gestures.append(group)
  }
}

function readGestureEditor(): GestureMap {
  const next = structuredClone(currentMap) as Record<string, Record<string, string>>
  for (const sel of els.gestures.querySelectorAll<HTMLSelectElement>('select')) {
    const { screen, gesture } = sel.dataset
    if (screen && gesture && next[screen]) next[screen][gesture] = sel.value
  }
  return next as GestureMap
}

function injectStyles(): void {
  // ER brand dark-theme surfaces: #232323 / #2E2E2E / #3E3E3E; OS green #3CFA44; signal red #FF453A.
  const css = `
    :root { color-scheme: dark; }
    html, body { margin: 0; min-height: 100%; background: #232323; color: #E5E5E5;
      font: 16px/1.4 -apple-system, BlinkMacSystemFont, 'Helvetica Neue', system-ui, sans-serif;
      touch-action: manipulation; -webkit-text-size-adjust: 100%; overscroll-behavior: none; }
    .panel { scroll-padding-bottom: 40vh; display: flex; flex-direction: column; gap: 16px; max-width: 640px; margin: 0 auto;
      padding: 24px; box-sizing: border-box; }
    header { display: flex; align-items: center; justify-content: space-between; }
    h1 { font-size: 18px; font-weight: 600; margin: 0; }
    .status { font-size: 12px; padding: 4px 10px; border-radius: 999px; border: 1px solid #3E3E3E;
      text-transform: uppercase; letter-spacing: 0.04em; }
    .status-online { color: #3CFA44; border-color: #3CFA44; background: rgba(60,250,68,0.08); }
    .status-relay { color: #E5E5E5; border-color: #7B7B7B; }
    .status-offline { color: #FF453A; border-color: #FF453A; background: rgba(255,69,58,0.08); }
    .mirror { background: #000; border: 1px solid #3E3E3E; border-radius: 12px; padding: 12px;
      color: #3CFA44; font: 13px/1.5 ui-monospace, Menlo, monospace; }
    .m-header { border: 1px solid #1F5F22; border-radius: 8px; padding: 2px 8px; margin-bottom: 6px; white-space: pre; overflow: hidden; }
    .m-stage { position: relative; }
    .m-body { margin: 0; white-space: pre-wrap; word-break: break-word; min-height: 9lh; transition: opacity 200ms; }
    .m-body.dimmed { opacity: 0.3; }
    .m-overlay { position: absolute; top: 0; left: 4%; right: 4%; margin: 0; padding: 6px 10px; white-space: pre-wrap;
      background: #000; border: 2px solid #3CFA44; border-radius: 10px; animation: fadein 300ms ease-out; }
    .m-overlay[data-kind="menu"] { left: auto; right: 2%; width: 45%; }
    @keyframes fadein { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
    details { background: #2E2E2E; border: 1px solid #3E3E3E; border-radius: 12px; padding: 12px 16px; }
    summary { cursor: pointer; font-weight: 600; }
    .hint { font-size: 13px; color: #A7A7A7; }
    .key-status { font: 13px ui-monospace, Menlo, monospace; color: #E5E5E5; margin: 4px 0; overflow-wrap: anywhere; }
    .key-ok { color: #3CFA44; }
    #code-input { width: 100%; box-sizing: border-box; background: #232323; color: #E5E5E5; border: 1px solid #3E3E3E;
      border-radius: 8px; padding: 10px; font: 20px ui-monospace, monospace; letter-spacing: 3px; text-transform: uppercase; }
    details.sub { margin-top: 12px; padding: 8px 12px; background: #262626; }
    button:disabled { opacity: 0.5; }
    #relay-input, input[type=password] { width: 100%; box-sizing: border-box; background: #232323; color: #E5E5E5;
      border: 1px solid #3E3E3E; border-radius: 8px; padding: 8px; font: 13px ui-monospace, monospace; }
    textarea { width: 100%; box-sizing: border-box; background: #232323; color: #E5E5E5;
      border: 1px solid #3E3E3E; border-radius: 8px; padding: 8px; font: 12px ui-monospace, monospace; }
    .row { display: flex; gap: 8px; margin-top: 8px; }
    button { background: #3CFA44; color: #000; border: 0; border-radius: 8px; padding: 8px 14px; font-weight: 600; }
    button.secondary { background: #3E3E3E; color: #E5E5E5; }
    .msg { font-size: 13px; margin-top: 8px; color: #A7A7A7; }
    .msg-error { color: #FF453A; }
    fieldset { border: 1px solid #3E3E3E; border-radius: 8px; margin: 8px 0; }
    legend { text-transform: capitalize; color: #A7A7A7; }
    label { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin: 4px 0; font-size: 14px; }
    select { background: #232323; color: #E5E5E5; border: 1px solid #3E3E3E; border-radius: 6px; padding: 4px; }
  `
  const style = document.createElement('style')
  style.textContent = css + GUIDE_CSS
  document.head.appendChild(style)
}
