import { describe, expect, test } from 'bun:test'
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { BridgeQueue } from '../src/bridge-queue'
import { Display, layoutKey } from '../src/display'
import { render } from '../src/render'
import { reduce } from '../src/state'
import { env, gs, NOW, paired, recv } from './helpers'

function fakeBridge() {
  const calls: Array<{ fn: string; arg: unknown }> = []
  const bridge = {
    createStartUpPageContainer: async (arg: unknown) => (calls.push({ fn: 'create', arg }), 0),
    rebuildPageContainer: async (arg: unknown) => (calls.push({ fn: 'rebuild', arg }), true),
    textContainerUpgrade: async (arg: unknown) => (calls.push({ fn: 'upgrade', arg }), true),
  } as unknown as EvenAppBridge
  return { bridge, calls }
}

describe('Display', () => {
  test('content changes upgrade only the changed container, without a rebuild', async () => {
    const { bridge, calls } = fakeBridge()
    const d = new Display(bridge, new BridgeQueue(), e => {
      throw e
    })
    const s0 = paired()
    await d.init(render(s0))
    d.show(render(recv(s0, env('event', { type: 'notify', summary: 'hello' }))))
    await Bun.sleep(200)
    expect(calls.map(c => c.fn)).toEqual(['create', 'upgrade'])
    expect((calls[1]!.arg as { containerName: string }).containerName).toBe('timeline')
  })

  test('opening an overlay rebuilds once; moving its highlight only upgrades', async () => {
    const { bridge, calls } = fakeBridge()
    const d = new Display(bridge, new BridgeQueue(), e => {
      throw e
    })
    const s0 = paired()
    await d.init(render(s0))
    const menu = gs(s0, 'tap')
    d.show(render(menu))
    await Bun.sleep(200)
    d.show(render(gs(menu, 'scroll_down')))
    await Bun.sleep(200)
    expect(calls.map(c => c.fn)).toEqual(['create', 'rebuild', 'upgrade'])
  })

  test('brightness changes alone are upgrades', () => {
    const menu = gs(paired(), 'tap')
    const later = reduce(menu, { type: 'tick', now: NOW + 10_000 }).state
    expect(layoutKey(render(menu))).toBe(layoutKey(render(later)))
  })

  test('after a reload (page already created) init falls back to a rebuild', async () => {
    const { bridge, calls } = fakeBridge()
    ;(bridge as unknown as { createStartUpPageContainer: (a: unknown) => Promise<number> }).createStartUpPageContainer = async arg => (
      calls.push({ fn: 'create', arg }), 1
    )
    const d = new Display(bridge, new BridgeQueue(), e => {
      throw e
    })
    await d.init(render(paired()))
    expect(calls.map(c => c.fn)).toEqual(['create', 'rebuild'])
  })
})
