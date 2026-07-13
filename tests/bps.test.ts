import { describe, expect, it } from 'vitest'
import { applyBps, createBps, isBps } from '../src/core/bps'

const rand = (n: number, seed: number) => {
  const out = new Uint8Array(n)
  let s = seed >>> 0
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0
    out[i] = s >>> 16
  }
  return out
}

describe('BPS patches', () => {
  it('round-trips same-size edits', () => {
    const original = rand(0x8000, 1)
    const modified = new Uint8Array(original)
    modified[0x10] ^= 0xff
    modified.set([1, 2, 3, 4, 5], 0x4000)
    modified[0x7fff] ^= 0x55
    const patch = createBps(original, modified)
    expect(isBps(patch)).toBe(true)
    const out = applyBps(original, patch)
    expect(out).toEqual(modified)
  })

  it('round-trips grown output', () => {
    const original = rand(0x1000, 2)
    const modified = new Uint8Array(0x1800)
    modified.set(original)
    modified.fill(0xab, 0x1000)
    modified[5] = 0x99
    const out = applyBps(original, createBps(original, modified))
    expect(out).toEqual(modified)
  })

  it('rejects a patch for a different ROM', () => {
    const original = rand(0x1000, 3)
    const modified = new Uint8Array(original)
    modified[0] ^= 1
    const patch = createBps(original, modified)
    const other = rand(0x1000, 4)
    expect(() => applyBps(other, patch)).toThrow(/different ROM/)
  })

  it('rejects a corrupted patch', () => {
    const original = rand(0x1000, 5)
    const modified = new Uint8Array(original)
    modified[7] ^= 1
    const patch = createBps(original, modified)
    patch[8] ^= 0x40
    expect(() => applyBps(original, patch)).toThrow(/corrupted/)
  })

  it('merges small unchanged gaps into one literal run', () => {
    const original = rand(0x1000, 6)
    const modified = new Uint8Array(original)
    // Two edits 2 bytes apart should not produce pathological output.
    modified[100] ^= 1
    modified[103] ^= 1
    const patch = createBps(original, modified)
    expect(applyBps(original, patch)).toEqual(modified)
    expect(patch.length).toBeLessThan(64)
  })
})
