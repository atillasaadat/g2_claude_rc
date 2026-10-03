// Landing page behaviour, kept out of the HTML so the CSP can forbid inline scripts.
// Copy buttons for commands.
for (const button of document.querySelectorAll('.cmd button')) {
  button.addEventListener('click', async () => {
    const text = button.previousElementSibling.textContent
    try {
      await navigator.clipboard.writeText(text)
      button.textContent = 'Copied'
    } catch {
      button.textContent = 'Select and copy'
    }
    setTimeout(() => (button.textContent = 'Copy'), 1600)
  })
}
// Play the display sequence once, when it scrolls into view.
const hud = document.getElementById('hud')
new IntersectionObserver((entries, obs) => {
  if (entries.some(e => e.isIntersecting)) {
    hud.classList.add('play')
    obs.disconnect()
  }
}, { threshold: 0.4 }).observe(hud)
