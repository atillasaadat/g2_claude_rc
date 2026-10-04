// Keeps the phone view usable while the on-screen keyboard is up, without
// fighting the Even app's WebView: no layout changes or scrolling from
// script while the keyboard moves (those froze the page on a phone).
//   - Enter / Go on a single-line field runs its action and closes the keyboard.
//   - A tap (not a scroll) outside any field closes the keyboard.
//   - The page always ends with blank space (CSS, .panel), so the bottom
//     field and its button can be scrolled above the keyboard.

const FIELD = 'input, textarea, select'

/** Closes the on-screen keyboard, after the current event has finished. */
export function dismissKeyboard(): void {
  setTimeout(() => {
    const el = document.activeElement
    if (el instanceof HTMLElement && el.matches(FIELD)) el.blur()
  }, 0)
}

/** Wires `action` to Enter on `input`; the keyboard closes too. */
export function onEnter(input: HTMLInputElement, action: () => void): void {
  input.enterKeyHint = 'go'
  input.addEventListener('keydown', ev => {
    if (ev.key !== 'Enter') return
    ev.preventDefault()
    dismissKeyboard()
    action()
  })
}

export function keyboardFriendly(): void {
  // `click` only fires for a tap, so scrolling the page never closes the keyboard.
  document.addEventListener('click', ev => {
    const t = ev.target as HTMLElement | null
    if (!t?.closest(FIELD)) dismissKeyboard()
  })
}
