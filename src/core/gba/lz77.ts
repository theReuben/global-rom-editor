/**
 * GBA BIOS-compatible LZ77 (type 0x10) compression.
 *
 * Nearly all Gen 3 graphics — tilesets, sprites, UI — are stored in this
 * format, so it is the gateway to map rendering and sprite editing.
 */

/** Decompress a type-0x10 LZ77 stream starting at `off`. */
export function lz77Decompress(data: Uint8Array, off = 0): Uint8Array {
  if (data[off] !== 0x10) throw new Error('Not an LZ77 (type 0x10) stream')
  const size = data[off + 1] | (data[off + 2] << 8) | (data[off + 3] << 16)
  const out = new Uint8Array(size)
  let src = off + 4
  let dst = 0
  while (dst < size) {
    if (src >= data.length) throw new Error('LZ77 stream truncated')
    const flags = data[src++]
    for (let bit = 7; bit >= 0 && dst < size; bit--) {
      if ((flags >> bit) & 1) {
        const b1 = data[src++]
        const b2 = data[src++]
        const len = (b1 >> 4) + 3
        const disp = (((b1 & 0x0f) << 8) | b2) + 1
        if (disp > dst) throw new Error('LZ77 back-reference out of range')
        for (let i = 0; i < len && dst < size; i++) {
          out[dst] = out[dst - disp]
          dst++
        }
      } else {
        out[dst++] = data[src++]
      }
    }
  }
  return out
}

/** Size in bytes the compressed stream occupies in the ROM (header included). */
export function lz77CompressedSize(data: Uint8Array, off = 0): number {
  if (data[off] !== 0x10) throw new Error('Not an LZ77 (type 0x10) stream')
  const size = data[off + 1] | (data[off + 2] << 8) | (data[off + 3] << 16)
  let src = off + 4
  let dst = 0
  while (dst < size) {
    const flags = data[src++]
    for (let bit = 7; bit >= 0 && dst < size; bit--) {
      if ((flags >> bit) & 1) {
        dst += (data[src] >> 4) + 3
        src += 2
      } else {
        src++
        dst++
      }
    }
  }
  return src - off
}

/**
 * Compress with greedy longest-match search (matches what the games can
 * decompress; output size is comparable to the original tooling).
 */
export function lz77Compress(data: Uint8Array): Uint8Array {
  if (data.length > 0xffffff) throw new Error('LZ77 payload too large')
  const out: number[] = [0x10, data.length & 0xff, (data.length >> 8) & 0xff, (data.length >> 16) & 0xff]
  let pos = 0
  while (pos < data.length) {
    const flagIndex = out.length
    out.push(0)
    let flags = 0
    for (let bit = 7; bit >= 0 && pos < data.length; bit--) {
      // Longest match in the previous 4096 bytes, length 3..18.
      let bestLen = 0
      let bestDisp = 0
      const windowStart = Math.max(0, pos - 4096)
      const maxLen = Math.min(18, data.length - pos)
      for (let cand = pos - 1; cand >= windowStart; cand--) {
        let len = 0
        while (len < maxLen && data[cand + len] === data[pos + len]) len++
        if (len > bestLen) {
          bestLen = len
          bestDisp = pos - cand
          if (len === maxLen) break
        }
      }
      if (bestLen >= 3) {
        flags |= 1 << bit
        const d = bestDisp - 1
        out.push(((bestLen - 3) << 4) | (d >> 8), d & 0xff)
        pos += bestLen
      } else {
        out.push(data[pos++])
      }
    }
    out[flagIndex] = flags
  }
  while (out.length % 4 !== 0) out.push(0) // GBA streams are 4-byte padded
  return Uint8Array.from(out)
}
