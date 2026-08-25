/**
 * Trainer editing for pokeemerald-expansion.
 *
 * `struct Trainer` is nothing like vanilla Gen 3's 40-byte record, which
 * is why this needed its own decoder rather than a tweak to
 * gba/trainers.ts. Layout (52 bytes, verified against a built ROM —
 * SAWYER reads class 2 = HIKER, pic 0 = FRONT_HIKER, male, AI flags
 * 0x7 = AI_FLAG_BASIC_TRAINER, party size 1 holding Geodude at level
 * 21, all matching the tree's trainers.h):
 *
 *   +0x00 u64 aiFlags          -- 34 flags now, hence 64 bits
 *   +0x08 const TrainerMon *party
 *   +0x0C enum Item items[4]   -- 2 bytes each
 *   +0x14 startingStatus       -- opaque here, preserved verbatim
 *   +0x1C u8  trainerClass
 *   +0x1D u8  encounterMusic:7 | gender:1
 *   +0x1E u8  trainerPic       -- packed enum, 1 byte
 *   +0x1F u8  trainerName[11]
 *   +0x2A u8  battleType:2 | mugshotColor:6
 *   +0x2B u8  partySize
 *   +0x2C u8  poolSize, poolRuleIndex, poolPickIndex, poolPruneIndex
 *   +0x30 u16 overrideTrainer
 *   +0x32 u8  trainerBackPic
 *
 * The 52-byte size is only legal because the GBA build uses
 * `-mabi=apcs-gnu`, where a u64 aligns to 4 rather than 8. Assuming the
 * modern ABI gives 56 and finds nothing.
 */
import type { Rom } from '../rom'
import type { EntryHandle, PartyMon, SelectOption, TrainerData, TrainerModule } from '../games/schema'
import { readGbaPointer } from '../freespace'
import { gen3Codec } from '../text'

export const TRAINER_ENTRY = 52
export const TR = {
  aiFlags: 0x00,
  party: 0x08,
  items: 0x0c,
  trainerClass: 0x1c,
  music: 0x1d,
  pic: 0x1e,
  name: 0x1f,
  battleType: 0x2a,
  partySize: 0x2b,
  backPic: 0x32,
} as const
const NAME_LEN = 11
const MAX_ITEMS = 4

/**
 * `struct TrainerMon`, 36 bytes. `nickname` and `ev` are pointers and
 * `tags` is a bitfield; all three are left untouched by this editor.
 */
export const TRAINER_MON_ENTRY = 36
export const TM = {
  nickname: 0,
  ev: 4,
  iv: 8,
  moves: 12,
  species: 20,
  heldItem: 22,
  ability: 24,
  level: 26,
  ball: 27,
  friendship: 28,
} as const

/** `struct TrainerClass { u8 name[13]; u8 money; u16 ball; }` */
const CLASS_ENTRY = 16
const CLASS_NAME_LEN = 13
const MIN_CLASSES = 20
/** Prize money is a small multiplier; ball is an item id. */
const MAX_PRIZE_MONEY = 60
const MAX_BALL_ID = 1023

/**
 * `TRAINER_PARTY_IVS(hp, atk, def, speed, spatk, spdef)` packs six 5-bit
 * IVs into `u32 iv`, low bits first, in that stat order (data.h). The two
 * top bits are unused and are preserved on write.
 */
const IV_COUNT = 6
const IV_BITS = 5
const IV_MASK = 0x1f
const IV_MAX = 31

function u32(bytes: Uint8Array, off: number): number {
  return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0
}

function readIvs(bytes: Uint8Array, off: number): number[] {
  const packed = u32(bytes, off)
  return Array.from({ length: IV_COUNT }, (_, i) => (packed >>> (i * IV_BITS)) & IV_MASK)
}

export interface ExpansionTrainers {
  module: TrainerModule
  offset: number
  count: number
}

function u16(bytes: Uint8Array, off: number): number {
  return bytes[off] | (bytes[off + 1] << 8)
}

/**
 * Text in a fixed-width field, or null when the field is not even
 * terminated. An EMPTY result is valid and distinct from null: 30 of
 * this ROM's 854 trainers genuinely have no name, and rejecting those
 * chopped the table at entry 21.
 */
