/**
 * `smol` decompression — pokeemerald-expansion's replacement for LZ77.
 *
 * Hacks built with `tools/compresSmol` store graphics and palettes in
 * this format instead, which is why sprite and map rendering were
 * previously switched off for those ROMs. It is a two-stage codec:
 *
 *   1. an LZ pass over u16 units, emitted as a stream of (length,
 *      offset) "instructions" plus a stream of literal symbols;
 *   2. an optional tANS (tabled asymmetric numeral systems) entropy
 *      coder over 4-bit nibbles, applied to either stream or both.
 *
 * Ported from the decompressor the game itself runs (`src/decompress.c`
 * in the expansion tree) rather than from the compressor, because the
 * game side defines what a valid stream means. The unrolled loops there
 * are pure GBA cycle-shaving; the logic below is the same arithmetic
 * written straight. Verified byte-for-byte against build intermediates:
 * decompressing a `.4bpp.smol` reproduces its `.4bpp` exactly.
 */

/** `enum CompressionMode`. */
export const SMOL_MODE = {
  LZ77: 0,
  BASE_ONLY: 1,
  ENCODE_SYMS: 2,
  ENCODE_DELTA_SYMS: 3,
  ENCODE_LO: 4,
  ENCODE_BOTH: 5,
  ENCODE_BOTH_DELTA_SYMS: 6,
  IS_FRAME_CONTAINER: 7,
  IS_TILEMAP: 8,
} as const

const TANS_TABLE_SIZE = 64
const PACKED_FREQ_MASK = 0x3f
const CONTINUE_BIT = 0x80
const FIRST_LO_MASK = 0x7f
/** `imageSize` counts u32s. */
const IMAGE_SIZE_MULTIPLIER = 4

export interface SmolHeader {
  mode: number
  /** Decompressed size in bytes. */
  imageSize: number
  symSize: number
  initialState: number
  bitstreamSize: number
  loSize: number
}

/**
 * The two header words. An LZ77 stream's first byte is 0x10, whose low
 * nibble is 0 — which is exactly `MODE_LZ77`, so one field distinguishes
 * the two formats and `isSmol` never has to guess.
 */
export function readSmolHeader(bytes: Uint8Array, off: number): SmolHeader | null {
  if (off < 0 || off + 8 > bytes.length) return null
  const w0 = u32(bytes, off)
  const w1 = u32(bytes, off + 4)
  return {
    mode: w0 & 0xf,
    imageSize: ((w0 >>> 4) & 0x3fff) * IMAGE_SIZE_MULTIPLIER,
    symSize: (w0 >>> 18) & 0x3fff,
    initialState: w1 & 0x3f,
    bitstreamSize: (w1 >>> 6) & 0x1fff,
    loSize: (w1 >>> 19) & 0x1fff,
  }
}

/**
 * Is there a plausible `smol` stream at `off`?
 *
 * The header has no magic number — only a 4-bit mode — so eight bytes of
 * unrelated data have a good chance of parsing as one. A raw 32-byte
 * palette really did: its first colour, 0x6a93, put mode 3 in the low
 * nibble. The size fields have to agree with each other before this
 * says yes, and `smolDecompress` re-checks by requiring the decode to
 * land exactly on `imageSize`.
 */
export function isSmol(bytes: Uint8Array, off: number): boolean {
  const h = readSmolHeader(bytes, off)
  if (h === null) return false
  if (h.mode < SMOL_MODE.BASE_ONLY || h.mode > SMOL_MODE.ENCODE_BOTH_DELTA_SYMS) return false
  if (h.imageSize === 0 || h.symSize === 0 || h.loSize === 0) return false
  if (h.imageSize > MAX_IMAGE_SIZE) return false
  // Every literal symbol emits at least one u16, and every instruction
  // costs at least two lo bytes while emitting at least one u16.
  if (h.symSize > h.imageSize / 2) return false
  if (h.loSize > h.imageSize) return false
  // BASE_ONLY has no bitstream; the entropy-coded modes must have one.
  const entropy = h.mode !== SMOL_MODE.BASE_ONLY
  if (entropy !== h.bitstreamSize > 0) return false
  // Size from the header already parsed — this runs inside the map
  // tileset sweep, where re-parsing it cost about a second per load.
  const size = sizeFromHeader(h)
  return size > 8 && off + size <= bytes.length && size <= h.imageSize + 64
}

