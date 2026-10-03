// Shared test helpers for the glasses reducer and renderer.
import { expect } from 'bun:test'
import { getTextWidth } from '@evenrealities/pretext'
import { makeEnvelope, type AnyEnvelope, type Body, type Kind } from '@g2cc/protocol'
import { DEFAULT_GESTURES, type Gesture } from '../src/gestures'
import { innerLines, innerWidth } from '../src/layout'
import { frameOf, render, type Scene } from '../src/render'
import { CARD_GUARD_MS, initialState, reduce, type AppState, type Result } from '../src/state'

export const NOW = 1_800_000_000_000
export const LATER = NOW + CARD_GUARD_MS + 1

export const env = <K extends Kind>(kind: K, body: Body<K>, ts = NOW): AnyEnvelope => ({ ...makeEnvelope(kind, body), ts }) as AnyEnvelope
export const recv = (s: AppState, e: AnyEnvelope, now = NOW): AppState => reduce(s, { type: 'envelope', env: e, now }).state
export const g = (s: AppState, gesture: Gesture, now = LATER): Result => reduce(s, { type: 'gesture', gesture, map: DEFAULT_GESTURES, now })
export const gs = (s: AppState, ...gestures: Gesture[]): AppState => gestures.reduce((acc, x) => g(acc, x).state, s)

export const paired = (over: Partial<AppState> = {}): AppState =>
  recv({ ...initialState(), paired: true, voiceAvailable: true, ...over }, env('session', { name: 'g2cc-sandbox', cwd: '/x', state: 'idle', mode: 'auto' }))

export const perm = (request_id = 'abcde', tool_name = 'Bash'): Body<'permission'> => ({
  request_id,
  tool_name,
  description: 'Create empty test file',
  input_preview: '{ "command": "touch perm-test-3.txt", "description": "Create empty test file" }',
})

export const question = (question_id = 'q00000001', options = ['main', 'dev', 'release']): Body<'question'> => ({
  question_id,
  question: 'Which branch should I deploy?',
  options,
})

export const frame = (s: AppState) => frameOf(render(s))

/** Every container's text fits its box: line count and pixel width. */
export function assertFits(scene: Scene): void {
  for (const c of scene.containers) {
    const lines = c.content.split('\n')
    expect(lines.length).toBeLessThanOrEqual(innerLines(c.box))
    for (const l of lines) expect(getTextWidth(l)).toBeLessThanOrEqual(innerWidth(c.box))
    expect(c.box.x + c.box.w).toBeLessThanOrEqual(576)
    expect(c.box.y + c.box.h).toBeLessThanOrEqual(288)
  }
}

/** Many tool lines, enough to scroll. */
export function withLines(s: AppState, n: number): AppState {
  let out = s
  for (let i = 0; i < n; i++) out = recv(out, env('event', { type: 'notify', summary: `note ${i}` }))
  return out
}
