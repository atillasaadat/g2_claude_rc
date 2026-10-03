// Companion UI shown on the phone: connection status, a mirror of the glasses
// display, pairing, and the gesture map editor. Dynamic values only ever go
// through textContent, never innerHTML.

import { ACTIONS, DEFAULT_GESTURES, GESTURES, SCREENS, validateGestureMap, type GestureMap } from './gestures'
import type { Frame } from './render'
import type { Link } from './state'

export interface UiCallbacks {
  savePairing(text: string): Promise<void>
  forgetPairing(): Promise<void>
  saveGestures(map: GestureMap): Promise<void>
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
  pairInput: HTMLTextAreaElement
  pairMsg: HTMLDivElement
  gestures: HTMLDivElement
  gestureMsg: HTMLDivElement
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
        <pre id="m-body" class="m-body"></pre>
      </section>
      <details>
        <summary>Pairing</summary>
        <p class="hint">On your computer run <code>bun channel/pair.ts</code> and paste the pairing text here. It contains a secret key.</p>
        <textarea id="pair-input" rows="4" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder='{"v":1,"relayUrl":...}'></textarea>
        <div class="row">
          <button id="pair-save">Save pairing</button>
          <button id="pair-forget" class="secondary">Forget</button>
        </div>
        <div id="pair-msg" class="msg"></div>
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
    pairInput: app.querySelector('#pair-input')!,
    pairMsg: app.querySelector('#pair-msg')!,
    gestures: app.querySelector('#gestures')!,
    gestureMsg: app.querySelector('#g-msg')!,
  }

  app.querySelector('#pair-save')!.addEventListener('click', () => {
    void cb
      .savePairing(els.pairInput.value)
      .then(() => {
        els.pairInput.value = ''
        message(els.pairMsg, 'Paired.', false)
      })
      .catch(err => message(els.pairMsg, `Not saved: ${(err as Error).message}`, true))
  })
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

  injectStyles()
}

function message(el: HTMLDivElement, text: string, error: boolean): void {
  el.textContent = text
  el.className = error ? 'msg msg-error' : 'msg'
}

export function setStatus(link: Link, paired: boolean): void {
  if (!els) return
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

export function mirror(frame: Frame): void {
  if (!els) return
  els.header.textContent = frame.header
  els.body.textContent = frame.body
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
    .panel { display: flex; flex-direction: column; gap: 16px; max-width: 640px; margin: 0 auto;
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
    .m-header { border-bottom: 1px solid #1F5F22; padding-bottom: 6px; margin-bottom: 6px; white-space: pre; overflow: hidden; }
    .m-body { margin: 0; white-space: pre-wrap; word-break: break-word; min-height: 9lh; }
    details { background: #2E2E2E; border: 1px solid #3E3E3E; border-radius: 12px; padding: 12px 16px; }
    summary { cursor: pointer; font-weight: 600; }
    .hint { font-size: 13px; color: #A7A7A7; }
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
  style.textContent = css
  document.head.appendChild(style)
}
