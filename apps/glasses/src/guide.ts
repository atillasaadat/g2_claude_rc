// Setup guide for the phone view, condensed from the website
// (https://atillasaadat.com/g2-claude/) for a phone screen.
// Static content only; nothing dynamic is ever interpolated into this HTML.

export const GUIDE_URL = 'https://atillasaadat.com/g2-claude/'
export const REPO_URL = 'https://github.com/atillasaadat/g2_claude_rc'

const cmd = (text: string): string =>
  `<div class="g-cmd"><pre>${text}</pre><button type="button" class="g-copy secondary">Copy</button></div>`

export const GUIDE_HTML = `
  <p class="hint">Follow a Claude Code session on your glasses: watch it, talk to it, approve tools, answer questions, and stop it. You need Claude Code signed in with a Claude account, and <a href="https://bun.sh">Bun</a>, on your computer.</p>
  <ol class="g-steps">
    <li>
      <strong>Install the plugin.</strong> In Claude Code on your computer, run:
      ${cmd('/plugin marketplace add atillasaadat/g2_claude_rc\n/plugin install g2@g2cc')}
    </li>
    <li>
      <strong>Add the launch command</strong> to <code>~/.zshrc</code> or <code>~/.bashrc</code>, then open a new terminal.
      ${cmd("alias cc-g2='claude --dangerously-load-development-channels plugin:g2@g2cc --rc'")}
      Run <code>cc-g2</code> instead of <code>claude</code>. The first launch shows a warning; choose that you are using it for local development.
    </li>
    <li>
      <strong>Pair this app.</strong> In that session, run
      ${cmd('/g2:pair')}
      and type the code it shows under <em>Pairing</em> below. Each code works once, for 10 minutes.
    </li>
    <li>
      <strong>Add your Groq key</strong> for voice under <em>Voice</em> below. A free key from <a href="https://console.groq.com/keys">console.groq.com/keys</a> works. It is stored on this phone only. Once saved, Voice shows it masked with a short fingerprint and whether Groq accepts it; a new key replaces it only if Groq accepts the new one.
    </li>
    <li>
      <strong>Get alerts in other apps.</strong> In a session, run <code>/config</code> and turn on <code>inputNeededNotifEnabled</code> and <code>agentPushNotifEnabled</code>. Allow notifications for the Claude app, then allow it in the Even app's notification settings.
    </li>
  </ol>
  <p class="hint">Every <code>cc-g2</code> session shows up on your glasses within a second. With two or more, the glasses' side menu lists them. To update the plugin, run <code>/plugin marketplace update g2cc</code>, or turn on auto-update for it under <code>/plugin</code>.</p>
  <h3 class="g-h">On the glasses</h3>
  <table class="g-table">
    <tr><th>Swipe</th><td>Scroll the timeline (the R1 ring works too)</td></tr>
    <tr><th>Tap</th><td>Menu: Talk, Stop Claude, Exit app. On a card, confirm</td></tr>
    <tr><th>Double tap</th><td>Back to the newest line. On a card, leave it for later</td></tr>
    <tr><th>Side menu</th><td>Switch sessions, or clear old ones</td></tr>
  </table>
  <p class="hint">While talking, <strong>stop</strong>, <strong>cancel</strong>, <strong>approve</strong> and <strong>deny</strong> act right away instead of being sent. Approval cards start on Deny, so a stray tap never approves anything.</p>
  <h3 class="g-h">If something is off</h3>
  <ul class="g-trouble">
    <li><strong>Waiting for Claude Code:</strong> start the session with <code>cc-g2</code>, not <code>claude</code>.</li>
    <li><strong>Code not accepted, or pairing hangs:</strong> codes work once and expire after 10 minutes, and the session that showed it must stay open. Update the plugin (<code>/plugin marketplace update g2cc</code>, then restart the session) and run <code>/g2:pair</code> again.</li>
    <li><strong>No approval cards:</strong> in auto mode Claude decides itself. Press Shift+Tab in the session to change the mode.</li>
    <li><strong>Talk is off:</strong> add your Groq key under Voice.</li>
    <li><strong>Stop seems slow:</strong> it takes effect at Claude's next tool call.</li>
  </ul>
  <p class="hint">Full guide: <a href="${GUIDE_URL}">${GUIDE_URL.replace('https://', '')}</a>. Source code: <a href="${REPO_URL}">${REPO_URL.replace('https://', '')}</a></p>
`

export const GUIDE_CSS = `
  .g-steps { margin: 8px 0 0; padding-left: 22px; font-size: 14px; }
  .g-steps li { margin: 0 0 14px; }
  .g-cmd { position: relative; margin: 6px 0; }
  .g-cmd pre { margin: 0; padding: 8px 64px 8px 10px; background: #232323; border: 1px solid #3E3E3E; border-radius: 8px;
    font: 12px/1.5 ui-monospace, Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere; color: #E5E5E5; }
  .g-cmd button { position: absolute; top: 5px; right: 5px; padding: 3px 8px; font-size: 12px; }
  .g-h { font-size: 14px; margin: 16px 0 6px; color: #E5E5E5; }
  .g-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .g-table th { text-align: left; white-space: nowrap; padding: 5px 10px 5px 0; color: #E5E5E5; font-weight: 600; vertical-align: top; }
  .g-table td { padding: 5px 0; border-bottom: 1px solid #3E3E3E; color: #C8C8C8; }
  .g-trouble { padding-left: 18px; font-size: 13px; color: #C8C8C8; }
  .g-trouble li { margin: 0 0 6px; }
  #guide a { color: #3CFA44; }
  #guide code { font: 12px ui-monospace, monospace; background: #232323; padding: 1px 4px; border-radius: 4px; }
`

/** Copy buttons: clipboard where the WebView allows it, otherwise select the text to copy by hand. */
export function wireGuide(root: HTMLElement): void {
  root.addEventListener('click', ev => {
    const button = (ev.target as HTMLElement).closest<HTMLButtonElement>('.g-copy')
    const pre = button?.previousElementSibling
    if (!button || !pre) return
    const text = pre.textContent ?? ''
    const select = () => {
      const range = document.createRange()
      range.selectNodeContents(pre)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    }
    navigator.clipboard
      ?.writeText(text)
      .then(() => (button.textContent = 'Copied'))
      .catch(() => {
        select()
        button.textContent = 'Selected'
      })
      .finally(() => setTimeout(() => (button.textContent = 'Copy'), 1500))
    if (!navigator.clipboard) {
      select()
      button.textContent = 'Selected'
    }
  })
}
