/**
 * Generation 1 adapter — Pokémon Red / Blue / Yellow (and derived hacks).
 *
 * Every table is located by signature scanning + verification, so this
 * works across versions, regions with Latin text, and most existing hacks.
 *
 * Gen 1 quirks handled here:
 *  - Base stats are stored in Pokédex order, but names in "internal"
 *    order; a mapping table connects the two.
 *  - In Red/Blue, Mew's stats live outside the main table.
 */
import { Rom } from '../rom'
import { findAll, findVerified, matchesAt } from '../scan'
import { gen12Bytes, gen12Codec } from '../text'
import { GEN1_TYPES, GEN12_GROWTH, padDex } from './data'
import type { EntryHandle, FieldSpec, FieldValue, GameAdapter, TableRegion } from './schema'

const STATS_ENTRY = 28
const NAME_LEN = 10
const MOVE_ENTRY = 6
const MOVE_COUNT = 165
const INTERNAL_COUNT = 190

// dex#, HP, ATK, DEF, SPD, SPC, Grass, Poison, catch rate — Bulbasaur.
const BULBASAUR = [0x01, 45, 49, 49, 45, 65, 0x16, 0x03, 45]
const IVYSAUR = [0x02, 60, 62, 63, 60, 80, 0x16, 0x03, 45]
const MEW = [0x97, 100, 100, 100, 100, 100, 0x18, 0x18, 45, 64]
// Internal order starts Rhydon, Kangaskhan, Nidoran♂, Clefairy, Spearow,
// Voltorb, Nidoking, Slowbro, Ivysaur — expressed as dex numbers.
const INTERNAL_TO_DEX_SIG = [0x70, 0x73, 0x20, 0x23, 0x15, 0x64, 0x22, 0x50]
// Pound, Karate Chop (Normal-type in Gen 1), Doubleslap.
const POUND = [0x01, 0x00, 40, 0x00, 0xff, 35]
const KARATE_CHOP = [0x02, 0x00, 50, 0x00, 0xff, 25]
// TM01..TM08: Mega Punch, Razor Wind, Swords Dance, Whirlwind, Mega Kick,
// Toxic, Horn Drill, Body Slam.
const TM_LIST_SIG = [5, 13, 14, 18, 25, 92, 32, 34]

const STAT_BYTES: Record<string, number> = {
  hp: 1,
  atk: 2,
  def: 3,
  spd: 4,
  spc: 5,
  type1: 6,
  type2: 7,
  catchRate: 8,
  baseExp: 9,
  growthRate: 19,
  startMove1: 15,
  startMove2: 16,
  startMove3: 17,
  startMove4: 18,
}

