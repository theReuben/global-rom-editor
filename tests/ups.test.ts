import { describe, expect, it } from 'vitest'
import { applyUps, createUps, crc32, isUps } from '../src/core/ups'

const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((v, i) => v === b[i])

describe('UPS patches', () => {
  it('computes standard CRC32', () => {
    // Known vector: CRC32("123456789") = 0xCBF43926
    expect(crc32(Uint8Array.from(Array.from('123456789').map((c) => c.charCodeAt(0))))).toBe(0xcbf43926)
  })

  it('round-trips same-size edits, including large offsets', () => {
    const original = new Uint8Array(0x1200000).map((_, i) => i % 251) // > 16 MiB
    const modified = new Uint8Array(original)
    modified[0] ^= 0xff
    modified[0x123456] = 0
    modified.fill(0xab, 0x1100000, 0x1100200)
    modified[modified.length - 1] ^= 1
    const patch = createUps(original, modified)
    expect(isUps(patch)).toBe(true)
    expect(same(applyUps(original, patch), modified)).toBe(true)
  })

  it('round-trips size-changing patches', () => {
    const original = new Uint8Array(1000).fill(7)
    const modified = new Uint8Array(1600).fill(7)
    modified.fill(9, 1200, 1400)
    const patch = createUps(original, modified)
    const out = applyUps(original, patch)
    expect(out.length).toBe(1600)
    expect(same(out, modified)).toBe(true)

    const shrink = createUps(modified, original)
    expect(same(applyUps(modified, shrink), original)).toBe(true)
  })

  it('handles adjacent diff runs separated by one byte', () => {
    const original = new Uint8Array(64)
    const modified = new Uint8Array(64)
    modified[10] = 1
    modified[12] = 2 // exactly one unchanged byte between runs
    modified[13] = 3
    const patch = createUps(original, modified)
    expect(same(applyUps(original, patch), modified)).toBe(true)
  })

  it('rejects wrong ROMs and corrupted patches', () => {
    const original = new Uint8Array(100).fill(1)
    const modified = new Uint8Array(100).fill(2)
    const patch = createUps(original, modified)
    expect(() => applyUps(new Uint8Array(100).fill(3), patch)).toThrow(/different ROM/)
    expect(() => applyUps(new Uint8Array(99), patch)).toThrow(/expects/)
    const corrupt = patch.slice()
    corrupt[6] ^= 0xff
    expect(() => applyUps(original, corrupt)).toThrow(/corrupted/)
  })
})