function fixedName(bytes: Uint8Array, off: number, len: number): string | null {
  const slice = bytes.subarray(off, off + len)
  if (slice.indexOf(0xff) < 0) return null
  return gen3Codec.decode(slice)
}

/**
 * Does a fixed-width field hold `minChars`+ of printable text?
 *
 * Byte-level on purpose: the class-table scan tests every 4-aligned
 * offset in a 32 MB ROM, and decoding a string there costs an
 * allocation per candidate — enough to hang the whole load. Decoding is
 * left for the handful of entries that end up being real.
 */
function looksLikeText(bytes: Uint8Array, off: number, len: number, minChars: number): boolean {
  if (off < 0 || off + len > bytes.length) return false
  let i = 0
  for (; i < len; i++) {
    const c = bytes[off + i]
    if (c === 0xff) break
    if (PRINTABLE[c] === 0) return false
  }
  return i < len && i >= minChars
}

/**
 * Which byte values the Gen 3 codec renders as a real character.
 *
 * Derived from the codec rather than written as a range, because the
 * ranges miss the accented letters down at 0x01-0x2E — "POKéMANIAC" is
 * a real trainer class, and a hand-rolled 0xA1-0xEE test rejected it,
 * truncating the class table to 23 entries and picking a different
 * table entirely.
 */
const PRINTABLE = (() => {
  const out = new Uint8Array(256)
  for (let c = 0; c < 256; c++) {
    if (c === 0xff) continue
    const ch = gen3Codec.decode(Uint8Array.of(c, 0xff))
    if (ch.length > 0 && ch !== '?') out[c] = 1
  }
  return out
})()

/**
 * Locate `gTrainerClasses` structurally: a long run of 16-byte records
 * opening with a terminated 13-byte name. Class names are pure text a
 * hack will have rewritten, so there is nothing to anchor on.
 */
function findTrainerClasses(bytes: Uint8Array): SelectOption[] | null {
  // Text alone is not enough to find this table — a 32 MB ROM is full
  // of 16-byte-aligned strings, and the longest text run turned out to
  // be an unrelated list. What makes `struct TrainerClass` identifiable
  // is the two fields AFTER the name: a small prize-money multiplier
  // and an item id for the class's Poké Ball.
  const valid = (o: number): boolean => {
    if (o < 0 || o + CLASS_ENTRY > bytes.length) return false
    // Numeric fields first — three byte reads that reject most of the
    // ROM before the per-character name scan runs at all.
    if (bytes[o + CLASS_NAME_LEN] > MAX_PRIZE_MONEY) return false
    if ((bytes[o + 14] | (bytes[o + 15] << 8)) > MAX_BALL_ID) return false
    if (PRINTABLE[bytes[o]] === 0) return false
    return looksLikeText(bytes, o, CLASS_NAME_LEN, 1)
  }
  let best: { offset: number; count: number } | null = null
  for (let o = 0; o + CLASS_ENTRY * MIN_CLASSES <= bytes.length; o += 4) {
    if (!valid(o) || valid(o - CLASS_ENTRY)) continue
    let count = 0
    while (count < 512 && valid(o + count * CLASS_ENTRY)) count++
    if (count >= MIN_CLASSES) {
      // Real class records mostly carry a prize multiplier; a run of
      // plain strings with zero-filled tails does not.
      let withMoney = 0
      for (let i = 0; i < count; i++) if (bytes[o + i * CLASS_ENTRY + CLASS_NAME_LEN] > 0) withMoney++
      if (withMoney >= count * 0.3 && (best === null || count > best.count)) best = { offset: o, count }
    }
    if (count > 1) o += (count - 1) * CLASS_ENTRY
  }
  if (best === null) return null
  const out: SelectOption[] = []
  for (let i = 0; i < best.count; i++) {
    const name = fixedName(bytes, best.offset + i * CLASS_ENTRY, CLASS_NAME_LEN) ?? ''
    out.push({ value: i, label: name.trim() || `Class #${i}` })
  }
  return out
}

