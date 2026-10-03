import { describe, expect, test } from 'bun:test'
import { ComputerPairing, GlassesPairing, MAX_ATTEMPTS, newPairCode, normalizePairCode, pairRoomId } from '../src/pair-code'

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

  test('the room depends only on the first 3 characters', async () => {
    expect(await pairRoomId('ABCD-EFGH')).toBe(await pairRoomId('ABCZ-ZZZZ'))
    expect(await pairRoomId('ABCD-EFGH')).not.toBe(await pairRoomId('ABDD-EFGH'))
  })

  test('a wrong password in the same room never gets the text', async () => {
    const r = await run('ABCD-EFGH', 'ABCD-EFGJ')
    expect(r.c.roomId).toBe(r.g.roomId)
    expect(r.text).toBeUndefined()
  })

  test('the code closes after too many wrong attempts, even for the right password', async () => {
    const c = await ComputerPairing.create('ABCD-EFGH', TEXT)
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const wrong = await GlassesPairing.create(`ABCD-EFG${i}`)
      const join = (await wrong.onFrame(c.hello)).send!
      const r = await c.onFrame(join)
      expect(r.send).toBeUndefined()
      if (i === MAX_ATTEMPTS - 1) expect(r.failed).toBe(true)
    }
    const right = await GlassesPairing.create('ABCD-EFGH')
    expect(await c.onFrame((await right.onFrame(c.hello)).send!)).toEqual({})
  })

  test('two joins with the right password: only the first gets the pairing', async () => {
    const c = await ComputerPairing.create('ABCD-EFGH', TEXT)
    const a = await GlassesPairing.create('ABCD-EFGH')
    const b = await GlassesPairing.create('ABCD-EFGH')
    const [ja, jb] = [(await a.onFrame(c.hello)).send!, (await b.onFrame(c.hello)).send!]
    const [ra, rb] = await Promise.all([c.onFrame(ja), c.onFrame(jb)])
    expect(ra.send).toBeDefined()
    expect(rb.send).toBeUndefined()
  })

  test('a phone answers every computer in a shared room and pairs with the right one', async () => {
    const other = await ComputerPairing.create('ABCD-ZZZZ', '{"other":true}')
    const mine = await ComputerPairing.create('ABCD-EFGH', TEXT)
    const g = await GlassesPairing.create('ABCD-EFGH')
    expect(await other.onFrame((await g.onFrame(other.hello)).send!)).toEqual({})
    const pairing = (await mine.onFrame((await g.onFrame(mine.hello)).send!)).send!
    expect((await g.onFrame(pairing)).pairingText).toBe(TEXT)
  })

  test('frames carry nothing to test password guesses against offline', async () => {
    // The hello is a random point: two hellos for the same code share nothing.
    const a = await ComputerPairing.create('ABCD-EFGH', TEXT)
    const b = await ComputerPairing.create('ABCD-EFGH', TEXT)
    expect(new TextDecoder().decode(a.hello)).not.toContain('mac')
    expect(a.hello).not.toEqual(b.hello)
  })

  test('the pairing text is not in any frame in the clear', async () => {
    const code = newPairCode()
    const c = await ComputerPairing.create(code, TEXT)
    const g = await GlassesPairing.create(code)
    const join = (await g.onFrame(c.hello)).send!
    const pairing = (await c.onFrame(join)).send!
    expect(new TextDecoder().decode(pairing)).not.toContain('relayUrl')
  })

  test('garbage frames are ignored on both sides', async () => {
    const c = await ComputerPairing.create('AAAA-AAAA', TEXT)
    const g = await GlassesPairing.create('AAAA-AAAA')
    const junk = new TextEncoder().encode('{"t":"pairing","sid":"x","iv":"x","ct":"y"}')
    expect(await c.onFrame(junk)).toEqual({})
    expect(await g.onFrame(junk)).toEqual({})
    expect(await g.onFrame(new Uint8Array([1, 2, 3]))).toEqual({})
  })
})
