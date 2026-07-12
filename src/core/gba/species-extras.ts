/**
 * Gen 3 species extras: evolutions, level-up learnsets, and the type
 * effectiveness chart. Formats verified against pokeemerald/pokefirered:
 *
 *  - Evolutions: 5 × {method u16, param u16, target u16} per species
 *    (6-byte entries, 30 bytes per species, entry 0 dummy)
 *  - Learnsets: pointer table (entry 0 dummy) → u16 list of
 *    (level << 9) | move, terminated 0xFFFF
 *  - Type chart: byte triples {attacker, defender, multiplier×10},
 *    0xFE,0xFE separator before the Foresight-ignored block,
 *    0xFF,0xFF terminator
 */
import type { Rom } from '../rom'
import type {
  EvolutionEntry,
  EvolutionModule,
  LearnsetEntry,
  LearnsetModule,
  SelectOption,
  TypeChartEntry,
  TypeChartModule,
} from '../games/schema'
import { findAll, findByVote } from '../scan'
import { readGbaPointer, relocate } from '../freespace'

// Compiled entries are padded to 8 bytes (verified against a built ROM).
const EVO_SIZE = 8
const EVOS_PER_MON = 5
const EVO_STRIDE = EVO_SIZE * EVOS_PER_MON

export const EVO_METHODS: SelectOption[] = [
  { value: 0, label: '— none —' },
  { value: 1, label: 'Friendship' },
  { value: 2, label: 'Friendship (day)' },
  { value: 3, label: 'Friendship (night)' },
  { value: 4, label: 'Level up' },
  { value: 5, label: 'Trade' },
  { value: 6, label: 'Trade holding item' },
  { value: 7, label: 'Use item' },
  { value: 8, label: 'Level, Atk > Def' },
  { value: 9, label: 'Level, Atk = Def' },
  { value: 10, label: 'Level, Atk < Def' },
  { value: 11, label: 'Level (Silcoon half)' },
  { value: 12, label: 'Level (Cascoon half)' },
  { value: 13, label: 'Level (Ninjask)' },
  { value: 14, label: 'Level (Shedinja)' },
  { value: 15, label: 'Beauty' },
]

// Redundant anchors voting for the table base (bytes verified identical
// on built Emerald + FireRed): editing any one anchor species can't
// break re-discovery. Two agreeing anchors win.
const EVO_ANCHORS: { dex: number; sig: number[] }[] = [
  { dex: 1, sig: [4, 0, 16, 0, 2, 0] }, // Bulbasaur → Ivysaur lv16
  { dex: 2, sig: [4, 0, 32, 0, 3, 0] }, // Ivysaur → Venusaur lv32
  { dex: 4, sig: [4, 0, 16, 0, 5, 0] }, // Charmander → lv16
  { dex: 25, sig: [7, 0, 96, 0, 26, 0] }, // Pikachu: Thunder Stone
  { dex: 129, sig: [4, 0, 20, 0, 130, 0] }, // Magikarp → lv20
  { dex: 133, sig: [7, 0, 96, 0, 135, 0] }, // Eevee: Thunder Stone
]

/** Majority vote over anchor hits; returns the winner with >= 2 votes. */
const voteForBase = (bytes: Uint8Array, anchors: { dex: number; sig: number[] }[], stride: number) =>
  findByVote(bytes, anchors.map((a) => ({ index: a.dex, pattern: a.sig })), stride)

export function buildEvolutions(rom: Rom, speciesCount: number): { module: EvolutionModule; offset: number } | null {
  const bytes = rom.bytes
  const offset = voteForBase(bytes, EVO_ANCHORS, EVO_STRIDE) // entry 0 dummy
  if (offset === null) return null

  const entryOff = (id: number, slot: number) => offset + id * EVO_STRIDE + slot * EVO_SIZE
  const module: EvolutionModule = {
    methods: EVO_METHODS,
    read(id): EvolutionEntry[] {
      const out: EvolutionEntry[] = []
      for (let s = 0; s < EVOS_PER_MON; s++) {
        const o = entryOff(id, s)
        out.push({
          method: rom.readU16LE(o),
          param: rom.readU16LE(o + 2),
          target: rom.readU16LE(o + 4),
        })
      }
      return out
    },
    write(id, slot, field, value) {
      if (slot < 0 || slot >= EVOS_PER_MON || id < 1 || id > speciesCount) return
      const o = entryOff(id, slot)
      if (field === 'method') rom.writeU16LE(o, value)
      else if (field === 'param') rom.writeU16LE(o + 2, value)
      else if (field === 'target') rom.writeU16LE(o + 4, value)
    },
    revert(id) {
      rom.revertRange(offset + id * EVO_STRIDE, EVO_STRIDE)
    },
  }
  return { module, offset }
}

