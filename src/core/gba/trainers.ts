/**
 * Gen 3 trainer table — 40-byte entries, struct layout documented by the
 * pret decompilation projects (pokeemerald/pokefirered):
 *
 *   +0  partyFlags (bit0 custom moves, bit1 held items)
 *   +1  trainerClass   +2 encounterMusic/gender   +3 trainerPic
 *   +4  name (11 chars + 0xFF, 12 bytes)
 *   +16 items[4] (u16 each)
 *   +24 doubleBattle (u32 0/1)   +28 aiFlags (u32)
 *   +32 partySize (u32 1-6)      +36 party pointer
 *
 * Party entries are 8 bytes (16 with custom moves): iv u16, level u16,
 * species u16, then held item u16 / moves u16[4] depending on flags.
 *
 * The table is discovered structurally: we collect every offset that
 * validates as a *strong* trainer entry (sane flags, decodable name,
 * valid party behind the pointer), find the dominant 40-byte alignment,
 * and take the contiguous table around it.
 */
import type { Rom } from '../rom'
import type { EntryHandle, PartyMon, SelectOption, TrainerModule } from '../games/schema'
import { readGbaPointer } from '../freespace'
import { findAll } from '../scan'
import { gen3Bytes, gen3Codec } from '../text'

const ENTRY = 40
const NAME_LEN = 12
const MIN_STRONG = 40
const MAX_TRAINERS = 1200

function u16(bytes: Uint8Array, off: number): number {
  return bytes[off] | (bytes[off + 1] << 8)
}
function u32(bytes: Uint8Array, off: number): number {
  return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0
}

function partyEntrySize(flags: number): number {
  return (flags & 1) === 1 ? 16 : 8
}

function looseValid(bytes: Uint8Array, o: number): boolean {
  if (o < 0 || o + ENTRY > bytes.length) return false
  if (bytes[o] > 3) return false
  if (u32(bytes, o + 24) > 1) return false
  const size = u32(bytes, o + 32)
  if (size > 6) return false
  const ptr = readGbaPointer(bytes, o + 36)
  if (ptr === null && !(u32(bytes, o + 36) === 0 && size === 0)) return false
  return true
}

function partyValid(bytes: Uint8Array, ptr: number, flags: number, size: number): boolean {
  const ent = partyEntrySize(flags)
  if (ptr + size * ent > bytes.length) return false
  for (let i = 0; i < size; i++) {
    const o = ptr + i * ent
    const lvl = u16(bytes, o + 2)
    if (lvl < 1 || lvl > 100) return false
    const species = u16(bytes, o + 4)
    if (species < 1 || species > 2000) return false
    if ((flags & 2) === 2 && u16(bytes, o + 6) > 2000) return false
    if ((flags & 1) === 1) {
      const movesOff = o + ((flags & 2) === 2 ? 8 : 6)
      for (let m = 0; m < 4; m++) if (u16(bytes, movesOff + m * 2) > 2000) return false
    }
  }
  return true
}

function strongValid(bytes: Uint8Array, o: number): boolean {
  if (!looseValid(bytes, o)) return false
  const size = u32(bytes, o + 32)
  if (size < 1) return false
  const ptr = readGbaPointer(bytes, o + 36)
  if (ptr === null) return false
  // Name must start with a printable Gen 3 character and terminate.
  const first = bytes[o + 4]
  if (first < 0xa1 || first > 0xee) return false
  let terminated = false
  for (let i = 0; i < NAME_LEN; i++) if (bytes[o + 4 + i] === 0xff) terminated = true
  if (!terminated) return false
  return partyValid(bytes, ptr, bytes[o], size)
}

/* --------------------------------------------------- trainer class names */

const CLASS_NAME_LEN = 13

function validClassName(bytes: Uint8Array, off: number): string | null {
  if (off < 0 || off + CLASS_NAME_LEN > bytes.length) return null
  const slice = bytes.subarray(off, off + CLASS_NAME_LEN)
  if (!slice.includes(0xff)) return null
  const name = gen3Codec.decode(slice)
  if (name.length < 2 || name.length > 13 || name.includes('?')) return null
  return name
}

