/**
 * Gen 3 egg moves (`gEggMoves`).
 *
 * One flat u16 array, not a per-species table: each entry is a marker
 * word `species + 20000` followed by that species' move ids, and the
 * whole array ends with 0xFFFF. Species with no egg moves simply have
 * no entry. The game scans the array for the marker and then reads
 * forward until it sees another word above the marker offset, so at
 * most EGG_MOVES_ARRAY_COUNT (10) moves per species are reachable.
 *
 * Discovery is structural — there is no fixed stride to key on, so a
 * signature would have to be one species' moves and would break the
 * moment that species is edited. Instead every aligned word in the
 * marker range is tried as a table start and the longest run that
 * parses cleanly (ascending species, valid move ids, 0xFFFF terminator)
 * wins. That is then verified against a second, independent pattern:
 * the code's 32-bit pointer to the table must exist.
 *
 * Validated on built Emerald + FireRed, whose tables are byte-identical:
 * 165 entries / 2278 bytes, species 1-411 strictly ascending, 1-8 moves
 * each, and exactly one pointer to the table in each ROM.
 */
import type { Rom } from '../rom'
import type { EggMoveModule } from '../games/schema'
import { findGbaPointerRefs, relocate } from '../freespace'

const SPECIES_OFFSET = 20000
const TERMINATOR = 0xffff
/** EGG_MOVES_ARRAY_COUNT — what the game will actually read back. */
export const MAX_EGG_MOVES = 10
/** Parse ceiling; generous so ROM hacks with longer lists still load. */
const PARSE_MAX_MOVES = 24
/**
 * Floor for a candidate table. Kept low so that deleting most species'
 * egg moves can't shrink the table out of discoverability — the code
 * pointer, not the length, is what actually confirms a candidate.
 */
const MIN_ENTRIES = 8
/** Bound on how many candidates get the (whole-ROM) pointer scan. */
const MAX_POINTER_CHECKS = 8

export interface EggMoveEntry {
  species: number
  moves: number[]
}

interface ParsedTable {
  start: number
  /** Byte length including the terminator. */
  length: number
  entries: EggMoveEntry[]
}

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8)

/**
 * Parse the array starting at `p`, or null if it is not shaped like an
 * egg-move table. Strict on purpose: this doubles as the discovery
 * predicate, so anything it accepts is a candidate table.
 */
function parseFrom(
  bytes: Uint8Array,
  p: number,
  speciesCount: number,
  moveCount: number,
): ParsedTable | null {
  const start = p
  const entries: EggMoveEntry[] = []
  let lastSpecies = 0
  while (p + 1 < bytes.length) {
    const marker = u16(bytes, p)
    if (marker === TERMINATOR) {
      return entries.length > 0 ? { start, length: p + 2 - start, entries } : null
    }
    if (marker <= SPECIES_OFFSET || marker > SPECIES_OFFSET + speciesCount) return null
    const species = marker - SPECIES_OFFSET
    // Strictly ascending — the compiler emits them in dex order, and it
    // keeps a run of unrelated words from parsing as a long table.
    if (species <= lastSpecies) return null
    lastSpecies = species
    p += 2
    const moves: number[] = []
    while (p + 1 < bytes.length) {
      const w = u16(bytes, p)
      if (w > SPECIES_OFFSET) break // next marker or the terminator
      if (w < 1 || w > moveCount) return null
      if (moves.length >= PARSE_MAX_MOVES) return null
      moves.push(w)
      p += 2
    }
    if (moves.length === 0) return null
    entries.push({ species, moves })
  }
  return null
}

/**
 * Every cleanly-parsing run, longest first. Starting inside the real
 * table parses too (just with fewer entries), so the true start is the
 * longest run — but the caller still confirms with the code pointer
 * rather than trusting length alone.
 */
function scanCandidates(
  bytes: Uint8Array,
  speciesCount: number,
  moveCount: number,
): ParsedTable[] {
  const found: ParsedTable[] = []
  for (let p = 0; p + 1 < bytes.length; p += 2) {
    const v = u16(bytes, p)
    if (v <= SPECIES_OFFSET || v > SPECIES_OFFSET + speciesCount) continue
    const parsed = parseFrom(bytes, p, speciesCount, moveCount)
    if (parsed && parsed.entries.length >= MIN_ENTRIES) found.push(parsed)
  }
  return found.sort((a, b) => b.entries.length - a.entries.length || a.start - b.start)
}

function serialize(entries: EggMoveEntry[]): Uint8Array {
  const words = entries.reduce((n, e) => n + 1 + e.moves.length, 0) + 1
  const out = new Uint8Array(words * 2)
  let o = 0
  const put = (v: number) => {
    out[o] = v & 0xff
    out[o + 1] = (v >> 8) & 0xff
    o += 2
  }
  for (const e of entries) {
    put(e.species + SPECIES_OFFSET)
    for (const m of e.moves) put(m)
  }
  put(TERMINATOR)
  return out
}

export function buildGen3EggMoves(
  rom: Rom,
  speciesCount: number,
  moveCount: number,
): { module: EggMoveModule; offset: number; length: number } | null {
  // Second, independent check: the game's code has to point at the
  // table. Longest candidate first, so in practice this scans once.
  const candidates = scanCandidates(rom.bytes, speciesCount, moveCount)
  let found: ParsedTable | null = null
  for (const c of candidates.slice(0, MAX_POINTER_CHECKS)) {
    if (findGbaPointerRefs(rom.bytes, c.start, 1).length > 0) {
      found = c
      break
    }
  }
  if (!found) return null

  let start = found.start
  let capacity = found.length
  let entries = found.entries

  const read = (id: number): number[] => entries.find((e) => e.species === id)?.moves ?? []

  const write = (id: number, moves: number[]): boolean => {
    if (id < 1 || id > speciesCount) return false
    if (moves.length > MAX_EGG_MOVES) return false
    if (moves.some((m) => m < 1 || m > moveCount)) return false

    const next = entries.filter((e) => e.species !== id)
    if (moves.length > 0) {
      // Keep dex order — the parser (and the game's linear scan) rely
      // on markers staying ascending.
      const at = next.findIndex((e) => e.species > id)
      const entry = { species: id, moves: [...moves] }
      if (at === -1) next.push(entry)
      else next.splice(at, 0, entry)
    }

    const data = serialize(next)
    if (data.length <= capacity) {
      rom.writeBytes(start, data)
      // Anything left over from a shorter table is past the terminator
      // and unreachable; blank it so the slack reads as free space.
      for (let i = data.length; i < capacity; i++) rom.writeU8(start + i, 0xff)
    } else {
      const dest = relocate(rom, start, capacity, data)
      if (dest === null) return false
      start = dest
      capacity = data.length
    }
    entries = next
    return true
  }

  return {
    module: { maxMoves: MAX_EGG_MOVES, read, write, species: () => entries.map((e) => e.species) },
    offset: found.start,
    length: found.length,
  }
}