export function tryBuildGen1(rom: Rom, gameName: string, platform: string): GameAdapter | null {
  const bytes = rom.bytes
  const statsOff = findVerified(bytes, BULBASAUR, [{ delta: STATS_ENTRY, pattern: IVYSAUR }])
  if (statsOff === null) return null

  const warnings: string[] = []
  const regions: TableRegion[] = []

  // Mew: inline as entry 151 (Yellow) or a standalone table (Red/Blue).
  let mewOff: number | null = null
  if (matchesAt(bytes, statsOff + 150 * STATS_ENTRY, MEW)) {
    mewOff = statsOff + 150 * STATS_ENTRY
  } else {
    const hits = findAll(bytes, MEW, 2)
    if (hits.length === 1) mewOff = hits[0]
    else warnings.push("Couldn't locate Mew's stats — Mew is not editable in this ROM.")
  }
  const speciesCount = mewOff !== null ? 151 : 150

  const mapOff = findVerified(bytes, INTERNAL_TO_DEX_SIG, [{ delta: 8, pattern: [0x02] }])
  const namesOff = findVerified(bytes, [...gen12Bytes('RHYDON'), 0x50], [
    { delta: NAME_LEN, pattern: gen12Bytes('KANGASKHAN') },
  ])
  if (mapOff === null || namesOff === null) {
    warnings.push("Couldn't locate the Pokémon name table — names are shown as numbers.")
  }

  const moveOff = findVerified(bytes, POUND, [
    { delta: MOVE_ENTRY, pattern: KARATE_CHOP },
    { delta: 2 * MOVE_ENTRY, pattern: [0x03, -1, 15, 0x00] },
  ])
  if (moveOff === null) warnings.push("Couldn't locate the move data table — move editing disabled.")

  // Move names: variable-length 0x50-terminated strings, so read-only.
  const moveNames: string[] = []
  const moveNamesOff = findVerified(
    bytes,
    [...gen12Bytes('POUND'), 0x50, ...gen12Bytes('KARATE CHOP'), 0x50],
    [],
  )
  if (moveNamesOff !== null) {
    let p = moveNamesOff
    for (let i = 0; i < MOVE_COUNT && p < bytes.length; i++) {
      let end = p
      while (end < bytes.length && bytes[end] !== 0x50) end++
      const name = gen12Codec.decode(bytes.subarray(p, end))
      // Real move names are 1-12 chars; anything else means we ran off the table.
      moveNames.push(name.length >= 1 && name.length <= 12 ? name : `Move #${i + 1}`)
      p = end + 1
    }
  }
  const moveName = (id: number) => moveNames[id - 1] ?? `Move #${id}`

  let tmMoves: number[] | null = null
  const tmOff = findVerified(bytes, TM_LIST_SIG, [])
  if (tmOff !== null) tmMoves = Array.from(bytes.subarray(tmOff, tmOff + 55))

  // dex → internal index (1-based), needed to reach names.
  const dexToInternal = new Map<number, number>()
  if (mapOff !== null) {
    for (let i = 0; i < INTERNAL_COUNT; i++) {
      const dex = bytes[mapOff + i]
      if (dex >= 1 && dex <= 151 && !dexToInternal.has(dex)) dexToInternal.set(dex, i + 1)
    }
  }

  regions.push({ name: 'Base stats', offset: statsOff, length: 150 * STATS_ENTRY })
  if (mewOff !== null && mewOff !== statsOff + 150 * STATS_ENTRY)
    regions.push({ name: 'Mew stats', offset: mewOff, length: STATS_ENTRY })
  if (namesOff !== null)
    regions.push({ name: 'Pokémon names', offset: namesOff, length: INTERNAL_COUNT * NAME_LEN })
  if (mapOff !== null)
    regions.push({ name: 'Dex order table', offset: mapOff, length: INTERNAL_COUNT })
  if (moveOff !== null)
    regions.push({ name: 'Move data', offset: moveOff, length: MOVE_COUNT * MOVE_ENTRY })
  if (tmOff !== null) regions.push({ name: 'TM/HM move list', offset: tmOff, length: 55 })

  const statsOffsetFor = (dex: number) =>
    dex === 151 && mewOff !== null ? mewOff : statsOff + (dex - 1) * STATS_ENTRY
  const nameOffsetFor = (dex: number): number | null => {
    if (namesOff === null) return null
    const internal = dexToInternal.get(dex)
    return internal ? namesOff + (internal - 1) * NAME_LEN : null
  }
  const readName = (dex: number): string => {
    const off = nameOffsetFor(dex)
    if (off === null) return `POKÉMON #${dex}`
    return gen12Codec.decode(bytes.subarray(off, off + NAME_LEN))
  }

  const tmFlagLabels: string[] = []
  for (let i = 0; i < 56; i++) {
    const label = i < 50 ? `TM${String(i + 1).padStart(2, '0')}` : i < 55 ? `HM${String(i - 49).padStart(2, '0')}` : '(unused)'
    const mv = tmMoves && i < 55 ? ` ${moveName(tmMoves[i])}` : ''
    tmFlagLabels.push(label + mv)
  }

  const speciesFields: FieldSpec[] = [
    { key: 'hp', label: 'HP', kind: 'number', min: 1, max: 255, group: 'stats' },
    { key: 'atk', label: 'Attack', kind: 'number', min: 1, max: 255, group: 'stats' },
    { key: 'def', label: 'Defense', kind: 'number', min: 1, max: 255, group: 'stats' },
    { key: 'spd', label: 'Speed', kind: 'number', min: 1, max: 255, group: 'stats' },
    { key: 'spc', label: 'Special', kind: 'number', min: 1, max: 255, group: 'stats' },
    { key: 'type1', label: 'Type 1', kind: 'type', group: 'typing' },
    { key: 'type2', label: 'Type 2', kind: 'type', group: 'typing', help: 'Set both types the same for a mono-type Pokémon.' },
    { key: 'catchRate', label: 'Catch rate', kind: 'number', min: 1, max: 255, group: 'battle' },
    { key: 'baseExp', label: 'Base EXP yield', kind: 'number', min: 0, max: 255, group: 'battle' },
    { key: 'growthRate', label: 'Level curve', kind: 'select', options: GEN12_GROWTH, group: 'battle' },
    { key: 'startMove1', label: 'Starting move 1', kind: 'move', group: 'moves' },
    { key: 'startMove2', label: 'Starting move 2', kind: 'move', group: 'moves' },
    { key: 'startMove3', label: 'Starting move 3', kind: 'move', group: 'moves' },
    { key: 'startMove4', label: 'Starting move 4', kind: 'move', group: 'moves' },
    { key: 'tmhm', label: 'TM / HM compatibility', kind: 'flags', flagLabels: tmFlagLabels, group: 'tmhm' },
  ]

  const moveFields: FieldSpec[] = [
    { key: 'power', label: 'Power', kind: 'number', min: 0, max: 255 },
    { key: 'type', label: 'Type', kind: 'type' },
    { key: 'accuracy', label: 'Accuracy', kind: 'number', min: 0, max: 255, help: 'Out of 255 — e.g. 255 = 100%, 216 = 85%.' },
    { key: 'pp', label: 'PP', kind: 'number', min: 0, max: 63 },
    { key: 'effect', label: 'Effect ID', kind: 'number', min: 0, max: 255, help: 'Battle effect index (0 = plain damage).' },
  ]
  const MOVE_BYTES: Record<string, number> = { effect: 1, power: 2, type: 3, accuracy: 4, pp: 5 }

  const species: EntryHandle[] = []
  for (let dex = 1; dex <= speciesCount; dex++) {
    species.push({ id: dex, label: `${padDex(dex)} ${readName(dex)}`, name: readName(dex) })
  }
  const moves: EntryHandle[] =
    moveOff === null
      ? []
      : Array.from({ length: MOVE_COUNT }, (_, i) => ({
          id: i + 1,
          label: `${String(i + 1).padStart(3, '0')} ${moveName(i + 1)}`,
          name: moveName(i + 1),
        }))

  return {
    gameName,
    platform,
    generation: 1,
    rom,
    regions,
    warnings,
    species,
    speciesFields,
    typeOptions: GEN1_TYPES,
    mapModule: null, // Gen 1 map/trainer/wild editing: on the roadmap
    trainerModule: null,
    wildModule: null,
    itemOptions: null,
    speciesNameLength: namesOff !== null ? NAME_LEN : null,

    readSpecies(dex) {
      const base = statsOffsetFor(dex)
      const out: Record<string, FieldValue> = {}
      for (const [key, byte] of Object.entries(STAT_BYTES)) out[key] = bytes[base + byte]
      const flags: boolean[] = []
      for (let i = 0; i < 56; i++) flags.push((bytes[base + 20 + (i >> 3)] >> (i & 7) & 1) === 1)
      out.tmhm = flags
      return out
    },

    writeSpeciesField(dex, key, value) {
      const base = statsOffsetFor(dex)
      if (key === 'tmhm' && Array.isArray(value)) {
        const flags = value as boolean[]
        for (let b = 0; b < 7; b++) {
          let v = 0
          for (let bit = 0; bit < 8; bit++) if (flags[b * 8 + bit]) v |= 1 << bit
          rom.writeU8(base + 20 + b, v)
        }
        return
      }
      const byte = STAT_BYTES[key]
      if (byte !== undefined && typeof value === 'number') rom.writeU8(base + byte, value)
    },

    setSpeciesName(dex, name) {
      const off = nameOffsetFor(dex)
      if (off === null) return false
      const encoded = gen12Codec.encode(name.toUpperCase(), NAME_LEN)
      if (!encoded || name.length === 0) return false
      rom.writeBytes(off, encoded)
      const handle = species[dex - 1]
      handle.name = readName(dex)
      handle.label = `${padDex(dex)} ${handle.name}`
      return true
    },

    revertSpecies(dex) {
      rom.revertRange(statsOffsetFor(dex), STATS_ENTRY)
      const off = nameOffsetFor(dex)
      if (off !== null) rom.revertRange(off, NAME_LEN)
      const handle = species[dex - 1]
      handle.name = readName(dex)
      handle.label = `${padDex(dex)} ${handle.name}`
    },

    moves,
    moveFields,
    moveNameLength: null,
    setMoveName: () => false,

    readMove(id) {
      const base = moveOff! + (id - 1) * MOVE_ENTRY
      const out: Record<string, FieldValue> = {}
      for (const [key, byte] of Object.entries(MOVE_BYTES)) out[key] = bytes[base + byte]
      return out
    },

    writeMoveField(id, key, value) {
      const byte = MOVE_BYTES[key]
      if (byte !== undefined && typeof value === 'number')
        rom.writeU8(moveOff! + (id - 1) * MOVE_ENTRY + byte, value)
    },

    revertMove(id) {
      rom.revertRange(moveOff! + (id - 1) * MOVE_ENTRY, MOVE_ENTRY)
    },
  }
}
