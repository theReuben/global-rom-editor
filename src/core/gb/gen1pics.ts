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
import { findGbBankFreeSpace } from '../freespace'

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
  /** Index of the last byte the reader has touched. */
  endByte(): number {
    return this.byte
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
 * Decompress a Gen 1 pic at `off`. Returns row-major 2bpp tile data,
 * the square width in tiles, and the compressed byte length consumed
 * (used for the in-place fit check on import), or throws on malformed
 * data.
 */
export function gen1PicDecompress(
  data: Uint8Array,
  off: number,
): { tiles: Uint8Array; width: number; byteLength: number } {
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
  return { tiles: out, width, byteLength: r.endByte() - off + 1 }
}

/* ------------------------------------------------------- compressor ---- */

const GRAY_ENCODE = [
  [0x0, 0x1, 0x3, 0x2, 0x6, 0x7, 0x5, 0x4, 0xc, 0xd, 0xf, 0xe, 0xa, 0xb, 0x9, 0x8],
  [0x8, 0x9, 0xb, 0xa, 0xe, 0xf, 0xd, 0xc, 0x4, 0x5, 0x7, 0x6, 0x2, 0x3, 0x1, 0x0],
]

class BitWriter {
  bytes: number[] = [0]
  private bit = 7
  private byte = 0
  write(b: number) {
    if (++this.bit === 8) {
      this.byte++
      this.bit = 0
    }
    while (this.bytes.length <= this.byte) this.bytes.push(0)
    this.bytes[this.byte] |= b << (7 - this.bit)
  }
  size() {
    return this.byte + 1
  }
  /**
   * Bit position, monotonic in (byte, bit) — the reference tool compares
   * candidates on this, not the byte count, so two encodings that round
   * up to the same byte length can still be ordered.
   */
  bits() {
    return this.byte * 8 + this.bit
  }
}

function transposeTiles(data: Uint8Array, width: number): void {
  const n = width * width
  for (let i = 0; i < n; i++) {
    const j = (i * width + Math.floor(i / width)) % n
    if (i < j) {
      for (let k = 0; k < 16; k++) {
        const t = data[i * 16 + k]
        data[i * 16 + k] = data[j * 16 + k]
        data[j * 16 + k] = t
      }
    }
  }
}

function compressPlane(plane: Uint8Array, width: number): void {
  const ramSize = width * width * 8
  let nybbleLo = 0
  for (let i = 0; i < ramSize; i++) {
    const m = i % width
    if (!m) nybbleLo = 0
    const j = Math.floor(i / width) + m * width * 8
    const nybbleHi = (plane[j] >> 4) & 0xf
    const codeHi = GRAY_ENCODE[nybbleLo & 1][nybbleHi]
    nybbleLo = plane[j] & 0xf
    const codeLo = GRAY_ENCODE[nybbleHi & 1][nybbleLo]
    plane[j] = (codeHi << 4) | codeLo
  }
}

function rleEncodeNumber(w: BitWriter, nIn: number): void {
  let n = nIn + 1
  let v = n + 1
  v |= v >> 1
  v |= v >> 2
  v |= v >> 4
  v |= v >> 8
  v |= v >> 16
  v -= v >> 1
  v--
  const number = n - v
  let bitCount = -1
  while (v) {
    v >>= 1
    bitCount++
  }
  for (let j = 0; j < bitCount; j++) w.write(1)
  w.write(0)
  for (let j = bitCount; j >= 0; j--) w.write((number >> j) & 1)
}

function interpretCompress(
  planes: [Uint8Array, Uint8Array],
  mode: number,
  order: number,
  width: number,
): { data: Uint8Array; bits: number } {
  const ramSize = width * width * 8
  const rams = [Uint8Array.from(planes[order]), Uint8Array.from(planes[order ^ 1])]
  if (mode !== 0) for (let i = 0; i < ramSize; i++) rams[1][i] ^= rams[0][i]
  compressPlane(rams[0], width)
  if (mode !== 1) compressPlane(rams[1], width)

  const w = new BitWriter()
  w.bytes[0] = (width << 4) | width
  w.write(order)
  for (let plane = 0; plane < 2; plane++) {
    let type = 0
    let nums = 0
    let groups: number[] = []
    for (let x = 0; x < width; x++) {
      for (let bit = 0; bit < 8; bit += 2) {
        for (let y = 0, byte = x * width * 8; y < width * 8; y++, byte++) {
          const group = (rams[plane][byte] >> (6 - bit)) & 3
          if (group) {
            if (type === 0) w.write(1)
            else if (type === 1) rleEncodeNumber(w, nums)
            type = 2
            groups.push(group)
            nums = 0
          } else {
            if (type === 0) w.write(0)
            else if (type === 1) nums++
            else {
              for (const g of groups) {
                w.write((g >> 1) & 1)
                w.write(g & 1)
              }
              w.write(0)
              w.write(0)
            }
            type = 1
            groups = []
          }
        }
      }
    }
    if (type === 1) rleEncodeNumber(w, nums)
    else {
      for (const g of groups) {
        w.write((g >> 1) & 1)
        w.write(g & 1)
      }
    }
    if (!plane) {
      if (mode === 0) w.write(0)
      else {
        w.write(1)
        w.write(mode - 1)
      }
    }
  }
  return { data: Uint8Array.from(w.bytes.slice(0, w.size())), bits: w.bits() }
}

/**
 * Compress row-major 2bpp tile data into a Gen 1 pic — a faithful port
 * of pokered tools/pkmncompress.c compress(): tries all mode/order
 * combinations and keeps the one with the fewest bits (not bytes —
 * the reference compares bit lengths, so a shorter bit encoding wins
 * even when it rounds to the same byte count). Output matches the
 * reference tool byte for byte.
 */
export function gen1PicCompress(tiles: Uint8Array, width: number): Uint8Array {
  const ramSize = width * width * 8
  const data = Uint8Array.from(tiles)
  transposeTiles(data, width)
  const planes: [Uint8Array, Uint8Array] = [new Uint8Array(ramSize), new Uint8Array(ramSize)]
  for (let i = 0; i < ramSize; i++) {
    planes[0][i] = data[i * 2]
    planes[1][i] = data[i * 2 + 1]
  }
  let best: Uint8Array | null = null
  let bestBits = Infinity
  for (let mode = 0; mode < 3; mode++) {
    for (let order = 0; order < 2; order++) {
      if (mode === 0 && order === 0) continue
      const out = interpretCompress(planes, mode, order, width)
      if (out.bits < bestBits) {
        bestBits = out.bits
        best = out.data
      }
    }
  }
  return best!
}

export function buildGen1Sprites(
  rom: Rom,
  statsOffsetFor: (dex: number) => number,
  internalFor: (dex: number) => number,
  count: number,
): {
  front: (id: number) => RenderedImage | null
  back: (id: number) => RenderedImage | null
  importFront: (id: number, image: RenderedImage) => string | null
  importBack: (id: number, image: RenderedImage) => string | null
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

  // SGB colorization: MonsterPalettes (152 dex-order palette ids,
  // entry 0 = MissingNo) is immediately followed by SuperPalettes
  // (8-byte rows of 4 RGB555 colors, each starting near-white:
  // 31,29,31 in Red/Blue, 31,31,30 in Yellow) — verified against
  // pokered/pokeyellow data/pokemon/palettes.asm + sgb_palettes.asm.
  const nearWhite = (v: number) => (v & 31) >= 28 && ((v >> 5) & 31) >= 28 && ((v >> 10) & 31) >= 28
  let palTable = -1
  {
    outer: for (let o = 0; o + 152 + 40 * 8 <= bytes.length; o++) {
      for (let i = 0; i < 152; i++) {
        if (bytes[o + i] >= 0x30) continue outer
      }
      // The next bytes must look like SuperPalettes rows.
      for (let k = 0; k < 4; k++) {
        if (!nearWhite(rom.readU16LE(o + 152 + k * 8))) continue outer
      }
      // Every referenced palette id must have a plausible row, and the
      // rows must not all be identical (an all-0xFF or all-zero region
      // could fake the shape otherwise).
      let ok = true
      const firsts = new Set<number>()
      for (let dex = 1; dex <= Math.min(count, 151); dex++) {
        const row = o + 152 + bytes[o + dex] * 8
        if (row + 8 > bytes.length || !nearWhite(rom.readU16LE(row))) ok = false
        else firsts.add(rom.readU16LE(row + 2))
      }
      if (!ok || firsts.size < 8) continue
      palTable = o
      break
    }
  }
  const colorsFor = (dex: number): [number, number, number][] => {
    if (palTable < 0) return GB_SHADES
    const row = palTable + 152 + bytes[palTable + dex] * 8
    const five = (v: number) => ((v & 31) << 3) | ((v & 31) >> 2)
    const out: [number, number, number][] = []
    for (let i = 0; i < 4; i++) {
      const v = rom.readU16LE(row + i * 2)
      out.push([five(v), five(v >> 5), five(v >> 10)])
    }
    return out
  }

  const render = (dex: number, front: boolean): RenderedImage | null => {
    if (dex < 1 || dex > count) return null
    const pic = resolve(dex, front)
    if (!pic) return null
    const w = pic.width
    const widthPx = w * 8
    const pal = colorsFor(dex)
    const pixels = new Uint8ClampedArray(widthPx * widthPx * 4)
    for (let t = 0; t < w * w; t++) {
      const tx = (t % w) * 8
      const ty = Math.floor(t / w) * 8
      const tile = decodeTile2bpp(pic.tiles, t * 16)
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const o = ((ty + y) * widthPx + tx + x) * 4
          const [r, g, b] = pal[tile[y * 8 + x]]
          pixels[o] = r
          pixels[o + 1] = g
          pixels[o + 2] = b
          pixels[o + 3] = 255
        }
      }
    }
    return { pixels, width: widthPx, height: widthPx }
  }

  /**
   * Replace a species' pic with a custom image. Each pixel snaps to the
   * nearest of the species' four SGB palette colors (Gen 1 palettes are
   * shared palette *classes*, so they're never rewritten — only the
   * 2bpp pixels change), the tiles are re-encoded and compressed with
   * the reference-exact compressor, then written in place when the new
   * stream fits or relocated to trailing free space of the SAME bank
   * (front and back share it) with the bank-local pointer retargeted.
   */
  const importPic = (dex: number, front: boolean, image: RenderedImage): string | null => {
    if (dex < 1 || dex > count) return 'Unknown species'
    const bank = bankOf.get(dex)
    if (bank === undefined) return 'Could not locate this sprite in the ROM'
    const cur = resolve(dex, front)
    if (!cur) return 'Could not read the original sprite'
    const w = cur.width
    const px = w * 8
    if (image.width !== px || image.height !== px) {
      return `This sprite must be ${px}×${px} pixels`
    }

    // Snap each pixel to the nearest of the four palette colors.
    const pal = colorsFor(dex)
    const idx = new Uint8Array(px * px)
    for (let i = 0; i < px * px; i++) {
      if (image.pixels[i * 4 + 3] < 128) {
        idx[i] = 0 // transparent → the background color (index 0)
        continue
      }
      const r = image.pixels[i * 4]
      const g = image.pixels[i * 4 + 1]
      const b = image.pixels[i * 4 + 2]
      let best = 0
      let bestDist = Infinity
      for (let c = 0; c < 4; c++) {
        const dr = r - pal[c][0]
        const dg = g - pal[c][1]
        const db = b - pal[c][2]
        const d = dr * dr + dg * dg + db * db
        if (d < bestDist) {
          bestDist = d
          best = c
        }
      }
      idx[i] = best
    }

    // Row-major 2bpp tiles (the order gen1PicDecompress produced).
    const tiles = w * w
    const data = new Uint8Array(tiles * 16)
    for (let t = 0; t < tiles; t++) {
      const tx = (t % w) * 8
      const ty = Math.floor(t / w) * 8
      for (let y = 0; y < 8; y++) {
        let lo = 0
        let hi = 0
        for (let x = 0; x < 8; x++) {
          const v = idx[(ty + y) * px + tx + x]
          lo = (lo << 1) | (v & 1)
          hi = (hi << 1) | (v >> 1)
        }
        data[t * 16 + y * 2] = lo
        data[t * 16 + y * 2 + 1] = hi
      }
    }
    const packed = gen1PicCompress(data, w)

    const base = statsOffsetFor(dex)
    const ptrSlot = base + (front ? 11 : 13)
    const oldOff = bank * 0x4000 + rom.readU16LE(ptrSlot) - 0x4000
    let dest = oldOff
    if (packed.length > cur.byteLength) {
      const free = findGbBankFreeSpace(bytes, bank, packed.length)
      if (free === null) return 'No free space in the sprite bank for an image this size'
      dest = free
    }
    rom.writeBytes(dest, packed)
    rom.writeU16LE(ptrSlot, (dest % 0x4000) + 0x4000)
    return null
  }

  return {
    front: (id) => render(id, true),
    back: (id) => render(id, false),
    importFront: (id, image) => importPic(id, true, image),
    importBack: (id, image) => importPic(id, false, image),
  }
}