/** No GBA graphics blob is anywhere near this large. */
const MAX_IMAGE_SIZE = 0x40000

function u32(bytes: Uint8Array, off: number): number {
  return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0
}

/* --------------------------------------------------------------- tANS */

/**
 * `sYkTemplate`, computed rather than transcribed.
 *
 * The expansion ships it as a 128-entry literal table, but every entry
 * follows one rule: for slot n, k is the smallest shift with
 * `n << k >= 64`, y is `(n << k) - 64` and the mask is `(1 << k) - 1`.
 * Checked against the shipped table at n = 1, 2, 3, 15, 16, 31, 32, 63,
 * 64, 65 and 78.
 */
const YK_TEMPLATE = buildYkTemplate()

function buildYkTemplate(): Int32Array {
  const out = new Int32Array(2 * TANS_TABLE_SIZE)
  for (let n = 1; n < out.length; n++) {
    let k = 0
    while (n << k < TANS_TABLE_SIZE) k++
    const y = (n << k) - TANS_TABLE_SIZE
    const mask = (1 << k) - 1
    out[n] = (k & 7) | (y << 8) | (mask << 16)
  }
  return out
}

/**
 * Unpack 16 symbol frequencies from three u32s: five 6-bit values each,
 * with the top two bits of every word contributing to frequency 15.
 */
function unpackFrequencies(bytes: Uint8Array, off: number): number[] {
  const freqs = new Array<number>(16).fill(0)
  for (let i = 0; i < 3; i++) {
    const word = u32(bytes, off + i * 4)
    for (let j = 0; j < 5; j++) freqs[i * 5 + j] = (word >>> (6 * j)) & PACKED_FREQ_MASK
    freqs[15] += (word & 0xc0000000) >>> (30 - 2 * i)
  }
  return freqs
}

/** Lay out the 64-entry decode table, symbol ids folded into each slot. */
function buildDecodeTable(bytes: Uint8Array, freqOff: number): Int32Array {
  const freqs = unpackFrequencies(bytes, freqOff)
  const table = new Int32Array(TANS_TABLE_SIZE)
  let at = 0
  for (let sym = 0; sym < 16; sym++) {
    const f = freqs[sym]
    for (let i = 0; i < f && at < TANS_TABLE_SIZE; i++) {
      table[at++] = YK_TEMPLATE[f + i] | (sym << 3)
    }
  }
  return table
}

/**
 * The shared bitstream cursor. LO and symbol data are decoded from one
 * stream in that order, carrying state and bit position across, so the
 * reader has to outlive a single call.
 */
class NibbleReader {
  private bits: number
  private bitIndex = 0
  private at: number

  constructor(
    private readonly bytes: Uint8Array,
    start: number,
    public state: number,
  ) {
    this.at = start
    this.bits = u32(bytes, start)
    this.at += 4
  }

  /** Decode one 4-bit symbol and advance the tANS state. */
  next(table: Int32Array): number {
    const entry = table[this.state]
    const sym = (entry >>> 3) & 0x1f
    const k = entry & 7
    this.state = ((entry >>> 8) & 0xff) + (((this.bits >>> this.bitIndex) & (entry >>> 16)) | 0)
    this.bitIndex += k
    if (this.bitIndex >= 32) {
      this.bits = u32(this.bytes, this.at)
      this.at += 4
      this.bitIndex -= 32
      // The value straddled the word boundary; add its high bits.
      if (this.bitIndex !== 0) {
        this.state += (this.bits & ((1 << this.bitIndex) - 1)) << (k - this.bitIndex)
      }
    }
    return sym
  }
}