/**
 * gTrainerClassNames: an array of 13-byte strings. Anchored on
 * "BUG CATCHER" (present in every Gen 3 game), then the run is walked in
 * both directions and sanity-checked against other universal classes.
 */
export function findTrainerClassNames(bytes: Uint8Array): SelectOption[] | null {
  const anchors = findAll(bytes, [...gen3Bytes('BUG CATCHER'), 0xff], 8)
  let best: SelectOption[] | null = null
  for (const anchor of anchors) {
    let start = anchor
    while (validClassName(bytes, start - CLASS_NAME_LEN) !== null) start -= CLASS_NAME_LEN
    let end = anchor
    while (validClassName(bytes, end + CLASS_NAME_LEN) !== null) end += CLASS_NAME_LEN
    const count = (end - start) / CLASS_NAME_LEN + 1
    if (count < 20 || count > 130) continue
    const options: SelectOption[] = []
    for (let i = 0; i < count; i++) {
      options.push({ value: i, label: validClassName(bytes, start + i * CLASS_NAME_LEN)! })
    }
    const labels = options.map((o) => o.label)
    if (!labels.includes('YOUNGSTER') || !labels.includes('LASS')) continue
    if (!best || options.length > best.length) best = options
  }
  return best
}

function isZeroEntry(bytes: Uint8Array, o: number): boolean {
  for (let i = 0; i < ENTRY; i++) if (bytes[o + i] !== 0) return false
  return true
}

export function findTrainerTable(bytes: Uint8Array): { offset: number; count: number } | null {
  // Dominant 40-byte alignment among strong entries.
  const byResidue = new Map<number, number[]>()
  for (let o = 0; o + ENTRY <= bytes.length; o += 4) {
    if (!strongValid(bytes, o)) continue
    const r = o % ENTRY
    if (!byResidue.has(r)) byResidue.set(r, [])
    byResidue.get(r)!.push(o)
  }
  let best: number[] | null = null
  for (const offsets of byResidue.values()) {
    if (offsets.length >= MIN_STRONG && (!best || offsets.length > best.length)) best = offsets
  }
  if (!best) return null

  // The table spans from the first to the last strong entry; the span is
  // anchored to strong entries so surrounding zero-fill can't inflate it,
  // but a single all-zero entry before the first strong one is kept — the
  // games' trainer 0 is a blank dummy. Every entry in between must at
  // least loose-validate; truncate at the first that doesn't.
  let start = best[0]
  if (isZeroEntry(bytes, start - ENTRY) && looseValid(bytes, start - ENTRY)) start -= ENTRY
  const last = best[best.length - 1]
  let count = 0
  const span = Math.min((last - start) / ENTRY + 1, MAX_TRAINERS)
  while (count < span && looseValid(bytes, start + count * ENTRY)) count++
  return count >= MIN_STRONG ? { offset: start, count } : null
}

