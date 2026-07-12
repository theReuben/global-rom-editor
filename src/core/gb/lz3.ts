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
 * Byte length of the compressed stream at `off`, including the 0xFF
 * terminator. Throws if the stream doesn't terminate.
 */
export function lz3CompressedLength(data: Uint8Array, off: number): number {
  let p = off
  while (p < data.length) {
    const b = data[p++]
    if (b === LZ_END) return p - off
    let cmd = b >> 5
    let len: number
    if (cmd === 7) {
      cmd = (b >> 2) & 7
      len = (((b & 3) << 8) | data[p++]) + 1
    } else {
      len = (b & 0x1f) + 1
    }
    if (cmd === 0) p += len
    else if (cmd === 1) p += 1
    else if (cmd === 2) p += 2
    else if (cmd === 3) { /* zero-fill: no payload */ }
    else p += data[p] & 0x80 ? 1 : 2
  }
  throw new Error('lz3: no terminator')
}

/**
 * Compress `data` into a valid lz3 stream (literal / iterate / zero /
 * repeat commands). Not byte-identical to the game compressor's output
 * — it doesn't need to be, the game only ever decompresses — but every
 * stream round-trips through lz3Decompress byte-exactly.
 */
export function lz3Compress(data: Uint8Array): Uint8Array {
  const out: number[] = []
  const cmdHeader = (cmd: number, len: number) => {
    if (len <= 32) out.push((cmd << 5) | (len - 1))
    else out.push(0xe0 | (cmd << 2) | ((len - 1) >> 8), (len - 1) & 0xff)
  }
  const MAX_LEN = 1024
  let literal: number[] = []
  const flushLiteral = () => {
    let i = 0
    while (i < literal.length) {
      const chunk = Math.min(MAX_LEN, literal.length - i)
      cmdHeader(0, chunk)
      for (let k = 0; k < chunk; k++) out.push(literal[i + k])
      i += chunk
    }
    literal = []
  }

  let p = 0
  while (p < data.length) {
    // Zero-fill / iterate runs.
    let run = 1
    while (p + run < data.length && data[p + run] === data[p] && run < MAX_LEN) run++
    if (run >= 3) {
      flushLiteral()
      if (data[p] === 0) cmdHeader(3, run)
      else {
        cmdHeader(1, run)
        out.push(data[p])
      }
      p += run
      continue
    }
    // Back-reference into what's already been produced (15-bit
    // absolute offsets from the output start).
    let bestLen = 0
    let bestSrc = 0
    const windowStart = Math.max(0, p - 0x7fff)
    for (let s = windowStart; s < p; s++) {
      if (data[s] !== data[p]) continue
      let l = 0
      while (p + l < data.length && data[s + l] === data[p + l] && l < MAX_LEN) l++
      if (l > bestLen) {
        bestLen = l
        bestSrc = s
      }
    }
    if (bestLen >= 4 && bestSrc <= 0x7fff) {
      flushLiteral()
      cmdHeader(4, bestLen)
      out.push((bestSrc >> 8) & 0x7f, bestSrc & 0xff)
      p += bestLen
      continue
    }
    literal.push(data[p++])
  }
  flushLiteral()
  out.push(LZ_END)
  return Uint8Array.from(out)
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