/** `count` bytes, low nibble first. */
function decodeLo(reader: NibbleReader, table: Int32Array, count: number): Uint8Array {
  const out = new Uint8Array(count)
  for (let i = 0; i < count; i++) out[i] = reader.next(table) | (reader.next(table) << 4)
  return out
}

/**
 * `count` u16s, four nibbles each. When `delta` is set the nibbles are
 * a running sum mod 16 across the WHOLE stream, not per value.
 */
function decodeSyms(
  reader: NibbleReader,
  table: Int32Array,
  count: number,
  delta: boolean,
): Uint16Array {
  const out = new Uint16Array(count)
  let running = 0
  for (let i = 0; i < count; i++) {
    let value = 0
    for (let n = 0; n < 4; n++) {
      const sym = reader.next(table)
      if (delta) {
        running = (running + sym) & 0xf
        value |= running << (n * 4)
      } else {
        value |= sym << (n * 4)
      }
    }
    out[i] = value
  }
  return out
}

/* ----------------------------------------------------------- LZ layer */

/**
 * Replay the (length, offset) instructions against the literal stream.
 *
 * Both length and offset are 7-bit varints flagged by CONTINUE_BIT, and
 * every unit is a u16. `length == 0` means "copy `offset` literals";
 * otherwise one literal is emitted and then `length` u16s are copied
 * from `offset` units back — deliberately byte-by-byte, since the
 * source can overlap the destination (offset 1 is a run fill).
 */
function decodeInstructions(lo: Uint8Array, syms: Uint16Array, outBytes: number): Uint8Array | null {
  const out = new Uint16Array(outBytes / 2)
  let dest = 0
  let sym = 0
  let p = 0
  while (p < lo.length) {
    // The shortest instruction is two bytes; anything less is a
    // truncated stream, not a short last instruction.
    if (p + 2 > lo.length) return null
    let length: number
    let offset: number
    if (lo[p] & CONTINUE_BIT) {
      length = (lo[p] & FIRST_LO_MASK) | (lo[p + 1] << 7)
      offset = lo[p + 2] & FIRST_LO_MASK
      if (lo[p + 2] & CONTINUE_BIT) {
        offset |= lo[p + 3] << 7
        p += 4
      } else {
        p += 3
      }
    } else {
      length = lo[p] & FIRST_LO_MASK
      offset = lo[p + 1] & FIRST_LO_MASK
      if (lo[p + 1] & CONTINUE_BIT) {
        offset |= lo[p + 2] << 7
        p += 3
      } else {
        p += 2
      }
    }

    if (length !== 0) {
      // One literal then `length` copied units. Overrunning the output,
      // exhausting the literals, or referencing before the start of the
      // output all mean this was never a smol stream to begin with.
      if (dest + length + 1 > out.length || sym >= syms.length) return null
      out[dest++] = syms[sym++]
      const from = dest - offset
      if (from < 0) return null
      for (let i = 0; i < length; i++) out[dest + i] = out[from + i]
      dest += length
    } else {
      if (sym + offset > syms.length || dest + offset > out.length) return null
      for (let i = 0; i < offset; i++) out[dest++] = syms[sym++]
    }
  }
  // The instruction stream must account for exactly the declared size.
  if (dest !== out.length) return null
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength)
}

/* ------------------------------------------------------------ entry point */

/**
 * Decompress the `smol` stream at `off`. Returns null for a header this
 * module doesn't handle (LZ77, frame containers, tilemaps) or for data
 * that runs off the end of the ROM — callers disable the feature rather
 * than render whatever fell out.
 */
