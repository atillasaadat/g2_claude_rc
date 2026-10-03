import { describe, expect, test } from 'bun:test'
import { ComputerPairing, GlassesPairing, newPairCode, normalizePairCode } from '../src/pair-code'

const TEXT = '{"v":1,"relayUrl":"wss://example.com","roomId":"00","key":"k"}'

describe('pairing codes', () => {
  test('new codes are 8 Crockford characters with a dash', () => {
    for (let i = 0; i < 50; i++) expect(newPairCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
  })

  test('normalizing forgives case, spaces, dashes, and look-alike letters', () => {
    expect(normalizePairCode('abcd-efgh')).toBe('ABCDEFGH')
    expect(normalizePairCode(' ab cd ef gh ')).toBe('ABCDEFGH')
    expect(normalizePairCode('O0IL-1234')).toBe('00111234')
    expect(normalizePairCode('ABCDEFG')).toBeNull()
    expect(normalizePairCode('ABCDEFGU')).toBeNull()
  })
})

describe('code pairing handshake', () => {
  async function run(computerCode: string, glassesCode: string) {
    const c = await ComputerPairing.create(computerCode, TEXT)
    const g = await GlassesPairing.create(glassesCode)
    const join = (await g.onFrame(c.hello)).send
    if (!join) return { c, g, text: undefined, done: false }
    const pairing = (await c.onFrame(join)).send!
    const got = await g.onFrame(pairing)
    const done = got.send ? (await c.onFrame(got.send)).done === true : false
    return { c, g, text: got.pairingText, done }
  }

  test('the same code on both sides delivers the pairing text', async () => {
    const code = newPairCode()
    const r = await run(code, code.toLowerCase().replace('-', ' '))
    expect(r.c.roomId).toBe(r.g.roomId)
    expect(r.c.roomId).toMatch(/^[0-9a-f]{32}$/)
    expect(r.text).toBe(TEXT)
    expect(r.done).toBe(true)
  })

  test('a wrong code lands in another room and never gets the text', async () => {
    const r = await run('AAAA-AAAA', 'AAAA-AAAB')
    expect(r.c.roomId).not.toBe(r.g.roomId)
    expect(r.text).toBeUndefined()
  })

  test('the pairing text is not in any frame in the clear', async () => {
    const code = newPairCode()
    const c = await ComputerPairing.create(code, TEXT)
    const g = await GlassesPairing.create(code)
    const join = (await g.onFrame(c.hello)).send!
    const pairing = (await c.onFrame(join)).send!
    expect(new TextDecoder().decode(pairing)).not.toContain('relayUrl')
  })

  test('a join signed with another code is ignored', async () => {
    const c = await ComputerPairing.create('AAAA-AAAA', TEXT)
    const forged = await GlassesPairing.create('BBBB-BBBB')
    // Make the forger accept the hello by giving it a hello from its own code.
    const own = await ComputerPairing.create('BBBB-BBBB', TEXT)
    const join = (await forged.onFrame(own.hello)).send!
    expect(await c.onFrame(join)).toEqual({})
  })

  test('garbage frames are ignored on both sides', async () => {
    const c = await ComputerPairing.create('AAAA-AAAA', TEXT)
    const g = await GlassesPairing.create('AAAA-AAAA')
    const junk = new TextEncoder().encode('{"t":"pairing","iv":"x","ct":"y"}')
    expect(await c.onFrame(junk)).toEqual({})
    expect(await g.onFrame(junk)).toEqual({})
    expect(await g.onFrame(new Uint8Array([1, 2, 3]))).toEqual({})
  })
})
