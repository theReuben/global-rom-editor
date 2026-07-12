/**
 * Gen 1 (R/B/Y) Pokémon pic codec + sprite display.
 *
 * The compression is the classic Gen 1 bit-stream RLE, ported from
 * pokered tools/pkmncompress.c (whose decompressor mirrors the game's
 * home/uncompress.asm): a dims byte {width<<4|height} then a bit
 * stream of two bitplanes — alternating zero-run packets (unary
 * bit-count prefix + offset) and 2-bit data packets, each plane
 * delta-decoded column-wise, with three modes for XORing the planes
 * together. Output is row-major 2bpp tiles (the reference transposes
 * from the stored column order).
 *
 * Front/back pic pointers live in each species' base stats entry
 * (bytes 11-12 / 13-14, dims in byte 10); the BANK comes from code
 * (pokered swaps by internal id), so it's resolved by content: the
 * bank where the pointer decompresses cleanly to the dims the stats
 * entry promises. Resolved lazily and cached per species.
 */
import type { Rom } from '../rom'
import type { RenderedImage } from '../games/schema'
import { decodeTile2bpp } from '../tiles'

const GB_SHADES: [number, number, number][] = [
  [255, 255, 255],
  [170, 170, 170],
  [85, 85, 85],
  [0, 0, 0],
]

const ZERO_TABLE = [
  0x0001, 0x0003, 0x0007, 0x000f, 0x001f, 0x003f, 0x007f, 0x00ff,
  0x01ff, 0x03ff, 0x07ff, 0x0fff, 0x1fff, 0x3fff, 0x7fff, 0xffff,
]
const CODES = [
  [0x0, 0x1, 0x3, 0x2, 0x7, 0x6, 0x4, 0x5, 0xf, 0xe, 0xc, 0xd, 0x8, 0x9, 0xb, 0xa],
  [0xf, 0xe, 0xc, 0xd, 0x8, 0x9, 0xb, 0xa, 0x0, 0x1, 0x3, 0x2, 0x7, 0x6, 0x4, 0x5],
]

class BitReader {
  private bit = 7
  private byte: number
  constructor(private data: Uint8Array, start: number, private limit: number) {
    this.byte = start
  }
  read(): number {
    if (this.bit === -1) {
      this.byte++
      this.bit = 7
    }
    if (this.byte >= this.limit) throw new Error('pic: out of data')
    return (this.data[this.byte] >> this.bit--) & 1
  }
  readInt(count: number): number {
    let n = 0
    while (count--) n = (n << 1) | this.read()
    return n
  }
}

function fillPlane(r: BitReader, width: number): Uint8Array {
  const size = width * width * 0x20
  const plane = new Uint8Array(size)
  let mode = r.read()
  let len = 0
  while (len < size) {
    if (mode) {
      for (;;) {
        if (len >= size) break
        const group = r.readInt(2)
        if (!group) break
        plane[len++] = group
      }
    } else {
      let w = 0
      while (r.read()) {
        if (++w >= 16) throw new Error('pic: bad zero run')
      }
      let n = ZERO_TABLE[w] + r.readInt(w + 1)
      while (len < size && n--) plane[len++] = 0
      if (n > 0) throw new Error('pic: zero run overflow')
    }
    mode ^= 1
  }
  // Reorder the 2-bit groups into bytes, column-scan → linear.
  const ram = new Uint8Array(width * width * 8)
  let i = 0
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < width * 8; x++) {
      for (let k = 0; k < 4; k++) {
        const g = plane[(y * 4 + k) * width * 8 + x]
        if (k === 0) ram[i] = g << 6
        else ram[i] |= g << (6 - k * 2)
      }
      i++
    }
  }
  return ram
}

function uncompressPlane(plane: Uint8Array, width: number): void {
  for (let x = 0; x < width * 8; x++) {
    let bit = 0
    for (let y = 0; y < width; y++) {
      const i = y * width * 8 + x
      const hi = CODES[bit][(plane[i] >> 4) & 0xf]
      bit = hi & 1
      const lo = CODES[bit][plane[i] & 0xf]
      bit = lo & 1
      plane[i] = (hi << 4) | lo
    }
  }
}

/**
 * Decompress a Gen 1 pic at `off`. Returns row-major 2bpp tile data
 * plus the square width in tiles, or throws on malformed data.
 */
