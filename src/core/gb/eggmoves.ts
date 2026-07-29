/**
 * Gen 2 egg moves (`EggMovePointers` + the per-species lists).
 *
 * Layout verified against pokecrystal/pokegold
 * data/pokemon/egg_move_pointers.asm and egg_moves.asm, and against
 * ROMs built from both: a table of 251 dex-order bank-local u16
 * pointers, each pointing at a run of move-id bytes terminated by 0xFF.
 * Pointers and lists share one bank — `GetEggMove` reads the list bytes
 * with a fixed `BANK("Egg Moves")` — so relocations must stay in it.
 *
 * Nothing caps the list length in the game's reader (it loops to the
 * 0xFF), but the real data tops out at 8; writes are capped to keep an
 * edit from eating the bank.
 *
 * Most species have no egg moves and share one pointer to a bare 0xFF
 * (`NoEggMoves`) — 146 of 251 in Crystal, 145 in Gold. Two consequences
 * the editor has to respect:
 *   - Writing "in place" to a shared list would give egg moves to every
 *     species pointing at it, so a shared target always relocates.
 *   - That single 0xFF sits at the very end of the bank's live data, so
 *     the trailing-padding scan happily offers it as free space. The
 *     destination is floored past every live list, exactly as
 *     evosmoves.ts has to do for its all-zero blobs.
 *
 * Discovery is structural (the lists are editable, so no byte signature
 * would survive): the longest run of same-bank pointers whose targets
 * all parse, cross-checked by requiring the referenced lists to tile
 * most of the region they span.
 */
import type { Rom } from '../rom'
import type { EggMoveModule } from '../games/schema'
import { findGbBankFreeSpace } from '../freespace'

const TERMINATOR = 0xff
/** Generous ceiling for parsing; real lists hold at most 8. */
const PARSE_MAX = 24
/** What the editor will write — the bank is small and shared. */
export const MAX_GEN2_EGG_MOVES = 12

/** Parse a 0xFF-terminated move list; null if it isn't one. */
function parseList(bytes: Uint8Array, off: number, moveCount: number): number[] | null {
  const out: number[] = []
  let p = off
  while (p < bytes.length) {
    const v = bytes[p]
    if (v === TERMINATOR) return out
    if (v < 1 || v > moveCount || out.length >= PARSE_MAX) return null
    out.push(v)
    p++
  }
  return null
}

export function buildGen2EggMoves(
  rom: Rom,
  opts: { entries: number; moveCount: number },
): { module: EggMoveModule; tableOff: number; length: number } | null {
  const bytes = rom.bytes
  const { entries, moveCount } = opts

  let tableOff = -1
  scan: for (let phase = 0; phase < 2 && tableOff < 0; phase++) {
    for (let o = phase; o + entries * 2 <= bytes.length; o += 2) {
      const bank = Math.floor(o / 0x4000)
      let n = 0
      const seen = new Map<number, number>() // list offset → byte length
      while (n < entries && o + n * 2 + 2 <= bytes.length) {
        const v = rom.readU16LE(o + n * 2)
        if (v < 0x4000 || v >= 0x8000) break
        const target = bank * 0x4000 + v - 0x4000
        if (!seen.has(target)) {
          const list = parseList(bytes, target, moveCount)
          if (!list) break
          seen.set(target, list.length + 1) // include the terminator
        }
        n++
      }
      if (n >= entries) {
        // Independent cross-check: the referenced lists must tile most
        // of the span they cover. Data that merely parses will not.
        const offs = [...seen.keys()].sort((a, b) => a - b)
        const lo = offs[0]
        const hi = Math.max(...offs.map((s) => s + seen.get(s)!))
        const covered = offs.reduce((a, s) => a + seen.get(s)!, 0)
        if (offs.length >= 8 && hi > lo && covered >= (hi - lo) * 0.8) {
          tableOff = o
          continue scan
        }
      }
      if (n > 0) o += n * 2 - 2
    }
  }
  if (tableOff < 0) return null
  const bank = Math.floor(tableOff / 0x4000)

  const slotFor = (dex: number) => tableOff + (dex - 1) * 2
  const listOffFor = (dex: number) => {
    const v = rom.readU16LE(slotFor(dex))
    return bank * 0x4000 + v - 0x4000
  }
  const inRange = (dex: number) => dex >= 1 && dex <= entries

  const read = (dex: number): number[] =>
    inRange(dex) ? (parseList(bytes, listOffFor(dex), moveCount) ?? []) : []

  /** How many species point at the same list as `dex`. */
  const sharers = (dex: number): number => {
    const target = listOffFor(dex)
    let n = 0
    for (let i = 1; i <= entries; i++) if (listOffFor(i) === target) n++
    return n
  }

  /** The shared empty list the game itself uses for "no egg moves". */
  const findEmptyList = (): number | null => {
    const counts = new Map<number, number>()
    for (let i = 1; i <= entries; i++) {
      const off = listOffFor(i)
      if (bytes[off] === TERMINATOR) counts.set(off, (counts.get(off) ?? 0) + 1)
    }
    let best: number | null = null
    let bestN = 0
    for (const [off, n] of counts) {
      if (n > bestN) {
        best = off
        bestN = n
      }
    }
    return best
  }

  /** End of the last live list, so relocations never land on one. */
  const liveEnd = (): number => {
    let end = tableOff + entries * 2
    for (let i = 1; i <= entries; i++) {
      const off = listOffFor(i)
      const list = parseList(bytes, off, moveCount)
      if (list) end = Math.max(end, off + list.length + 1)
    }
    return end
  }

  const write = (dex: number, moves: number[]): boolean => {
    if (!inRange(dex)) return false
    if (moves.length > MAX_GEN2_EGG_MOVES) return false
    if (moves.some((m) => m < 1 || m > moveCount)) return false

    // Dropping every move: point at the game's own shared empty list
    // rather than burning bank space on another lone 0xFF.
    if (moves.length === 0) {
      const empty = findEmptyList()
      if (empty !== null) {
        rom.writeU16LE(slotFor(dex), (empty % 0x4000) + 0x4000)
        return true
      }
    }

    const current = parseList(bytes, listOffFor(dex), moveCount)
    const data = [...moves, TERMINATOR]
    // In place only when it fits AND no other species reads this list.
    if (current && data.length <= current.length + 1 && sharers(dex) === 1) {
      rom.writeBytes(listOffFor(dex), data)
      return true
    }

    let dest = findGbBankFreeSpace(bytes, bank, data.length)
    if (dest === null) return false
    const floor = liveEnd()
    if (dest < floor) dest = floor
    if (dest + data.length > (bank + 1) * 0x4000) return false
    rom.writeBytes(dest, data)
    rom.writeU16LE(slotFor(dex), (dest % 0x4000) + 0x4000)
    return true
  }

  const species = (): number[] => {
    const out: number[] = []
    for (let i = 1; i <= entries; i++) if (read(i).length > 0) out.push(i)
    return out
  }

  return {
    module: { maxMoves: MAX_GEN2_EGG_MOVES, read, write, species },
    tableOff,
    length: entries * 2,
  }
}
