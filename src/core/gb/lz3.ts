/**
 * The GSC "lz3" decompressor, byte-for-byte from pokecrystal
 * home/decompress.asm. Tileset graphics (and most other Gen 2
 * graphics) are stored in this format.
 *
 * Commands live in the top 3 bits, length-1 in the low 5 (LZ_LONG
 * expands the count to 10 bits). Rewrite commands take an offset:
 * positive = 15-bit big-endian from the output start, negative
 * (bit 7 set) = 7-bit back from the current position minus one.
 */

const LZ_END = 0xff
const MAX_OUT = 0x20000

function bitflip(b: number): number {
  b = ((b & 0xf0) >> 4) | ((b & 0x0f) << 4)
  b = ((b & 0xcc) >> 2) | ((b & 0x33) << 2)
  return ((b & 0xaa) >> 1) | ((b & 0x55) << 1)
}

/**
 * Like lz3Decompress but returns null unless the stream ends with a
 * proper LZ_END terminator — random data (zero-filled banks especially)
 * "decompresses" by running off the end, so termination is the strong
 * signal for content-validated discovery.
 */
export function lz3TryDecompress(data: Uint8Array, off: number, maxOut = MAX_OUT): Uint8Array | null {
  try {
    return lz3Decompress(data, off, true, maxOut)
  } catch {
    return null
  }
}

export function lz3Decompress(data: Uint8Array, off: number, strict = false, maxOut = MAX_OUT): Uint8Array {
  let terminated = false
  const out: number[] = []
  let p = off
  while (p < data.length) {
    const b = data[p++]
    if (b === LZ_END) {
      terminated = true
      break
    }
    let cmd = b >> 5
    let len: number
    if (cmd === 7) {
      // LZ_LONG: real command in bits 2-4, 10-bit length.
      cmd = (b >> 2) & 7
      len = (((b & 3) << 8) | data[p++]) + 1
    } else {
      len = (b & 0x1f) + 1
    }
    switch (cmd) {
      case 0: // literal
        for (let i = 0; i < len; i++) out.push(data[p++])
        break
      case 1: {
        // iterate
        const v = data[p++]
        for (let i = 0; i < len; i++) out.push(v)
        break
      }
      case 2: {
        // alternate
        const a = data[p++]
        const c = data[p++]
        for (let i = 0; i < len; i++) out.push(i & 1 ? c : a)
        break
      }
      case 3: // zero-fill
        for (let i = 0; i < len; i++) out.push(0)
        break
      default: {
        // repeat / flip / reverse from already-decompressed output
        const o1 = data[p++]
        const src = o1 & 0x80 ? out.length - (o1 & 0x7f) - 1 : (o1 << 8) | data[p++]
        if (src < 0) {
          if (strict) throw new Error('lz3: bad back-reference')
          return Uint8Array.from(out)
        }
        if (cmd === 4) for (let i = 0; i < len; i++) out.push(out[src + i] ?? 0)
        else if (cmd === 5) for (let i = 0; i < len; i++) out.push(bitflip(out[src + i] ?? 0))
        else for (let i = 0; i < len; i++) out.push(out[src - i] ?? 0)
      }
    }
    if (out.length > maxOut) break
  }
  if (strict && !terminated) throw new Error('lz3: no terminator')
  return Uint8Array.from(out)
}
