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