/* ------------------------------------------------------------ learnsets */

const MAX_MOVES = 64

// First learnset word (level<<9 | move) for anchor species — identical
// in built Emerald and FireRed: Tackle@1, Scratch@1, Thundershock@1,
// Splash@1, Confusion@1.
const LS_ANCHORS: { dex: number; word: number }[] = [
  { dex: 1, word: 0x0221 }, // Bulbasaur
  { dex: 4, word: 0x020a }, // Charmander
  { dex: 25, word: 0x0254 }, // Pikachu
  { dex: 129, word: 0x0296 }, // Magikarp
  { dex: 150, word: 0x025d }, // Mewtwo
]

export function buildLearnsets(rom: Rom, speciesCount: number): { module: LearnsetModule; offset: number } | null {
  const bytes = rom.bytes
  const firstMove = (p: number): number | null => {
    const t = readGbaPointer(bytes, p)
    return t === null || t + 2 > bytes.length ? null : bytes[t] | (bytes[t + 1] << 8)
  }
  // The pointer table is found by anchor vote: at a candidate base,
  // each anchor species' pointer must lead to its known first word.
  // Three of five agreeing means editing one or two anchor learnsets
  // still reloads fine.
  let offset: number | null = null
  for (let o = 0; o + 4 * 151 <= bytes.length; o += 4) {
    // Cheap pre-filter: entry 0 (dummy) must at least be a ROM pointer.
    if (bytes[o + 3] !== 0x08) continue
    let matches = 0
    for (const a of LS_ANCHORS) {
      if (firstMove(o + a.dex * 4) === a.word) matches++
    }
    if (matches >= 3) {
      offset = o // entry 0 dummy
      break
    }
  }
  if (offset === null) return null
  const table = offset

  const listOff = (id: number) => readGbaPointer(bytes, table + id * 4)
  const readList = (id: number): LearnsetEntry[] => {
    const off = listOff(id)
    const out: LearnsetEntry[] = []
    if (off === null) return out
    for (let i = 0; i < MAX_MOVES; i++) {
      const v = rom.readU16LE(off + i * 2)
      if (v === 0xffff) break
      out.push({ level: v >> 9, move: v & 0x1ff })
    }
    return out
  }

  const module: LearnsetModule = {
    read: readList,
    write(id, entries) {
      if (id < 1 || id > speciesCount || entries.length > MAX_MOVES) return false
      const off = listOff(id)
      if (off === null) return false
      const old = readList(id)
      const data = new Uint8Array(entries.length * 2 + 2)
      entries.forEach((e, i) => {
        const v = ((e.level & 0x7f) << 9) | (e.move & 0x1ff)
        data[i * 2] = v & 0xff
        data[i * 2 + 1] = v >> 8
      })
      data[entries.length * 2] = 0xff
      data[entries.length * 2 + 1] = 0xff
      if (entries.length <= old.length) {
        rom.writeBytes(off, data) // fits in place
        return true
      }
      // Grew: move the list to free space; every species sharing this
      // pointer follows along (intended for shared dummy lists).
      return relocate(rom, off, old.length * 2 + 2, data) !== null
    },
  }
  return { module, offset: table }
}

/* ------------------------------------------------------------ type chart */

// Normal→Rock ½, Normal→Steel ½, Fire→Fire ½ — the chart's first rows.
const CHART_SIG = [0, 5, 5, 0, 8, 5, 10, 10, 5]
const SEPARATOR = 0xfe
const END = 0xff

