/**
 * Gen 3 wild encounter tables (gWildMonHeaders), struct layout per the
 * pret decomps:
 *
 *   header entry (20 bytes): bank u8, map u8, pad u16,
 *     4 pointers (grass / surf / rock smash / fishing), each may be 0
 *   group: encounterRate u8, pad u8[3], pointer to slots
 *   slot (4 bytes): minLevel u8, maxLevel u8, species u16
 *
 * Discovery is structural and cross-checked against the maps found by
 * the map scanner: a candidate table must be a run of entries whose
 * (bank, map) pairs all exist in the discovered map index, ending with
 * the 0xFF,0xFF terminator.
 */
import type { Rom } from '../rom'
import { toTitleCase } from '../text'
import type { WildGroup, WildModule } from '../games/schema'
import { readGbaPointer } from '../freespace'

const ENTRY = 20
const GROUPS = [
  { name: 'Grass / cave', slots: 12 },
  { name: 'Surfing', slots: 5 },
  { name: 'Rock Smash', slots: 5 },
  { name: 'Fishing', slots: 10 },
]
const MAX_ENTRIES = 400

function u32(bytes: Uint8Array, off: number): number {
  return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0
}

function groupValid(bytes: Uint8Array, gPtr: number, slots: number): boolean {
  if (gPtr + 8 > bytes.length) return false
  const mons = readGbaPointer(bytes, gPtr + 4)
  if (mons === null || mons + slots * 4 > bytes.length) return false
  for (let i = 0; i < slots; i++) {
    const o = mons + i * 4
    const min = bytes[o]
    const max = bytes[o + 1]
    const species = bytes[o + 2] | (bytes[o + 3] << 8)
    if (min < 1 || min > 200 || max < min || max > 200) return false
    if (species > 2000) return false
  }
  return true
}

function entryValid(bytes: Uint8Array, o: number, mapKeys: Set<string>): boolean {
  if (o + ENTRY > bytes.length) return false
  if (!mapKeys.has(`${bytes[o]}.${bytes[o + 1]}`)) return false
  if (bytes[o + 2] !== 0 || bytes[o + 3] !== 0) return false
  let nonZero = 0
  for (let g = 0; g < 4; g++) {
    const raw = u32(bytes, o + 4 + g * 4)
    if (raw === 0) continue
    const gPtr = readGbaPointer(bytes, o + 4 + g * 4)
    if (gPtr === null || !groupValid(bytes, gPtr, GROUPS[g].slots)) return false
    nonZero++
  }
  return nonZero >= 1
}

export function findWildTable(
  bytes: Uint8Array,
  mapKeys: Set<string>,
): { offset: number; count: number } | null {
  for (let o = 0; o + ENTRY <= bytes.length; o += 4) {
    if (!entryValid(bytes, o, mapKeys)) continue
    // Walk the run to the 0xFF,0xFF terminator.
    let count = 0
    let p = o
    while (count < MAX_ENTRIES && entryValid(bytes, p, mapKeys)) {
      count++
      p += ENTRY
    }
    const terminated = bytes[p] === 0xff && bytes[p + 1] === 0xff
    if (terminated && count >= 2) return { offset: o, count }
    // Not a real table — skip past this false positive.
  }
  return null
}

export function buildWildModule(
  rom: Rom,
  mapKeys: Set<string>,
  /** Area name for a map key, so entries read as more than "Map 0.16". */
  mapName?: (key: string) => string | undefined,
): { module: WildModule; offset: number; count: number } | null {
  const bytes = rom.bytes
  const table = findWildTable(bytes, mapKeys)
  if (!table) return null
  const { offset, count } = table

  const entryByKey = new Map<string, number>()
  const entries: { key: string; label: string }[] = []
  for (let i = 0; i < count; i++) {
    const o = offset + i * ENTRY
    const key = `${bytes[o]}.${bytes[o + 1]}`
    if (entryByKey.has(key)) continue
    entryByKey.set(key, o)
    const area = mapName?.(key)
    entries.push({ key, label: area ? `${key} — ${toTitleCase(area)}` : `Map ${key}` })
  }

  const groupPtr = (key: string, g: number): number | null => {
    const o = entryByKey.get(key)
    if (o === undefined || u32(bytes, o + 4 + g * 4) === 0) return null
    return readGbaPointer(bytes, o + 4 + g * 4)
  }

  const module: WildModule = {
    entries,

    groups(key): WildGroup[] {
      const out: WildGroup[] = []
      GROUPS.forEach((spec, g) => {
        const gPtr = groupPtr(key, g)
        if (gPtr === null) return
        const mons = readGbaPointer(bytes, gPtr + 4)!
        const slots = []
        for (let i = 0; i < spec.slots; i++) {
          const o = mons + i * 4
          slots.push({
            minLevel: bytes[o],
            maxLevel: bytes[o + 1],
            species: bytes[o + 2] | (bytes[o + 3] << 8),
          })
        }
        out.push({ name: spec.name, rate: bytes[gPtr], slots })
      })
      return out
    },

    setRate(key, group, rate) {
      // `group` indexes the *present* groups, matching groups() output.
      let seen = -1
      for (let g = 0; g < 4; g++) {
        const gPtr = groupPtr(key, g)
        if (gPtr === null) continue
        if (++seen === group) {
          rom.writeU8(gPtr, rate)
          return
        }
      }
    },

    setSlot(key, group, slot, field, value) {
      let seen = -1
      for (let g = 0; g < 4; g++) {
        const gPtr = groupPtr(key, g)
        if (gPtr === null) continue
        if (++seen !== group) continue
        if (slot < 0 || slot >= GROUPS[g].slots) return
        const mons = readGbaPointer(bytes, gPtr + 4)!
        const o = mons + slot * 4
        if (field === 'minLevel') rom.writeU8(o, value)
        else if (field === 'maxLevel') rom.writeU8(o + 1, value)
        else if (field === 'species') rom.writeU16LE(o + 2, value)
        return
      }
    },

    revert(key) {
      for (let g = 0; g < 4; g++) {
        const gPtr = groupPtr(key, g)
        if (gPtr === null) continue
        rom.revertRange(gPtr, 1)
        const mons = readGbaPointer(bytes, gPtr + 4)!
        rom.revertRange(mons, GROUPS[g].slots * 4)
      }
    },
  }
  return { module, offset, count }
}
