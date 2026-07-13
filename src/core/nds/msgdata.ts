/**
 * Gen 4 (D/P/Pt/HGSS) message bank decoding.
 *
 * Each bank subfile: u16 entry count, u16 key, then per-entry
 * {u32 offset, u32 length} XOR-scrambled with key*765*(n+1), then the
 * u16 character streams XOR-scrambled with a rolling per-entry seed.
 * Verified against pret/pokeheartgold src/msgdata.c and
 * tools/msgenc/MessagesDecoder.cpp (D/P and Platinum use the same
 * scheme and character map).
 */
import { GEN4_CHARMAP } from '../games/gen4-charmap'
import type { Rom } from '../rom'

// Reverse map for encoding; first code wins where glyphs repeat.
let reverseMap: Map<string, number> | null = null
function charToCode(ch: string): number | undefined {
  if (!reverseMap) {
    reverseMap = new Map()
    for (const [code, c] of GEN4_CHARMAP) if (!reverseMap.has(c)) reverseMap.set(c, code)
  }
  return reverseMap.get(ch)
}

/** Decode one bank subfile into plain strings (control codes dropped). */
export function parseMsgBank(bytes: Uint8Array, start: number, length: number): string[] {
  const u16 = (o: number) => bytes[start + o] | (bytes[start + o + 1] << 8)
  if (length < 4) return []
  const count = u16(0)
  const key = u16(2)
  if (count === 0 || count > 20000 || 4 + count * 8 > length) return []

  const out: string[] = []
  for (let n = 0; n < count; n++) {
    let seed = (key * 765 * (n + 1)) & 0xffff
    seed = ((seed | (seed << 16)) & 0xffffffff) >>> 0
    const off = ((u16(4 + n * 8) | (u16(6 + n * 8) << 16)) ^ seed) >>> 0
    const len = ((u16(8 + n * 8) | (u16(10 + n * 8) << 16)) ^ seed) >>> 0
    if (off + len * 2 > length || len > 0x2000) {
      out.push('')
      continue
    }

    // Decrypt the character stream for this entry.
    const chars = new Uint16Array(len)
    let charSeed = ((n + 1) * 596947) & 0xffff
    for (let j = 0; j < len; j++) {
      chars[j] = (u16(off + j * 2) ^ charSeed) & 0xffff
      charSeed = (charSeed + 18749) & 0xffff
    }

    out.push(decodeChars(chars))
  }
  return out
}

/**
 * Rewrite one entry's text in place. The scrambling is XOR-symmetric
 * and every entry has a fixed allocation, so any text that fits the
 * original slot (in encoded u16s) can be written without moving a
 * byte — longer text is rejected. Handles both plain entries and the
 * 9-bit packed name coding (detected from the original first word).
 * Returns true on success.
 */
export function writeMsgEntry(
  rom: Rom,
  bankStart: number,
  bankLength: number,
  index: number,
  text: string,
): boolean {
  const bytes = rom.bytes
  const u16 = (o: number) => bytes[bankStart + o] | (bytes[bankStart + o + 1] << 8)
  if (bankLength < 4) return false
  const count = u16(0)
  const key = u16(2)
  if (index < 0 || index >= count) return false
  let seed = (key * 765 * (index + 1)) & 0xffff
  seed = ((seed | (seed << 16)) & 0xffffffff) >>> 0
  const off = ((u16(4 + index * 8) | (u16(6 + index * 8) << 16)) ^ seed) >>> 0
  const len = ((u16(8 + index * 8) | (u16(10 + index * 8) << 16)) ^ seed) >>> 0
  if (off + len * 2 > bankLength || len < 1 || len > 0x2000) return false

  const codes: number[] = []
  for (const ch of text) {
    const c = charToCode(ch)
    if (c === undefined) return false
    codes.push(c)
  }
  if (codes.length === 0) return false

  const seed0 = ((index + 1) * 596947) & 0xffff
  const packed = (u16(off) ^ seed0) === 0xf100

  // Build the plain (pre-scramble) u16 stream, padded to the exact
  // original length so nothing else in the bank moves.
  const words = new Uint16Array(len)
  if (packed) {
    for (const c of codes) if (c > 0x1ff) return false
    if (9 * (codes.length + 1) > 15 * (len - 1)) return false
    words[0] = 0xf100
    let acc = 0
    let bits = 0
    let w = 1
    for (const c of [...codes, 0x1ff]) {
      acc |= c << bits
      bits += 9
      if (bits >= 15) {
        words[w++] = acc & 0x7fff
        acc >>= 15
        bits -= 15
      }
    }
    if (bits > 0) words[w++] = acc & 0x7fff
  } else {
    if (codes.length + 1 > len) return false
    codes.forEach((c, i) => (words[i] = c))
    for (let i = codes.length; i < len; i++) words[i] = 0xffff
  }

  let charSeed = seed0
  for (let j = 0; j < len; j++) {
    rom.writeU16LE(bankStart + off + j * 2, (words[j] ^ charSeed) & 0xffff)
    charSeed = (charSeed + 18749) & 0xffff
  }
  return true
}