export function smolDecompress(bytes: Uint8Array, off = 0): Uint8Array | null {
  const header = readSmolHeader(bytes, off)
  if (header === null) return null
  const { mode, imageSize, symSize, loSize, bitstreamSize } = header
  if (mode < SMOL_MODE.BASE_ONLY || mode > SMOL_MODE.ENCODE_BOTH_DELTA_SYMS) return null
  // The game bails on these too rather than allocating a zero buffer.
  if (loSize === 0 || symSize === 0 || imageSize === 0) return null

  const data = off + 8
  if (data > bytes.length) return null

  if (mode === SMOL_MODE.BASE_ONLY) {
    const symOff = data
    const loOff = data + symSize * 2
    if (loOff + loSize > bytes.length) return null
    return decodeInstructions(
      bytes.subarray(loOff, loOff + loSize),
      readU16s(bytes, symOff, symSize),
      imageSize,
    )
  }

  const loEncoded = mode === SMOL_MODE.ENCODE_LO || mode === SMOL_MODE.ENCODE_BOTH || mode === SMOL_MODE.ENCODE_BOTH_DELTA_SYMS
  const symEncoded = mode !== SMOL_MODE.ENCODE_LO
  const symDelta = mode === SMOL_MODE.ENCODE_DELTA_SYMS || mode === SMOL_MODE.ENCODE_BOTH_DELTA_SYMS

  // Frequency tables come first, in lo-then-sym order, 12 bytes each;
  // the shared bitstream starts after them.
  let loFreqOff = -1
  let symFreqOff = -1
  let cursor = data
  if (loEncoded) {
    loFreqOff = cursor
    cursor += 12
  }
  if (symEncoded) {
    symFreqOff = cursor
    cursor += 12
  }
  const bitstream = cursor
  if (bitstream + 4 > bytes.length) return null

  const reader = new NibbleReader(bytes, bitstream, header.initialState)
  let lo: Uint8Array | null = null
  let syms: Uint16Array | null = null
  // Order matters: both streams share one cursor, and the game decodes
  // LO first.
  if (loEncoded) lo = decodeLo(reader, buildDecodeTable(bytes, loFreqOff), loSize)
  if (symEncoded) syms = decodeSyms(reader, buildDecodeTable(bytes, symFreqOff), symSize, symDelta)

  // Whichever stream wasn't entropy coded sits after the bitstream.
  let leftover = bitstream + 4 * bitstreamSize
  if (syms === null) {
    syms = readU16s(bytes, leftover, symSize)
    leftover += symSize * 2
  }
  if (lo === null) {
    if (leftover + loSize > bytes.length) return null
    lo = bytes.subarray(leftover, leftover + loSize)
  }
  return decodeInstructions(lo, syms, imageSize)
}

function readU16s(bytes: Uint8Array, off: number, count: number): Uint16Array {
  const out = new Uint16Array(count)
  for (let i = 0; i < count; i++) out[i] = bytes[off + i * 2] | (bytes[off + i * 2 + 1] << 8)
  return out
}

/** Byte length of the stream at `off`, for in-place rewrite checks. */
export function smolCompressedSize(bytes: Uint8Array, off = 0): number {
  const h = readSmolHeader(bytes, off)
  return h === null ? 0 : sizeFromHeader(h)
}

function sizeFromHeader(h: SmolHeader): number {
  if (h.mode === SMOL_MODE.BASE_ONLY) return 8 + h.symSize * 2 + h.loSize
  const loEncoded =
    h.mode === SMOL_MODE.ENCODE_LO || h.mode === SMOL_MODE.ENCODE_BOTH || h.mode === SMOL_MODE.ENCODE_BOTH_DELTA_SYMS
  const symEncoded = h.mode !== SMOL_MODE.ENCODE_LO
  let size = 8 + (loEncoded ? 12 : 0) + (symEncoded ? 12 : 0) + 4 * h.bitstreamSize
  if (!symEncoded) size += h.symSize * 2
  if (!loEncoded) size += h.loSize
  return size
}
