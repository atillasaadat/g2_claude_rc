// Wraps raw G2 microphone PCM (s16le, 16 kHz, mono) in a WAV container.

export const SAMPLE_RATE = 16_000
export const BYTES_PER_SECOND = SAMPLE_RATE * 2

export function pcmToWav(chunks: readonly Uint8Array[]): Uint8Array {
  const dataLength = chunks.reduce((n, c) => n + c.length, 0)
  const wav = new Uint8Array(44 + dataLength)
  const v = new DataView(wav.buffer)
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) wav[offset + i] = s.charCodeAt(i)
  }
  ascii(0, 'RIFF')
  v.setUint32(4, 36 + dataLength, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  v.setUint32(16, 16, true) // fmt chunk size
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, 1, true) // mono
  v.setUint32(24, SAMPLE_RATE, true)
  v.setUint32(28, BYTES_PER_SECOND, true) // byte rate
  v.setUint16(32, 2, true) // block align
  v.setUint16(34, 16, true) // bits per sample
  ascii(36, 'data')
  v.setUint32(40, dataLength, true)
  let offset = 44
  for (const c of chunks) {
    wav.set(c, offset)
    offset += c.length
  }
  return wav
}