/**
 * Rebuild an entire msg bank with one entry re-encoded at whatever
 * length it needs (the growth path when `writeMsgEntry` rejects a
 * longer name). Other entries' encrypted character streams are copied
 * verbatim — the char scrambling depends only on the entry index, not
 * its offset — and the header offset/length words are re-scrambled for
 * the new layout. Returns the new bank buffer, or null on failure.
 */
export function rebuildMsgBank(
  bytes: Uint8Array,
  start: number,
  length: number,
  index: number,
  text: string,
): Uint8Array | null {
  const u16 = (o: number) => bytes[start + o] | (bytes[start + o + 1] << 8)
  if (length < 4) return null
  const count = u16(0)
  const key = u16(2)
  if (index < 0 || index >= count || 4 + count * 8 > length) return null

  const entrySeed = (n: number) => {
    let seed = (key * 765 * (n + 1)) & 0xffff
    return ((seed | (seed << 16)) & 0xffffffff) >>> 0
  }
  const streams: Uint16Array[] = []
  for (let n = 0; n < count; n++) {
    const seed = entrySeed(n)
    const off = ((u16(4 + n * 8) | (u16(6 + n * 8) << 16)) ^ seed) >>> 0
    const len = ((u16(8 + n * 8) | (u16(10 + n * 8) << 16)) ^ seed) >>> 0
    if (off + len * 2 > length || len > 0x2000) return null
    const s = new Uint16Array(len)
    for (let j = 0; j < len; j++) s[j] = u16(off + j * 2)
    streams.push(s)
  }

  // Encode the replacement entry (same plain/packed mode as before).
  const codes: number[] = []
  for (const ch of text) {
    const c = charToCode(ch)
    if (c === undefined) return null
    codes.push(c)
  }
  if (codes.length === 0) return null
  const seed0 = ((index + 1) * 596947) & 0xffff
  const packed = streams[index].length > 0 && ((streams[index][0] ^ seed0) & 0xffff) === 0xf100
  let words: number[]
  if (packed) {
    for (const c of codes) if (c > 0x1ff) return null
    words = [0xf100]
    let acc = 0
    let bits = 0
    for (const c of [...codes, 0x1ff]) {
      acc |= c << bits
      bits += 9
      if (bits >= 15) {
        words.push(acc & 0x7fff)
        acc >>= 15
        bits -= 15
      }
    }
    if (bits > 0) words.push(acc & 0x7fff)
  } else {
    words = [...codes, 0xffff]
  }
  const enc = new Uint16Array(words.length)
  let charSeed = seed0
  for (let j = 0; j < words.length; j++) {
    enc[j] = (words[j] ^ charSeed) & 0xffff
    charSeed = (charSeed + 18749) & 0xffff
  }
  streams[index] = enc

  const total = 4 + count * 8 + streams.reduce((a, s) => a + s.length * 2, 0)
  const out = new Uint8Array(total)
  const putU16 = (o: number, v: number) => {
    out[o] = v & 0xff
    out[o + 1] = (v >> 8) & 0xff
  }
  putU16(0, count)
  putU16(2, key)
  let off = 4 + count * 8
  for (let n = 0; n < count; n++) {
    const seed = entrySeed(n)
    const encOff = (off ^ seed) >>> 0
    const encLen = (streams[n].length ^ seed) >>> 0
    putU16(4 + n * 8, encOff & 0xffff)
    putU16(6 + n * 8, encOff >>> 16)
    putU16(8 + n * 8, encLen & 0xffff)
    putU16(10 + n * 8, encLen >>> 16)
    for (let j = 0; j < streams[n].length; j++) putU16(off + j * 2, streams[n][j])
    off += streams[n].length * 2
  }
  return out
}

function decodeChars(chars: Uint16Array): string {
  let s = ''
  let j = 0
  // 0xF100 switches to 9-bit packed characters (used by name banks).
  if (chars[0] === 0xf100) {
    const unpacked: number[] = []
    let bit = 0
    let p = 1
    for (;;) {
      if (p >= chars.length) break
      let c = (chars[p] >> bit) & 0x1ff
      bit += 9
      if (bit >= 15) {
        p++
        bit -= 15
        if (bit !== 0 && p < chars.length) c |= (chars[p] << (9 - bit)) & 0x1ff
      }
      if (c === 0x1ff) break
      unpacked.push(c)
    }
    for (const c of unpacked) s += GEN4_CHARMAP.get(c) ?? ''
    return s
  }
  while (j < chars.length) {
    const c = chars[j]
    if (c === 0xffff) break
    if (c === 0xfffe) {
      // Control sequence: command u16, arg count u16, then the args.
      const nargs = chars[j + 2] ?? 0
      j += 3 + nargs
      continue
    }
    s += GEN4_CHARMAP.get(c) ?? ''
    j++
  }
  return s
}
