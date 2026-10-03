// Keeps the phone view usable while the on-screen keyboard is up. The Even
// app's WebView does not always shrink for the keyboard, so a field near the
// bottom, and the button under it, can end up hidden with no way out.
//   - Enter / Go on a single-line field runs its action and closes the keyboard.
//   - Tapping anywhere outside a field closes the keyboard.
//   - While a field has focus, the page gets room at the bottom for the
//     keyboard and scrolls the field into view.

const FIELD = 'input, textarea, select'

/** Closes the on-screen keyboard. */
export function dismissKeyboard(): void {
  const el = document.activeElement
  if (el instanceof HTMLElement && el.matches(FIELD)) el.blur()
}

/** Wires `action` to Enter on `input`; the keyboard closes first. */
export function onEnter(input: HTMLInputElement, action: () => void): void {
  input.enterKeyHint = 'go'
  input.addEventListener('keydown', ev => {
    if (ev.key !== 'Enter') return
    ev.preventDefault()
    input.blur()
    action()
  })
}

export function keyboardFriendly(root: HTMLElement): void {
  const vv = window.visualViewport
  // Tap outside any field: close the keyboard. Taps on buttons still click.
  document.addEventListener(
    'pointerdown',
    ev => {
      const t = ev.target as HTMLElement | null
      if (t?.closest(FIELD)) return
      dismissKeyboard()
      setTimeout(update, 50)
    },
    { capture: true },
  )

  function update(): void {
    const focused = document.activeElement instanceof HTMLElement && document.activeElement.matches(FIELD)
    // Height the keyboard covers, when the WebView reports it; otherwise a
    // generous fallback so the button under the field can be scrolled to.
    const covered = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0
    root.style.paddingBottom = focused ? `${Math.max(covered, Math.round(window.innerHeight * 0.45))}px` : ''
  }
  const reveal = (el: Element): void => {
    update()
    // After the keyboard animation, bring the field and its button into view.
    setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300)
  }
  root.addEventListener('focusin', ev => {
    if (ev.target instanceof Element && ev.target.matches(FIELD)) reveal(ev.target)
  })
  root.addEventListener('focusout', () => setTimeout(update, 50))
  vv?.addEventListener('resize', update)
}
