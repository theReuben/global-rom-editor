import { describe, expect, it } from 'vitest'
import { Rom } from '../src/core/rom'
import { gen12Codec, gen3Codec, gen3Bytes, gen3DecodeText, gen3EncodeText } from '../src/core/text'
import { createIps, applyIps } from '../src/core/ips'
import { detectPlatform, readRomInfo } from '../src/core/detect'
import { fixChecksums } from '../src/core/checksum'
import { makeGen1Rom, makeGen2Rom, makeGen3Rom } from './fixtures'

const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((v, i) => v === b[i])

describe('text codecs', () => {
  it('round-trips Gen 1/2 names', () => {
    const encoded = gen12Codec.encode('NIDORAN♀', 10)!
    expect(encoded).toHaveLength(10)
    expect(gen12Codec.decode(Uint8Array.from(encoded))).toBe('NIDORAN♀')
    expect(gen12Codec.encode("FARFETCH'D", 10)).not.toBeNull()
    expect(gen12Codec.encode('MR.MIME', 10)).not.toBeNull()
  })

  it('round-trips Gen 3 names', () => {
    const encoded = gen3Codec.encode('MR. MIME', 10)!
    expect(gen3Codec.decode(Uint8Array.from(encoded))).toBe('MR. MIME')
  })

  it('rejects unencodable characters', () => {
    expect(gen12Codec.encode('日本語', 10)).toBeNull()
    expect(gen12Codec.encode('WAY-TOO-LONG-NAME', 10)).toBeNull()
  })
})

describe('IPS patches', () => {
  it('round-trips edits', () => {
    const original = new Uint8Array(70000).map((_, i) => i % 251)
    const modified = new Uint8Array(original)
    modified[0] = 0xaa
    modified[1234] = 0xbb
    modified.fill(0xcc, 40000, 45000) // spans a >0xFFFF-adjacent large run
    modified[69999] = 0xdd

    const patch = createIps(original, modified)
    expect(same(applyIps(original, patch), modified)).toBe(true)
  })

  it('handles a change at the EOF-colliding offset', () => {
    const size = 0x460000
    const original = new Uint8Array(size)
    const modified = new Uint8Array(size)
    modified[0x454f46] = 0x99 // offset spells "EOF"
    const patch = createIps(original, modified)
    expect(same(applyIps(original, patch), modified)).toBe(true)
  })

  it('rejects non-IPS files', () => {
    expect(() => applyIps(new Uint8Array(10), new Uint8Array(10))).toThrow()
  })
})

describe('detection', () => {
  it('detects platforms', () => {
    expect(detectPlatform(makeGen1Rom())).toBe('GB')
    expect(detectPlatform(makeGen2Rom())).toBe('GBC')
    expect(detectPlatform(makeGen3Rom())).toBe('GBA')
    expect(detectPlatform(new Uint8Array(0x200))).toBeNull()
  })

  it('reads headers', () => {
    expect(readRomInfo(makeGen1Rom())!.title).toBe('POKEMON RED')
    expect(readRomInfo(makeGen3Rom())!.gameCode).toBe('BPRE')
  })
})

describe('checksums', () => {
  it('fixes GB header checksum', () => {
    const rom = new Rom('x.gb', makeGen1Rom())
    fixChecksums(rom)
    let x = 0
    for (let i = 0x134; i <= 0x14c; i++) x = (x - rom.bytes[i] - 1) & 0xff
    expect(rom.bytes[0x14d]).toBe(x)
  })

  it('fixes GBA header checksum', () => {
    const rom = new Rom('x.gba', makeGen3Rom())
    fixChecksums(rom)
    let sum = 0
    for (let i = 0xa0; i <= 0xbc; i++) sum = (sum + rom.bytes[i]) & 0xff
    expect((sum + 0x19 + rom.bytes[0xbd]) & 0xff).toBe(0)
  })
})

describe('Rom change tracking', () => {
  it('counts and reverts edits', () => {
    const rom = new Rom('x.gb', makeGen1Rom())
    expect(rom.changedByteCount).toBe(0)
    rom.writeU8(100, 42)
    rom.writeU8(101, 43)
    expect(rom.changedByteCount).toBe(2)
    rom.writeU8(100, rom.original[100]) // writing the original value un-dirties
    expect(rom.changedByteCount).toBe(1)
    rom.revertAll()
    expect(rom.changedByteCount).toBe(0)
    expect(same(rom.bytes, rom.original)).toBe(true)
  })
})

describe('Gen 3 text codec', () => {
  it('decodes the accented and punctuation glyphs from the charmap', () => {
    const bytes = Uint8Array.from([0x06, 0x29, 0x5b, 0xf0, 0x2d, 0x5c, 0x5d, 0xff])
    expect(gen3Codec.decode(bytes)).toBe('Éñ%:&()')
  })

  it('keeps composite glyphs decode-only so real letters still encode', () => {
    // 0x55-0x59 spell POKéBLOCK (charmap: POKEBLOCK = 55 56 57 58 59).
    const block = Uint8Array.from([0x55, 0x56, 0x57, 0x58, 0x59, 0xff])
    expect(gen3Codec.decode(block)).toBe('POKéBLOCK')
    // ...but the letter K must still encode to 0xC5, not to 0x59.
    expect(gen3EncodeText('K')).toEqual([0xc5])
    expect(gen3EncodeText('BLOCK')).toEqual([0xbc, 0xc6, 0xc9, 0xbd, 0xc5])
  })

  it('round-trips multi-line text through the line-break byte', () => {
    const raw = Uint8Array.from([...gen3Bytes('Hi'), 0xfe, ...gen3Bytes('there'), 0xff])
    const text = gen3DecodeText(raw)
    expect(text).toBe('Hi\nthere')
    expect(gen3EncodeText(text)).toEqual([...raw].slice(0, -1))
  })

  it('accepts either apostrophe and rejects what the game cannot show', () => {
    expect(gen3EncodeText("'")).toEqual([0xb4])
    expect(gen3EncodeText('’')).toEqual([0xb4])
    expect(gen3EncodeText('\u{1F600}')).toBeNull()
    // 0xFF is the terminator, never a printable '$'.
    expect(gen3DecodeText(Uint8Array.from([0xbb, 0xff, 0xbb]))).toBe('A')
  })
})
