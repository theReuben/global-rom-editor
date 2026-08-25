/**
 * The `smol` codec (pokeemerald-expansion).
 *
 * These tests use synthetic streams. The real correctness evidence is
 * that this decoder reproduces all 6954 `.smol` build intermediates in
 * a reference expansion tree byte-for-byte, across every mode the
 * compressor emits (1, 2, 3, 5 and 6) — see docs/HANDOFF.md. What is
 * pinned here is the part that broke twice in development: deciding
 * whether some bytes are a smol stream at all.
 */
import { describe, expect, it } from 'vitest'
import { isSmol, readSmolHeader, smolCompressedSize, smolDecompress, SMOL_MODE } from '../src/core/gba/smol'
import { isKnownCodec, decompressGraphics } from '../src/core/gba/compress'
import { makeSmolBaseOnly } from './fixtures'

function pattern(len: number): Uint8Array {
  const out = new Uint8Array(len)
  for (let i = 0; i < len; i++) out[i] = (i * 7 + (i >> 5)) & 0xff
  return out
}

describe('smol', () => {
  it('parses the two header words', () => {
    const raw = pattern(0x800)
    const h = readSmolHeader(makeSmolBaseOnly(raw), 0)
    expect(h).toMatchObject({ mode: SMOL_MODE.BASE_ONLY, imageSize: 0x800, symSize: 0x400 })
  })

  it('round-trips an uncompressed-mode stream', () => {
    const raw = pattern(0x800)
    const got = smolDecompress(makeSmolBaseOnly(raw), 0)
    expect(got).not.toBeNull()
    expect(Array.from(got!)).toEqual(Array.from(raw))
  })

  it('reports the compressed size so slots can be rewritten in place', () => {
    const stream = makeSmolBaseOnly(pattern(0x40))
    expect(smolCompressedSize(stream, 0)).toBe(stream.length)
  })

  it('decodes at an offset inside a larger buffer', () => {
    const raw = pattern(0x100)
    const stream = makeSmolBaseOnly(raw)
    const rom = new Uint8Array(0x1000)
    rom.set(stream, 0x40)
    expect(Array.from(smolDecompress(rom, 0x40)!)).toEqual(Array.from(raw))
  })

  it('does not mistake a raw palette for a stream', () => {
    // A 16-colour palette whose first colour is 0x6a93 parses as a
    // perfectly plausible header — mode 3, with sizes that pass casual
    // checks. This is the real Bulbasaur palette that decoded to 55 KB
    // of noise before the size fields were cross-checked.
    const pal = Uint8Array.from([
      0x93, 0x6a, 0xff, 0x7f, 0xb0, 0x63, 0x4c, 0x5b, 0x47, 0x4a, 0x23, 0x25,
      0xbf, 0x31, 0x9d, 0x1c, 0x15, 0x18, 0x39, 0x67, 0x42, 0x08, 0xf7, 0x3b,
      0x54, 0x23, 0xae, 0x1a, 0x8a, 0x15, 0xc6, 0x39,
    ])
    expect(readSmolHeader(pal, 0)!.mode).toBe(SMOL_MODE.ENCODE_DELTA_SYMS) // it really does look like one
    expect(isSmol(pal, 0)).toBe(false)
    expect(decompressGraphics(pal, 0)).toBeNull()
  })

  it('rejects arbitrary data', () => {
    const junk = new Uint8Array(4096)
    for (let i = 0; i < junk.length; i++) junk[i] = (i * 31 + 17) & 0xff
    let accepted = 0
    for (let off = 0; off + 8 < junk.length; off += 4) if (isSmol(junk, off) && smolDecompress(junk, off)) accepted++
    expect(accepted).toBe(0)
  })

  it('leaves LZ77 to the LZ77 decoder', () => {
    // LZ77's magic byte 0x10 has a low nibble of 0, which is MODE_LZ77,
    // so the two formats can never be confused for one another.
    const lz = Uint8Array.from([0x10, 0x04, 0x00, 0x00, 0x00, 1, 2, 3, 4])
    expect(isSmol(lz, 0)).toBe(false)
    expect(isKnownCodec(lz, 0)).toBe(true)
  })

  it('routes both codecs through one reader', () => {
    const raw = pattern(0x40)
    expect(isKnownCodec(makeSmolBaseOnly(raw), 0)).toBe(true)
    expect(Array.from(decompressGraphics(makeSmolBaseOnly(raw), 0)!)).toEqual(Array.from(raw))
  })

  it('refuses a stream whose instructions do not fill the declared size', () => {
    const stream = makeSmolBaseOnly(pattern(0x100))
    // Claim twice the output; the literals can no longer account for it.
    const view = new DataView(stream.buffer)
    const w0 = view.getUint32(0, true)
    view.setUint32(0, (w0 & 0xf) | (((0x200 / 4) << 4) | (((w0 >>> 18) & 0x3fff) << 18)), true)
    expect(smolDecompress(stream, 0)).toBeNull()
  })
})