/** Does this offset look like a filled-in `struct Trainer`? */
function trainerValid(bytes: Uint8Array, off: number): boolean {
  if (off < 0 || off + TRAINER_ENTRY > bytes.length) return false
  // Cheapest, most selective test first: this runs at every 4-aligned
  // offset of a 32 MB ROM, and one byte read rejects nearly all of it.
  const size = bytes[off + TR.partySize]
  if (size < 1 || size > 6) return false
  const party = readGbaPointer(bytes, off + TR.party)
  if (party === null) return false
  if (party + size * TRAINER_MON_ENTRY > bytes.length) return false
  // Terminator only: 30 of this ROM's trainers have an empty name, and
  // demanding text here truncated the table at entry 21.
  return bytes.subarray(off + TR.name, off + TR.name + NAME_LEN).indexOf(0xff) >= 0
}

export function findTrainerTable(bytes: Uint8Array): { offset: number; count: number } | null {
  let best: { offset: number; count: number } | null = null
  for (let o = 0; o + TRAINER_ENTRY * MIN_TRAINERS <= bytes.length; o += 4) {
    // Only maximal runs, so the skip below can't step over a longer one.
    if (!trainerValid(bytes, o) || trainerValid(bytes, o - TRAINER_ENTRY)) continue
    let count = 0
    while (count < MAX_TRAINERS && trainerValid(bytes, o + count * TRAINER_ENTRY)) count++
    if (count >= MIN_TRAINERS && namedFraction(bytes, o, count) >= 0.5) {
      if (best === null || count > best.count) best = { offset: o, count }
    }
    if (count > 1) o += (count - 1) * TRAINER_ENTRY
  }
  return best
}

/** Most trainers are named; pointer soup is not. */
function namedFraction(bytes: Uint8Array, offset: number, count: number): number {
  let named = 0
  for (let i = 0; i < count; i++) {
    if (looksLikeText(bytes, offset + i * TRAINER_ENTRY + TR.name, NAME_LEN, 2)) named++
  }
  return named / count
}

const MIN_TRAINERS = 50
const MAX_TRAINERS = 8192

