// Maps raw Even Hub events to gestures and lifecycle signals.
//
// Protobuf omits zero values, so CLICK_EVENT (0) arrives as an envelope with
// eventType undefined. The default must be resolved inside the envelope check,
// or every event without a sysEvent (audio frames, IMU) would read as a tap.

import { OsEventTypeList, type EvenHubEvent } from '@evenrealities/even_hub_sdk'
import type { Gesture } from './gestures'

export type InputSignal =
  | { type: 'gesture'; gesture: Gesture }
  | { type: 'os_menu'; itemID: number }
  | { type: 'foreground' }
  | { type: 'background' }
  | { type: 'exit' }

function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

export function toSignal(event: EvenHubEvent): InputSignal | null {
  // A choice in the glasses OS side menu (our session list).
  const menuId = event.menuItemClickEvent?.itemID
  if (typeof menuId === 'number' && menuId > 0) return { type: 'os_menu', itemID: menuId }

  const sys = eventTypeOf(event.sysEvent)
  const text = eventTypeOf(event.textEvent)
  const is = (t: OsEventTypeList) => sys === t || text === t

  // Double before single: check the more specific gesture first.
  if (is(OsEventTypeList.DOUBLE_CLICK_EVENT)) return { type: 'gesture', gesture: 'double_tap' }
  if (is(OsEventTypeList.SCROLL_TOP_EVENT)) return { type: 'gesture', gesture: 'scroll_up' }
  if (is(OsEventTypeList.SCROLL_BOTTOM_EVENT)) return { type: 'gesture', gesture: 'scroll_down' }
  if (is(OsEventTypeList.CLICK_EVENT)) return { type: 'gesture', gesture: 'tap' }
  if (sys === OsEventTypeList.FOREGROUND_ENTER_EVENT) return { type: 'foreground' }
  if (sys === OsEventTypeList.FOREGROUND_EXIT_EVENT) return { type: 'background' }
  if (sys === OsEventTypeList.SYSTEM_EXIT_EVENT || sys === OsEventTypeList.ABNORMAL_EXIT_EVENT) return { type: 'exit' }
  return null
}
