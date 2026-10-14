// Raw Even Hub events to gestures, and the menu's native list.
import { describe, expect, test } from 'bun:test'
import { OsEventTypeList, type EvenHubEvent } from '@evenrealities/even_hub_sdk'
import { toSignal } from '../src/input'
import { reduce } from '../src/state'
import { gs, paired } from './helpers'

const ev = (e: Record<string, unknown>): EvenHubEvent => e as unknown as EvenHubEvent

describe('toSignal', () => {
  test('a tap on a list row selects it; the first row arrives without an index', () => {
    expect(toSignal(ev({ listEvent: { currentSelectItemIndex: 2 } }))).toEqual({ type: 'list_select', index: 2 })
    expect(toSignal(ev({ listEvent: {} }))).toEqual({ type: 'list_select', index: 0 })
  })

  test('a double tap still means back, wherever it comes from', () => {
    expect(toSignal(ev({ sysEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } }))).toEqual({ type: 'gesture', gesture: 'double_tap' })
    expect(toSignal(ev({ listEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } }))).toEqual({ type: 'gesture', gesture: 'double_tap' })
  })

  test('taps and swipes on text containers are unchanged', () => {
    expect(toSignal(ev({ sysEvent: {} }))).toEqual({ type: 'gesture', gesture: 'tap' })
    expect(toSignal(ev({ textEvent: { eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } }))).toEqual({ type: 'gesture', gesture: 'scroll_down' })
  })
})

describe('menu_select', () => {
  test('selects the tapped row', () => {
    const menu = gs(paired(), 'tap')
    const r = reduce(menu, { type: 'menu_select', index: 1 })
    expect(r.effects).toEqual([{ type: 'send', kind: 'stop', body: {}, sid: '', room: '' }])
  })

  test('Talk opens the mic; End session asks before unpairing', () => {
    expect(reduce(gs(paired(), 'tap'), { type: 'menu_select', index: 0 }).state.voice.phase).toBe('listening')
    const asked = reduce(gs(paired(), 'tap'), { type: 'menu_select', index: 3 }).state
    expect(asked.confirmEnd).toBe(true)
    expect(reduce(asked, { type: 'menu_select', index: 0 }).effects).toEqual([])
    expect(reduce(asked, { type: 'menu_select', index: 1 }).effects).toEqual([{ type: 'unpair' }])
  })

  test('ignored when the menu is not open', () => {
    const s = paired()
    expect(reduce(s, { type: 'menu_select', index: 1 }).state).toBe(s)
  })
})
