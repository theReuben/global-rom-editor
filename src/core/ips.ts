/**
 * IPS patch support — the lingua franca of ROM hack distribution.
 *
 * Creating a patch of your edits lets you share a hack legally (patches
 * contain only your changes, never Nintendo's copyrighted data).
 */

const MAGIC = [0x50, 0x41, 0x54, 0x43, 0x48] // "PATCH"
const EOF_MARKER = 0x454f46 // "EOF" read as a 24-bit offset

/** Build an IPS patch containing the differences between two equal-length buffers. */
export function createIps(original: Uint8Array, modified: Uint8Array): Uint8Array {
  if (original.length !== modified.length) {
    throw new Error('IPS export requires the original and modified ROM to be the same size')
  }
  if (modified.length > 0x1000000) {
    throw new Error('IPS patches only support ROMs up to 16 MiB')
  }

  // Collect changed runs, merging runs separated by small unchanged gaps
  // to keep the record count down.
  const runs: { start: number; end: number }[] = []
  const MERGE_GAP = 6
  let i = 0
  while (i < modified.length) {
    if (original[i] === modified[i]) {
      i++
      continue
    }
    let end = i + 1
    let gap = 0
    while (end < modified.length && gap < MERGE_GAP) {
      if (original[end] !== modified[end]) gap = 0
      else gap++
      end++
    }
    end -= gap
    runs.push({ start: i, end })
    i = end
  }

  const out: number[] = [...MAGIC]
  for (const run of runs) {
    let start = run.start
    while (start < run.end) {
      let chunk = Math.min(run.end - start, 0xffff)
      // An offset that spells "EOF" would terminate the patch early;
      // shift the record back one byte to dodge it.
      let recordStart = start
      if (recordStart === EOF_MARKER) {
        recordStart--
        chunk = Math.min(run.end - recordStart, 0xffff)
      }
      out.push((recordStart >> 16) & 0xff, (recordStart >> 8) & 0xff, recordStart & 0xff)
      out.push((chunk >> 8) & 0xff, chunk & 0xff)
      for (let j = 0; j < chunk; j++) out.push(modified[recordStart + j])
      start = recordStart + chunk
    }
  }
  out.push(0x45, 0x4f, 0x46) // EOF
  return new Uint8Array(out)
}

/** Apply an IPS patch. Returns a new buffer (input is not modified). */
export function applyIps(rom: Uint8Array, patch: Uint8Array): Uint8Array {
  if (patch.length < 8 || !MAGIC.every((b, idx) => patch[idx] === b)) {
    throw new Error('Not a valid IPS patch (missing PATCH header)')
  }
  // First pass: compute output size (IPS may extend the file).
  let size = rom.length
  let p = 5
  while (p + 3 <= patch.length) {
    const off = (patch[p] << 16) | (patch[p + 1] << 8) | patch[p + 2]
    if (off === EOF_MARKER) break
    p += 3
    const len = (patch[p] << 8) | patch[p + 1]
    p += 2
    if (len === 0) {
      const rleLen = (patch[p] << 8) | patch[p + 1]
      p += 3
      size = Math.max(size, off + rleLen)
    } else {
      p += len
      size = Math.max(size, off + len)
    }
  }

  const out = new Uint8Array(size)
  out.set(rom)
  p = 5
  while (p + 3 <= patch.length) {
    const off = (patch[p] << 16) | (patch[p + 1] << 8) | patch[p + 2]
    if (off === EOF_MARKER) break
    p += 3
    const len = (patch[p] << 8) | patch[p + 1]
    p += 2
    if (len === 0) {
      const rleLen = (patch[p] << 8) | patch[p + 1]
      const value = patch[p + 2]
      p += 3
      out.fill(value, off, off + rleLen)
    } else {
      out.set(patch.subarray(p, p + len), off)
      p += len
    }
  }
  return out
}