export function gen1PicDecompress(data: Uint8Array, off: number): { tiles: Uint8Array; width: number } {
  const r = new BitReader(data, off, Math.min(data.length, off + 0x1000))
  const width = r.readInt(4)
  const height = r.readInt(4)
  if (width !== height || width < 1 || width > 15) throw new Error('pic: not square')
  const size = width * width * 8
  const rams: Uint8Array[] = [new Uint8Array(0), new Uint8Array(0)]
  const order = r.read()
  rams[order] = fillPlane(r, width)
  let mode = r.read()
  if (mode) mode += r.read()
  rams[order ^ 1] = fillPlane(r, width)
  uncompressPlane(rams[order], width)
  if (mode !== 1) uncompressPlane(rams[order ^ 1], width)
  if (mode !== 0) {
    for (let i = 0; i < size; i++) rams[order ^ 1][i] ^= rams[order][i]
  }
  const out = new Uint8Array(size * 2)
  for (let i = 0; i < size; i++) {
    out[i * 2] = rams[0][i]
    out[i * 2 + 1] = rams[1][i]
  }
  // Transpose the column-major tile order to row-major.
  const n = width * width
  for (let i = 0; i < n; i++) {
    const j = (i * width + Math.floor(i / width)) % n
    if (i < j) {
      for (let k = 0; k < 16; k++) {
        const t = out[i * 16 + k]
        out[i * 16 + k] = out[j * 16 + k]
        out[j * 16 + k] = t
      }
    }
  }
  return { tiles: out, width }
}

export function buildGen1Sprites(
  rom: Rom,
  statsOffsetFor: (dex: number) => number,
  internalFor: (dex: number) => number,
  count: number,
): {
  front: (id: number) => RenderedImage | null
  back: (id: number) => RenderedImage | null
} | null {
  const bytes = rom.bytes
  const romBanks = Math.max(2, Math.floor(bytes.length / 0x4000))

  const decode = (bank: number, ptr: number, wantWidth: number) => {
    if (ptr < 0x4000 || ptr >= 0x8000) return null
    try {
      const pic = gen1PicDecompress(bytes, bank * 0x4000 + ptr - 0x4000)
      return wantWidth === 0 || pic.width === wantWidth ? pic : null
    } catch {
      return null
    }
  }

  // Resolve each species' pic bank up front. A pointer can decode
  // "validly" in more than one bank by coincidence, so ambiguous
  // species defer to the bank their internal-id neighbours resolved
  // to uniquely — the games assign pic banks by internal id ranges,
  // so neighbours share banks. Backs reuse their species' front bank
  // (each mon's two pics live together).
  const candidates = new Map<number, number[]>()
  for (let dex = 1; dex <= count; dex++) {
    const base = statsOffsetFor(dex)
    const wantWidth = bytes[base + 10] & 0x0f
    const frontPtr = rom.readU16LE(base + 11)
    const backPtr = rom.readU16LE(base + 13)
    const set: number[] = []
    for (let b = 1; b < romBanks; b++) {
      // Both of the species' pics live in the same bank — demanding
      // that the back decodes too kills almost every coincidental hit.
      if (decode(b, frontPtr, wantWidth) && decode(b, backPtr, 0)) set.push(b)
    }
    candidates.set(dex, set)
  }
  const bankOf = new Map<number, number>()
  const unique: { internal: number; bank: number }[] = []
  for (const [dex, set] of candidates) {
    if (set.length === 1) {
      bankOf.set(dex, set[0])
      unique.push({ internal: internalFor(dex), bank: set[0] })
    }
  }
  for (const [dex, set] of candidates) {
    if (set.length < 2) continue
    const internal = internalFor(dex)
    let best = set[0]
    let bestScore = -1
    for (const b of set) {
      const score = unique.filter((u) => u.bank === b && Math.abs(u.internal - internal) <= 12).length
      if (score > bestScore) {
        bestScore = score
        best = b
      }
    }
    bankOf.set(dex, best)
  }

  const resolve = (dex: number, front: boolean) => {
    const bank = bankOf.get(dex)
    if (bank === undefined) return null
    const base = statsOffsetFor(dex)
    const ptr = rom.readU16LE(base + (front ? 11 : 13))
    return decode(bank, ptr, front ? bytes[base + 10] & 0x0f : 0)
  }

  // The module is only offered when nearly everything resolved.
  if (bankOf.size < count * 0.9) return null

  const render = (dex: number, front: boolean): RenderedImage | null => {
    if (dex < 1 || dex > count) return null
    const pic = resolve(dex, front)
    if (!pic) return null
    const w = pic.width
    const widthPx = w * 8
    const pixels = new Uint8ClampedArray(widthPx * widthPx * 4)
    for (let t = 0; t < w * w; t++) {
      const tx = (t % w) * 8
      const ty = Math.floor(t / w) * 8
      const tile = decodeTile2bpp(pic.tiles, t * 16)
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const o = ((ty + y) * widthPx + tx + x) * 4
          const [r, g, b] = GB_SHADES[tile[y * 8 + x]]
          pixels[o] = r
          pixels[o + 1] = g
          pixels[o + 2] = b
          pixels[o + 3] = 255
        }
      }
    }
    return { pixels, width: widthPx, height: widthPx }
  }

  return {
    front: (id) => render(id, true),
    back: (id) => render(id, false),
  }
}
