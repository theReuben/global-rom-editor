/**
 * BPS patch format (byuu's "beat"), the standard for modern ROM hacks.
 *
 * Layout: "BPS1", vlq(source size), vlq(target size), vlq(metadata
 * size) + metadata, then actions encoded as vlq((length-1)<<2 | cmd):
 *   0 SourceRead — copy from source at the output offset
 *   1 TargetRead — literal bytes follow in the patch
 *   2 SourceCopy — vlq signed relative offset into the source
 *   3 TargetCopy — vlq signed relative offset into already-written output
 * Footer: CRC32(source), CRC32(target), CRC32(patch minus these 4 bytes).
 *
 * The variable-length quantity is beat's: 7 data bits per byte, top bit
 * terminates, with an implicit +1 carry per continuation byte.
 * Signed numbers store the sign in bit 0.
 *
 * The encoder emits SourceRead for matching runs and TargetRead for
 * differing runs (with small unchanged gaps merged) — byte-identical
 * output to a full delta encoder isn't required for correctness, and
 * every consumer accepts it.
 */
import { crc32 } from './ups'

function writeVlq(out: number[], value: number): void {
  let v = value
  for (;;) {
    const x = v & 0x7f
    v = Math.floor(v / 128)
    if (v === 0) {
      out.push(0x80 | x)
      break
    }
    out.push(x)
    v -= 1
  }
}

class Reader {
  pos = 0
  constructor(private data: Uint8Array) {}
  byte(): number {
    if (this.pos >= this.data.length) throw new Error('BPS: unexpected end of patch')
    return this.data[this.pos++]
  }
  vlq(): number {
    let data = 0
    let shift = 1
    for (;;) {
      const x = this.byte()
      data += (x & 0x7f) * shift
      if (x & 0x80) break
      shift *= 128
      data += shift
    }
    return data
  }
}

export function isBps(patch: Uint8Array): boolean {
  return (
    patch.length > 19 &&
    patch[0] === 0x42 && patch[1] === 0x50 && patch[2] === 0x53 && patch[3] === 0x31
  )
}

/** Apply a BPS patch. Throws with a clear message on CRC mismatch. */
export function applyBps(source: Uint8Array, patch: Uint8Array): Uint8Array {
  if (!isBps(patch)) throw new Error('Not a BPS patch')
  const patchCrc = crc32(patch.subarray(0, patch.length - 4))
  const dv = new DataView(patch.buffer, patch.byteOffset)
  const storedPatchCrc = dv.getUint32(patch.length - 4, true)
  if (patchCrc !== storedPatchCrc) throw new Error('BPS: patch file is corrupted (CRC mismatch)')
  const storedSourceCrc = dv.getUint32(patch.length - 12, true)
  const storedTargetCrc = dv.getUint32(patch.length - 8, true)

  const r = new Reader(patch.subarray(0, patch.length - 12))
  r.pos = 4
  const sourceSize = r.vlq()
  const targetSize = r.vlq()
  const metaSize = r.vlq()
  r.pos += metaSize
  if (sourceSize !== source.length || crc32(source) !== storedSourceCrc) {
    throw new Error('BPS: this patch was made for a different ROM (source CRC mismatch)')
  }

  const out = new Uint8Array(targetSize)
  let outPos = 0
  let sourceRel = 0
  let targetRel = 0
  while (r.pos < patch.length - 12) {
    const data = r.vlq()
    const cmd = data & 3
    let len = (data >> 2) + 1
    if (cmd === 0) {
      while (len--) {
        out[outPos] = source[outPos]
        outPos++
      }
    } else if (cmd === 1) {
      while (len--) out[outPos++] = r.byte()
    } else if (cmd === 2) {
      const off = r.vlq()
      sourceRel += (off & 1 ? -1 : 1) * (off >> 1)
      while (len--) out[outPos++] = source[sourceRel++]
    } else {
      const off = r.vlq()
      targetRel += (off & 1 ? -1 : 1) * (off >> 1)
      while (len--) out[outPos++] = out[targetRel++]
    }
  }
  if (outPos !== targetSize) throw new Error('BPS: patch did not produce the expected size')
  if (crc32(out) !== storedTargetCrc) throw new Error('BPS: output CRC mismatch')
  return out
}

/** Build a BPS patch transforming `original` into `modified`. */
export function createBps(original: Uint8Array, modified: Uint8Array): Uint8Array {
  const head: number[] = [0x42, 0x50, 0x53, 0x31]
  writeVlq(head, original.length)
  writeVlq(head, modified.length)
  writeVlq(head, 0) // no metadata

  const body: number[] = []
  const common = Math.min(original.length, modified.length)
  let i = 0
  const emitSourceRead = (len: number) => {
    writeVlq(body, ((len - 1) << 2) | 0)
  }
  const emitTargetRead = (from: number, len: number) => {
    writeVlq(body, ((len - 1) << 2) | 1)
    for (let k = 0; k < len; k++) body.push(modified[from + k])
  }
  while (i < common) {
    if (original[i] === modified[i]) {
      let j = i
      while (j < common && original[j] === modified[j]) j++
      // Tiny matching gaps between edits cost more as their own action.
      if (j - i >= 4 || j === common) {
        emitSourceRead(j - i)
        i = j
        continue
      }
    }
    let j = i
    let gap = 0
    while (j < common && gap < 4) {
      if (original[j] === modified[j]) gap++
      else gap = 0
      j++
    }
    if (j < common) j -= gap
    emitTargetRead(i, j - i)
    i = j
  }
  if (modified.length > common) emitTargetRead(common, modified.length - common)

  const noCrc = new Uint8Array(head.length + body.length + 8)
  noCrc.set(head, 0)
  noCrc.set(body, head.length)
  const dv = new DataView(noCrc.buffer)
  dv.setUint32(head.length + body.length, crc32(original), true)
  dv.setUint32(head.length + body.length + 4, crc32(modified), true)
  const out = new Uint8Array(noCrc.length + 4)
  out.set(noCrc, 0)
  new DataView(out.buffer).setUint32(noCrc.length, crc32(noCrc), true)
  return out
}
