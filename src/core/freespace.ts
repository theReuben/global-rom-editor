/**
 * Free-space management and repointing — the machinery behind "custom":
 * custom areas, longer scripts, bigger learnsets. New data that outgrows
 * its original footprint is written into unused ROM space, and every
 * pointer to the old location is retargeted.
 */
import type { Rom } from './rom'

export const GBA_ROM_BASE = 0x08000000

/**
 * Find `length` bytes of free space (a run of `fill` bytes, 0xFF on GBA).
 * Search starts at `from` (skip the first MB-ish to stay clear of code),
 * result is aligned to `align`.
 */
export function findFreeSpace(
  bytes: Uint8Array,
  length: number,
  { fill = 0xff, align = 4, from = 0 }: { fill?: number; align?: number; from?: number } = {},
): number | null {
  let run = 0
  for (let i = from; i < bytes.length; i++) {
    if (bytes[i] === fill) {
      run++
      if (run >= length + align) {
        // Leave one leading fill byte so we never touch a preceding
        // table's terminator, then align.
        const start = i - run + 2
        const aligned = Math.ceil(start / align) * align
        if (aligned + length <= i + 1) return aligned
      }
    } else {
      run = 0
    }
  }
  return null
}

/**
 * Allocate from the ROM's trailing padding — the large 0xFF fill at the
 * end of every GBA ROM. This is the safest free space: unlike interior
 * 0xFF runs it can never be a table of legitimate 0xFF values.
 * Allocations advance past earlier writes automatically because written
 * bytes are no longer 0xFF.
 */
export function findFreeSpaceAtEnd(bytes: Uint8Array, length: number, align = 4): number | null {
  let start = bytes.length
  while (start > 0 && bytes[start - 1] === 0xff) start--
  start += 16 // margin after the last data byte
  const aligned = Math.ceil(start / align) * align
  return aligned + length <= bytes.length ? aligned : null
}

/** Read a GBA ROM pointer (little-endian u32 minus 0x08000000). */
export function readGbaPointer(bytes: Uint8Array, off: number): number | null {
  const v =
    (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0
  if (v < GBA_ROM_BASE || v >= GBA_ROM_BASE + bytes.length) return null
  return v - GBA_ROM_BASE
}

export function writeGbaPointer(rom: Rom, off: number, target: number): void {
  const v = (target + GBA_ROM_BASE) >>> 0
  rom.writeU8(off, v & 0xff)
  rom.writeU8(off + 1, (v >> 8) & 0xff)
  rom.writeU8(off + 2, (v >> 16) & 0xff)
  rom.writeU8(off + 3, (v >> 24) & 0xff)
}

/** Every 4-aligned location whose u32 points at `target` (GBA convention). */
export function findGbaPointerRefs(bytes: Uint8Array, target: number, limit = 64): number[] {
  const want = (target + GBA_ROM_BASE) >>> 0
  const b0 = want & 0xff
  const b1 = (want >> 8) & 0xff
  const b2 = (want >> 16) & 0xff
  const b3 = (want >> 24) & 0xff
  const refs: number[] = []
  for (let i = 0; i + 3 < bytes.length; i += 4) {
    if (bytes[i] === b0 && bytes[i + 1] === b1 && bytes[i + 2] === b2 && bytes[i + 3] === b3) {
      refs.push(i)
      if (refs.length >= limit) break
    }
  }
  return refs
}

/**
 * Move a block of data to free space and retarget every pointer to it.
 * Returns the new offset, or null if no free space was found. The old
 * copy is wiped to the fill byte so the space becomes reusable.
 */
export function relocate(
  rom: Rom,
  oldOffset: number,
  oldLength: number,
  newData: Uint8Array,
  opts: { fill?: number; from?: number } = {},
): number | null {
  const fill = opts.fill ?? 0xff
  const dest =
    findFreeSpaceAtEnd(rom.bytes, newData.length) ??
    findFreeSpace(rom.bytes, newData.length, { fill, from: opts.from ?? 0 })
  if (dest === null) return null
  const refs = findGbaPointerRefs(rom.bytes, oldOffset)
  rom.writeBytes(dest, newData)
  for (const ref of refs) writeGbaPointer(rom, ref, dest)
  for (let i = 0; i < oldLength; i++) rom.writeU8(oldOffset + i, fill)
  return dest
}

/**
 * Free space inside one Game Boy bank (0x4000 window): the trailing
 * run of 0x00 or 0xFF padding at the end of the bank. GB data is
 * addressed bank-locally, so relocated tables must stay in their bank.
 */
export function findGbBankFreeSpace(bytes: Uint8Array, bank: number, length: number): number | null {
  const end = Math.min((bank + 1) * 0x4000, bytes.length)
  const fill = bytes[end - 1]
  if (fill !== 0x00 && fill !== 0xff) return null
  let start = end
  while (start > bank * 0x4000 && bytes[start - 1] === fill) start--
  start += 8 // margin after the last data byte
  return end - start >= length ? start : null
}
