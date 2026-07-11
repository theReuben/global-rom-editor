/**
 * UPS patch format — like IPS, but no 16 MiB limit and CRC-protected,
 * which makes it the standard for sharing DS-sized hacks.
 *
 * Layout: "UPS1", uptr(input size), uptr(output size), then blocks of
 * [uptr(bytes to skip), XOR bytes…, 0x00] where the terminating zero
 * also advances the pointer; footer is CRC32(input), CRC32(output),
 * CRC32(patch minus its own CRC).
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function writeUptr(out: number[], value: number): void {
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

function readUptr(data: Uint8Array, pos: { p: number }): number {
  let value = 0
  let shift = 1
  for (;;) {
    const x = data[pos.p++]
    value += (x & 0x7f) * shift
    if (x & 0x80) break
    shift *= 128
    value += shift
  }
  return value
}

const MAGIC = [0x55, 0x50, 0x53, 0x31] // "UPS1"

export function isUps(patch: Uint8Array): boolean {
  return patch.length >= 4 && MAGIC.every((b, i) => patch[i] === b)
}

/** Build a UPS patch transforming `original` into `modified`. */
export function createUps(original: Uint8Array, modified: Uint8Array): Uint8Array {
  const out: number[] = [...MAGIC]
  writeUptr(out, original.length)
  writeUptr(out, modified.length)

  const max = Math.max(original.length, modified.length)
  const at = (buf: Uint8Array, i: number) => (i < buf.length ? buf[i] : 0)
  let pointer = 0
  let i = 0
  while (i < max) {
    if (at(original, i) === at(modified, i)) {
      i++
      continue
    }
    writeUptr(out, i - pointer)
    while (i < max && at(original, i) !== at(modified, i)) {
      out.push(at(original, i) ^ at(modified, i))
      i++
    }
    out.push(0)
    pointer = i + 1 // the terminator consumes one position
    i = pointer
  }

  const inCrc = crc32(original)
  const outCrc = crc32(modified)
  for (const crc of [inCrc, outCrc]) {
    out.push(crc & 0xff, (crc >>> 8) & 0xff, (crc >>> 16) & 0xff, (crc >>> 24) & 0xff)
  }
  const patchCrc = crc32(Uint8Array.from(out))
  out.push(patchCrc & 0xff, (patchCrc >>> 8) & 0xff, (patchCrc >>> 16) & 0xff, (patchCrc >>> 24) & 0xff)
  return Uint8Array.from(out)
}

function readCrc(data: Uint8Array, off: number): number {
  return (data[off] | (data[off + 1] << 8) | (data[off + 2] << 16) | (data[off + 3] << 24)) >>> 0
}

/** Apply a UPS patch. Throws on malformed data or CRC mismatch. */
export function applyUps(rom: Uint8Array, patch: Uint8Array): Uint8Array {
  if (!isUps(patch) || patch.length < 4 + 12) throw new Error('Not a valid UPS patch')
  const patchCrc = readCrc(patch, patch.length - 4)
  if (crc32(patch.subarray(0, patch.length - 4)) !== patchCrc) {
    throw new Error('UPS patch is corrupted (patch CRC mismatch)')
  }
  const inCrc = readCrc(patch, patch.length - 12)
  const outCrc = readCrc(patch, patch.length - 8)

  const pos = { p: 4 }
  const inSize = readUptr(patch, pos)
  const outSize = readUptr(patch, pos)
  if (rom.length !== inSize) {
    throw new Error(
      `This patch expects a ${inSize.toLocaleString()}-byte ROM, but yours is ${rom.length.toLocaleString()} bytes`,
    )
  }
  if (crc32(rom) !== inCrc) {
    throw new Error("This patch was made for a different ROM (input CRC doesn't match)")
  }

  const out = new Uint8Array(outSize)
  out.set(rom.subarray(0, Math.min(rom.length, outSize)))
  let pointer = 0
  const end = patch.length - 12
  while (pos.p < end) {
    pointer += readUptr(patch, pos)
    while (pos.p < end) {
      const x = patch[pos.p++]
      if (x === 0) break
      if (pointer < outSize) out[pointer] = (pointer < rom.length ? rom[pointer] : 0) ^ x
      pointer++
    }
    pointer++ // terminator consumes one position
  }

  if (crc32(out) !== outCrc) throw new Error('Patched ROM failed its CRC check')
  return out
}