export function buildTypeChart(rom: Rom): { module: TypeChartModule; offset: number } | null {
  const bytes = rom.bytes
  const hits = findAll(bytes, CHART_SIG, 4)
  if (hits.length !== 1) return null
  let offset = hits[0]

  const parse = () => {
    const entries: TypeChartEntry[] = []
    let separatorAt = -1
    let p = offset
    while (p + 3 <= bytes.length) {
      const a = bytes[p]
      if (a === END) break
      if (a === SEPARATOR) {
        separatorAt = entries.length
        p += 3
        continue
      }
      entries.push({ attacker: a, defender: bytes[p + 1], multiplier: bytes[p + 2], offset: p })
      p += 3
      if (entries.length > 512) break
    }
    return { entries, separatorAt, end: p + 3 }
  }

  const rebuild = (entries: TypeChartEntry[], separatorAt: number): boolean => {
    const { end } = parse()
    const out: number[] = []
    entries.forEach((e, i) => {
      if (i === separatorAt) out.push(SEPARATOR, SEPARATOR, 0)
      out.push(e.attacker, e.defender, e.multiplier)
    })
    if (separatorAt >= entries.length) out.push(SEPARATOR, SEPARATOR, 0)
    out.push(END, END, 0)
    const oldLen = end - offset
    if (out.length <= oldLen) {
      rom.writeBytes(offset, out)
      for (let i = out.length; i < oldLen; i++) rom.writeU8(offset + i, END) // pad tail
      return true
    }
    const dest = relocate(rom, offset, oldLen, Uint8Array.from(out))
    if (dest === null) return false
    offset = dest
    return true
  }

  const module: TypeChartModule = {
    entries: () => parse().entries,
    setMultiplier(index, multiplier) {
      const { entries } = parse()
      if (index < 0 || index >= entries.length) return
      rom.writeU8(entries[index].offset + 2, multiplier)
    },
    addEntry(attacker, defender, multiplier) {
      const { entries, separatorAt } = parse()
      const at = separatorAt === -1 ? entries.length : separatorAt
      entries.splice(at, 0, { attacker, defender, multiplier, offset: 0 })
      return rebuild(entries, separatorAt === -1 ? entries.length : separatorAt + 1)
    },
    removeEntry(index) {
      const { entries, separatorAt } = parse()
      if (index < 0 || index >= entries.length) return false
      entries.splice(index, 1)
      return rebuild(entries, separatorAt > index ? separatorAt - 1 : separatorAt)
    },
  }
  return { module, offset }
}

/* ------------------------------------------------------ TM/HM learnsets */

// gTMHMLearnsets: u64 bitfield per species (8 bytes, bit 0 = TM01 …
// bit 49 = TM50, bit 50 = HM01 … bit 57 = HM08). Anchor bitfields are
// computed from the pret decomp learnsets and are identical in Emerald
// and FireRed. Bulbasaur and Ivysaur share a learnset, so Venusaur and
// Charmander pin the alignment.
const TMHM_ANCHORS: { dex: number; sig: number[] }[] = [
  { dex: 1, sig: [32, 7, 53, 132, 8, 30, 228, 0] }, // Bulbasaur (Ivysaur shares it)
  { dex: 3, sig: [48, 71, 53, 134, 8, 30, 228, 0] }, // Venusaur
  { dex: 4, sig: [35, 6, 81, 204, 164, 30, 166, 0] }, // Charmander
  { dex: 25, sig: [33, 130, 211, 205, 2, 30, 224, 0] }, // Pikachu
  { dex: 113, sig: [109, 246, 251, 247, 118, 158, 225, 0] }, // Chansey
  { dex: 150, sig: [237, 254, 251, 247, 247, 143, 225, 0] }, // Mewtwo
]
// TM01-04: Focus Punch, Dragon Claw, Water Pulse, Calm Mind (u16 LE).
const TM_MOVES_SIG = [8, 1, 81, 1, 96, 1, 91, 1]
export const TMHM_BITS = 58

export interface TmhmCompat {
  offset: number
  /** TM01..TM50,HM01..HM08 → move ids, when the list was found. */
  tmMoves: number[] | null
  read(id: number): boolean[]
  write(id: number, flags: boolean[]): void
  revert(id: number): void
}

export function buildTmhmCompat(rom: Rom): TmhmCompat | null {
  const bytes = rom.bytes
  // Bulbasaur and Ivysaur share a bitfield, so the Bulbasaur signature
  // also hits the Ivysaur row and casts one stray vote — the aligned
  // base still collects a clear majority from the other anchors.
  const offset = voteForBase(bytes, TMHM_ANCHORS, 8) // entry 0 dummy
  if (offset === null) return null

  // The TM→move list appears more than once in some ROMs (identical
  // copies), so take the first hit rather than requiring uniqueness.
  let tmMoves: number[] | null = null
  const tmHits = findAll(bytes, TM_MOVES_SIG, 4)
  if (tmHits.length >= 1) {
    tmMoves = []
    for (let i = 0; i < TMHM_BITS; i++) tmMoves.push(rom.readU16LE(tmHits[0] + i * 2))
  }

  return {
    offset,
    tmMoves,
    read(id) {
      const o = offset + id * 8
      return Array.from({ length: TMHM_BITS }, (_, i) => ((bytes[o + (i >> 3)] >> (i & 7)) & 1) === 1)
    },
    write(id, flags) {
      const o = offset + id * 8
      for (let b = 0; b < 8; b++) {
        let v = 0
        for (let bit = 0; bit < 8; bit++) if (flags[b * 8 + bit]) v |= 1 << bit
        rom.writeU8(o + b, v)
      }
    },
    revert(id) {
      rom.revertRange(offset + id * 8, 8)
    },
  }
}
