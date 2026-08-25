/**
 * Links trainers to where they stand in the world.
 *
 * A map's object events carry a `trainerType` (non-zero for anyone who
 * challenges the player) and a script pointer. The script's opening
 * `trainerbattle` command names the opponent:
 *
 *   struct ObjectEventTemplate {  // 24 bytes, global.fieldmap.h
 *     0x00 u8  localId;   0x01 u16 graphicsId;  0x03 u8 kind;
 *     0x04 s16 x;         0x06 s16 y;
 *     0x0C u16 trainerType;  0x0E u16 trainerRange;
 *     0x10 const u8 *script; 0x14 u16 flagId;
 *   }
 *
 *   SCR_OP_TRAINERBATTLE = 0x5C, then u8 flags, u8 localId, u16 opponent
 *   (asm/macros/event.inc), so the id sits at script + 3.
 *
 * Most trainer scripts open with that command outright. A minority open
 * with a short prologue (lock, faceplayer, …) whose byte lengths are
 * known, so the walk steps over those and stops at the first opcode it
 * cannot size — guessing past an unknown command would risk reading a
 * pointer operand as an opcode and inventing a link.
 *
 * Some trainers are assigned at run time (Battle Frontier, Trainer Hill)
 * and have no static id anywhere in the script. Those simply come back
 * unlinked rather than being matched to a plausible-looking number.
 */
import type { Gen3MapIndex } from './mapscan'

const TEMPLATE_SIZE = 24
const OE = { localId: 0x00, x: 0x04, y: 0x06, trainerType: 0x0c, script: 0x10 } as const

const OP_TRAINERBATTLE = 0x5c

/**
 * Byte length of each script command that is known to appear before a
 * `trainerbattle`, opcode included. Deliberately tiny: an entry here is
 * a claim about the encoding, and a wrong one produces a bogus link.
 */
const PROLOGUE_LENGTHS: Record<number, number> = {
  0x23: 5, // callnative: u32 function pointer
  0x5a: 1, // faceplayer
  0x5b: 3, // turnobject: u8 localId, u8 direction
  0x6a: 1, // lock
  0x6b: 1, // lockall
}

/** How many prologue commands to step over before giving up. */
const MAX_PROLOGUE_STEPS = 8

export interface TrainerLocation {
  /** `${bank}.${map}` — matches MapEntry.key. */
  mapKey: string
  bank: number
  map: number
  x: number
  y: number
  /** Index into this map's object-event list. */
  eventIndex: number
  localId: number
}

export type TrainerLocationIndex = ReadonlyMap<number, TrainerLocation[]>

function u16(bytes: Uint8Array, off: number): number {
  return bytes[off] | (bytes[off + 1] << 8)
}

function s16(bytes: Uint8Array, off: number): number {
  const v = u16(bytes, off)
  return v >= 0x8000 ? v - 0x10000 : v
}

function romPointer(bytes: Uint8Array, off: number): number | null {
  if (off + 4 > bytes.length) return null
  const v = (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0
  if (v < 0x08000000) return null
  const rom = v - 0x08000000
  return rom < bytes.length ? rom : null
}

/**
 * Follows a trainer's script to its `trainerbattle` opponent id, or null
 * when the script does not name one statically.
 */
export function trainerIdFromScript(bytes: Uint8Array, script: number, trainerCount: number): number | null {
  let p = script
  for (let step = 0; step <= MAX_PROLOGUE_STEPS; step++) {
    if (p + 5 > bytes.length) return null
    const op = bytes[p]
    if (op === OP_TRAINERBATTLE) {
      const id = u16(bytes, p + 3)
      return id > 0 && id < trainerCount ? id : null
    }
    const len = PROLOGUE_LENGTHS[op]
    if (!len) return null
    p += len
  }
  return null
}

/** Builds trainer id -> every spot that trainer occupies. */
export function buildTrainerLocations(
  bytes: Uint8Array,
  index: Gen3MapIndex,
  trainerCount: number,
): TrainerLocationIndex {
  const out = new Map<number, TrainerLocation[]>()

  for (let bank = 0; bank < index.banks.length; bank++) {
    const maps = index.banks[bank]
    for (let map = 0; map < maps.length; map++) {
      const events = romPointer(bytes, maps[map] + 4)
      if (events === null) continue
      const count = bytes[events]
      const list = romPointer(bytes, events + 4)
      if (list === null || count === 0) continue

      for (let i = 0; i < count; i++) {
        const o = list + i * TEMPLATE_SIZE
        if (o + TEMPLATE_SIZE > bytes.length) break
        if (u16(bytes, o + OE.trainerType) === 0) continue
        const script = romPointer(bytes, o + OE.script)
        if (script === null) continue
        const id = trainerIdFromScript(bytes, script, trainerCount)
        if (id === null) continue

        const spot: TrainerLocation = {
          mapKey: `${bank}.${map}`,
          bank,
          map,
          x: s16(bytes, o + OE.x),
          y: s16(bytes, o + OE.y),
          eventIndex: i,
          localId: bytes[o + OE.localId],
        }
        const list_ = out.get(id)
        if (list_) list_.push(spot)
        else out.set(id, [spot])
      }
    }
  }
  return out
}
