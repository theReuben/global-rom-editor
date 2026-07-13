import { describe, expect, it } from 'vitest'
import { lz77Compress, lz77Decompress, lz77CompressedSize } from '../src/core/gba/lz77'
import { gen1PicCompress, gen1PicDecompress } from '../src/core/gb/gen1pics'
import {
  decodeTile2bpp,
  encodeTile2bpp,
  decodeTile4bpp,
  encodeTile4bpp,
  bgr555ToRgb,
  rgbToBgr555,
  renderTilesRgba,
} from '../src/core/tiles'
import {
  findFreeSpace,
  findGbaPointerRefs,
  readGbaPointer,
  relocate,
  writeGbaPointer,
  GBA_ROM_BASE,
} from '../src/core/freespace'
import { Rom } from '../src/core/rom'

const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((v, i) => v === b[i])

describe('GBA LZ77', () => {
  it('round-trips assorted payloads', () => {
    const cases = [
      new Uint8Array(0),
      new Uint8Array([1, 2, 3]),
      new Uint8Array(4096).fill(0xab), // highly compressible
      new Uint8Array(1000).map((_, i) => (i * 7919) % 256), // incompressible-ish
      new Uint8Array([...Array(50).keys(), ...Array(50).keys(), ...Array(50).keys()]),
    ]
    for (const data of cases) {
      const packed = lz77Compress(data)
      expect(same(lz77Decompress(packed), data)).toBe(true)
      expect(lz77CompressedSize(packed)).toBeLessThanOrEqual(packed.length)
    }
  })

  it('compresses repetitive data well', () => {
    // Max match length is 18, so 2048 constant bytes need ~114 tokens ≈ 250 B.
    const data = new Uint8Array(2048).fill(0x11)
    expect(lz77Compress(data).length).toBeLessThan(300)
  })

  it('rejects non-LZ77 data', () => {
    expect(() => lz77Decompress(new Uint8Array([0x99, 0, 0, 0]))).toThrow()
  })
})

describe('Gen 1 pic codec', () => {
  // The compressor is validated byte-exact against pokered's own
  // pkmncompress tool separately (needs real pics); here we cover the
  // property that matters for editing: compress → decompress is exact
  // for any 2bpp tile grid, across widths and content patterns.
  const grids = (width: number): Uint8Array[] => {
    const size = width * width * 16
    return [
      new Uint8Array(size), // all zero → maximally compressible
      new Uint8Array(size).fill(0xff), // all set
      new Uint8Array(size).map((_, i) => (i * 2654435761) & 0xff), // noisy
      new Uint8Array(size).map((_, i) => (Math.floor(i / 16) & 1) * 0xaa), // striped tiles
    ]
  }
  it('round-trips assorted tile grids at every sprite width', () => {
    for (const width of [1, 3, 5, 7]) {
      for (const data of grids(width)) {
        const packed = gen1PicCompress(data, width)
        const out = gen1PicDecompress(packed, 0)
        expect(out.width).toBe(width)
        expect(same(out.tiles, data)).toBe(true)
        // The decoder reports how many bytes the stream consumed.
        expect(out.byteLength).toBe(packed.length)
      }
    }
  })
})

describe('tile codecs', () => {
  it('round-trips 2bpp tiles', () => {
    const pixels = new Uint8Array(64).map((_, i) => i % 4)
    expect(same(decodeTile2bpp(encodeTile2bpp(pixels)), pixels)).toBe(true)
  })

  it('round-trips 4bpp tiles', () => {
    const pixels = new Uint8Array(64).map((_, i) => i % 16)
    expect(same(decodeTile4bpp(encodeTile4bpp(pixels)), pixels)).toBe(true)
  })

  it('round-trips BGR555 colors', () => {
    expect(bgr555ToRgb(0x7fff)).toEqual([255, 255, 255])
    expect(bgr555ToRgb(0)).toEqual([0, 0, 0])
    expect(rgbToBgr555(...bgr555ToRgb(0x1234))).toBe(0x1234)
  })

  it('renders tiles to an RGBA buffer', () => {
    const tile = new Uint8Array(64).fill(1)
    const { pixels, width, height } = renderTilesRgba([tile, tile, tile], 2, [
      [0, 0, 0],
      [10, 20, 30],
    ])
    expect(width).toBe(16)
    expect(height).toBe(16)
    expect([pixels[0], pixels[1], pixels[2], pixels[3]]).toEqual([10, 20, 30, 255])
  })
})

describe('free space & repointing', () => {
  it('finds aligned free space without touching terminators', () => {
    const bytes = new Uint8Array(1024).fill(0xaa)
    bytes.fill(0xff, 500, 700)
    const off = findFreeSpace(bytes, 64)!
    expect(off % 4).toBe(0)
    expect(off).toBeGreaterThan(500) // leaves the leading 0xFF alone
    expect(off + 64).toBeLessThanOrEqual(700)
    expect(findFreeSpace(bytes, 500)).toBeNull()
  })

  it('reads and writes GBA pointers', () => {
    const rom = new Rom('x.gba', new Uint8Array(0x1000))
    writeGbaPointer(rom, 0x10, 0x0800)
    expect(readGbaPointer(rom.bytes, 0x10)).toBe(0x0800)
    expect(readGbaPointer(new Uint8Array([0, 0, 0, 0]), 0)).toBeNull()
  })

  it('relocates data and retargets all pointers', () => {
    const bytes = new Uint8Array(0x2000).fill(0xff)
    bytes.fill(0xaa, 0, 0x900) // "used" region
    const rom = new Rom('x.gba', bytes)
    // A 16-byte table at 0x100, referenced from two pointer sites.
    const table = Uint8Array.from({ length: 16 }, (_, i) => i + 1)
    rom.writeBytes(0x100, table)
    writeGbaPointer(rom, 0x200, 0x100)
    writeGbaPointer(rom, 0x300, 0x100)

    const grown = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
    const dest = relocate(rom, 0x100, 16, grown)!
    expect(dest).not.toBeNull()
    expect(dest).toBeGreaterThanOrEqual(0x900)
    expect(readGbaPointer(rom.bytes, 0x200)).toBe(dest)
    expect(readGbaPointer(rom.bytes, 0x300)).toBe(dest)
    expect(same(rom.bytes.subarray(dest, dest + 32), grown)).toBe(true)
    expect(rom.bytes[0x100]).toBe(0xff) // old copy wiped
    expect(findGbaPointerRefs(rom.bytes, 0x100)).toHaveLength(0)
  })

  it('GBA_ROM_BASE is the cartridge mapping', () => {
    expect(GBA_ROM_BASE).toBe(0x08000000)
  })
})