export function buildTrainerModule(rom: Rom): { module: TrainerModule; offset: number; count: number } | null {
  const bytes = rom.bytes
  const table = findTrainerTable(bytes)
  if (!table) return null
  const { offset, count } = table

  const base = (id: number) => offset + id * ENTRY
  const readName = (id: number) => gen3Codec.decode(bytes.subarray(base(id) + 4, base(id) + 4 + NAME_LEN))
  const label = (id: number) => {
    const n = readName(id).trim()
    return `#${String(id).padStart(3, '0')} ${n || '(unused)'}`
  }

  const entries: EntryHandle[] = []
  for (let i = 0; i < count; i++) entries.push({ id: i, label: label(i), name: readName(i) })

  const partyInfo = (id: number) => {
    const o = base(id)
    return {
      flags: bytes[o],
      size: u32(bytes, o + 32),
      ptr: readGbaPointer(bytes, o + 36),
      entrySize: partyEntrySize(bytes[o]),
    }
  }

  const refresh = (id: number) => {
    entries[id].name = readName(id)
    entries[id].label = label(id)
  }

  const FIELD_BYTES: Record<string, { off: number; size: 1 | 4 }> = {
    trainerClass: { off: 1, size: 1 },
    pic: { off: 3, size: 1 },
    doubleBattle: { off: 24, size: 4 },
    aiFlags: { off: 28, size: 4 },
  }

  const module: TrainerModule = {
    entries,
    nameLength: NAME_LEN - 1,
    classOptions: findTrainerClassNames(bytes),

    read(id) {
      const o = base(id)
      const { size } = partyInfo(id)
      return {
        name: readName(id),
        trainerClass: bytes[o + 1],
        music: bytes[o + 2] & 0x7f,
        gender: bytes[o + 2] >> 7,
        pic: bytes[o + 3],
        doubleBattle: u32(bytes, o + 24),
        aiFlags: u32(bytes, o + 28),
        items: [0, 1, 2, 3].map((i) => u16(bytes, o + 16 + i * 2)),
        partySize: size,
        // In-place editing can shrink a party and grow it back, but never
        // beyond what was originally allocated.
        maxPartySize: Math.max(size, rom.original[o + 32]),
      }
    },

    write(id, field, value) {
      const spec = FIELD_BYTES[field]
      const o = base(id)
      // Music and gender share a byte: gender is the top bit.
      if (field === 'music') return rom.writeU8(o + 2, (bytes[o + 2] & 0x80) | (value & 0x7f))
      if (field === 'gender') return rom.writeU8(o + 2, (bytes[o + 2] & 0x7f) | ((value & 1) << 7))
      if (spec) {
        if (spec.size === 1) rom.writeU8(o + spec.off, value)
        else {
          rom.writeU16LE(o + spec.off, value & 0xffff)
          rom.writeU16LE(o + spec.off + 2, (value >>> 16) & 0xffff)
        }
        return
      }
      if (field === 'partySize') {
        const max = this.read(id).maxPartySize
        rom.writeU8(o + 32, Math.max(1, Math.min(max, value)))
      }
    },

    setName(id, name) {
      const encoded = gen3Codec.encode(name.toUpperCase(), NAME_LEN - 1)
      if (!encoded || name.length === 0) return false
      rom.writeBytes(base(id) + 4, [...encoded, 0xff].slice(0, NAME_LEN))
      refresh(id)
      return true
    },

    setItem(id, slot, item) {
      if (slot >= 0 && slot < 4) rom.writeU16LE(base(id) + 16 + slot * 2, item)
    },

    party(id): PartyMon[] {
      const { flags, size, ptr, entrySize } = partyInfo(id)
      if (ptr === null) return []
      const out: PartyMon[] = []
      for (let i = 0; i < size; i++) {
        const o = ptr + i * entrySize
        const hasItem = (flags & 2) === 2
        const hasMoves = (flags & 1) === 1
        out.push({
          iv: u16(bytes, o),
          ivs: null,
          level: u16(bytes, o + 2),
          species: u16(bytes, o + 4),
          item: hasItem ? u16(bytes, o + 6) : null,
          moves: hasMoves
            ? [0, 1, 2, 3].map((m) => u16(bytes, o + (hasItem ? 8 : 6) + m * 2))
            : null,
        })
      }
      return out
    },

    writePartyField(id, slot, field, value) {
      const { flags, size, ptr, entrySize } = partyInfo(id)
      if (ptr === null || slot < 0 || slot >= size) return
      const o = ptr + slot * entrySize
      if (field === 'iv') rom.writeU16LE(o, value)
      else if (field === 'level') rom.writeU16LE(o + 2, value)
      else if (field === 'species') rom.writeU16LE(o + 4, value)
      else if (field === 'item' && (flags & 2) === 2) rom.writeU16LE(o + 6, value)
      else if (field.startsWith('move') && (flags & 1) === 1) {
        const m = Number(field.slice(4))
        if (m >= 0 && m < 4) rom.writeU16LE(o + ((flags & 2) === 2 ? 8 : 6) + m * 2, value)
      }
    },

    revert(id) {
      rom.revertRange(base(id), ENTRY)
      const { size, ptr, entrySize } = partyInfo(id)
      if (ptr !== null) rom.revertRange(ptr, size * entrySize)
      refresh(id)
    },
  }
  return { module, offset, count }
}