export function buildExpansionTrainers(rom: Rom, speciesCount: number, moveCount: number): ExpansionTrainers | null {
  const bytes = rom.bytes
  const table = findTrainerTable(bytes)
  if (table === null) return null
  const { offset, count } = table
  const base = (id: number) => offset + id * TRAINER_ENTRY

  const readName = (id: number) => fixedName(bytes, base(id) + TR.name, NAME_LEN) ?? ''
  const entries: EntryHandle[] = []
  for (let id = 0; id < count; id++) {
    const name = readName(id)
    entries.push({ id, label: `${String(id).padStart(3, '0')} ${name || '(unnamed)'}`, name })
  }
  const refresh = (id: number) => {
    const h = entries[id]
    h.name = readName(id)
    h.label = `${String(id).padStart(3, '0')} ${h.name || '(unnamed)'}`
  }

  const partyPtr = (id: number) => readGbaPointer(bytes, base(id) + TR.party)

  const module: TrainerModule = {
    entries,
    nameLength: NAME_LEN - 1,
    classOptions: findTrainerClasses(bytes),
    features: { identity: true, appearance: true, ai: true, items: true, partySize: true },

    read(id): TrainerData {
      const o = base(id)
      return {
        name: readName(id),
        trainerClass: bytes[o + TR.trainerClass],
        pic: bytes[o + TR.pic],
        music: bytes[o + TR.music] & 0x7f,
        gender: bytes[o + TR.music] >> 7,
        // battleType is an enum (0 singles, 1 doubles) sharing a byte
        // with mugshotColor, not vanilla's standalone u32 flag.
        doubleBattle: bytes[o + TR.battleType] & 0x3,
        // 34 AI flags exist; the UI field is 32-bit, so the low word is
        // what is editable and the high bits are preserved on write.
        aiFlags: (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0,
        items: Array.from({ length: MAX_ITEMS }, (_, i) => u16(bytes, o + TR.items + i * 2)),
        partySize: bytes[o + TR.partySize],
        // Growth is capped at the original allocation: party arrays are
        // packed back to back, so writing a 6th mon into a slot sized
        // for 2 would overwrite the next trainer's party.
        maxPartySize: Math.max(bytes[o + TR.partySize], rom.original[o + TR.partySize]),
      }
    },

    write(id, field, value) {
      const o = base(id)
      switch (field) {
        case 'trainerClass':
          return rom.writeU8(o + TR.trainerClass, value)
        case 'pic':
          return rom.writeU8(o + TR.pic, value)
        case 'music':
          return rom.writeU8(o + TR.music, (bytes[o + TR.music] & 0x80) | (value & 0x7f))
        case 'gender':
          return rom.writeU8(o + TR.music, (bytes[o + TR.music] & 0x7f) | ((value & 1) << 7))
        case 'doubleBattle':
          return rom.writeU8(o + TR.battleType, (bytes[o + TR.battleType] & ~0x3) | (value & 0x3))
        case 'aiFlags':
          rom.writeU16LE(o, value & 0xffff)
          rom.writeU16LE(o + 2, (value >>> 16) & 0xffff)
          return
        case 'partySize': {
          const max = Math.max(bytes[o + TR.partySize], rom.original[o + TR.partySize])
          return rom.writeU8(o + TR.partySize, Math.max(1, Math.min(max, value)))
        }
      }
    },

    setName(id, name) {
      const encoded = gen3Codec.encode(name, NAME_LEN - 1)
      if (!encoded || name.length === 0) return false
      rom.writeBytes(base(id) + TR.name, [...encoded, 0xff].slice(0, NAME_LEN))
      refresh(id)
      return true
    },

    setItem(id, slot, item) {
      if (slot >= 0 && slot < MAX_ITEMS) rom.writeU16LE(base(id) + TR.items + slot * 2, item)
    },

    party(id): PartyMon[] {
      const p = partyPtr(id)
      if (p === null) return []
      const size = bytes[base(id) + TR.partySize]
      const out: PartyMon[] = []
      for (let i = 0; i < size; i++) {
        const o = p + i * TRAINER_MON_ENTRY
        if (o + TRAINER_MON_ENTRY > bytes.length) break
        out.push({
          species: u16(bytes, o + TM.species),
          level: bytes[o + TM.level],
          iv: null,
          ivs: readIvs(bytes, o + TM.iv),
          item: u16(bytes, o + TM.heldItem),
          moves: [0, 1, 2, 3].map((m) => u16(bytes, o + TM.moves + m * 2)),
        })
      }
      return out
    },

    writePartyField(id, slot, field, value) {
      const p = partyPtr(id)
      if (p === null) return
      if (slot < 0 || slot >= bytes[base(id) + TR.partySize]) return
      const o = p + slot * TRAINER_MON_ENTRY
      if (field === 'species') return rom.writeU16LE(o + TM.species, Math.min(value, speciesCount))
      if (field === 'level') return rom.writeU8(o + TM.level, Math.max(1, Math.min(100, value)))
      if (field === 'item') return rom.writeU16LE(o + TM.heldItem, value)
      const iv = /^iv(\d)$/.exec(field)
      if (iv) {
        const idx = Number(iv[1])
        if (idx < 0 || idx >= IV_COUNT) return
        const cur = u32(bytes, o + TM.iv)
        const shift = idx * IV_BITS
        const next = ((cur & ~(IV_MASK << shift)) | ((Math.max(0, Math.min(IV_MAX, value)) & IV_MASK) << shift)) >>> 0
        rom.writeU16LE(o + TM.iv, next & 0xffff)
        rom.writeU16LE(o + TM.iv + 2, (next >>> 16) & 0xffff)
        return
      }
      const move = /^move(\d)$/.exec(field)
      if (move) {
        const idx = Number(move[1])
        if (idx >= 0 && idx < 4) rom.writeU16LE(o + TM.moves + idx * 2, Math.min(value, moveCount))
      }
    },

    revert(id) {
      const o = base(id)
      const p = partyPtr(id)
      // The party lives outside the 52-byte entry, so it needs its own
      // revert. This editor never moves a party, so the current pointer
      // is still the original one; the size is the larger of current
      // and original so a shrink-then-revert restores every slot.
      if (p !== null) {
        const size = Math.max(bytes[o + TR.partySize], rom.original[o + TR.partySize])
        rom.revertRange(p, size * TRAINER_MON_ENTRY)
      }
      rom.revertRange(o, TRAINER_ENTRY)
      refresh(id)
    },
  }

  return { module, offset, count }
}
