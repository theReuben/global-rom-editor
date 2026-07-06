/**
 * Generation 3 adapter — Ruby / Sapphire / Emerald / FireRed / LeafGreen
 * (and the huge ecosystem of hacks built on them).
 *
 * Tables are found by content signatures, so all five games and most
 * hacks work without per-version offset lists. Species use the internal
 * index space (1–411; 252–276 are unused placeholders).
 */
import { Rom } from '../rom'
import { findVerified } from '../scan'
import { gen3Bytes, gen3Codec } from '../text'
import { buildGen3MapModule } from '../gba/maps'
import { buildTrainerModule } from '../gba/trainers'
import { buildWildModule } from '../gba/wild'
import { buildEvolutions, buildLearnsets, buildTypeChart } from '../gba/species-extras'
import { EGG_GROUPS, GEN3_GROWTH, GEN3_TYPES, GENDER_RATIOS } from './data'
import type {
  EntryHandle,
  FieldSpec,
  FieldValue,
  GameAdapter,
  MapModule,
  SelectOption,
  TableRegion,
  TrainerModule,
  WildModule,
} from './schema'

const STATS_ENTRY = 28
const NAME_LEN = 11 // 10 chars + terminator
const MOVE_ENTRY = 12
const MOVE_NAME_LEN = 13 // 12 chars + terminator
const ABILITY_NAME_LEN = 13

/** Is this a plausible name byte (letters, digits, punct, PK/MN glyphs)? */
function nameByte(b: number): boolean {
  return b === 0x00 || (b >= 0xa1 && b <= 0xee) || (b >= 0x53 && b <= 0x56)
}

/**
 * Count consecutive valid fixed-width names from a table start. This is
 * how expanded ROMs (CFRU-style hacks with 1000+ species) get their real
 * table sizes instead of the vanilla constants.
 */
function countNames(bytes: Uint8Array, off: number, entryLen: number, cap: number): number {
  let count = 0
  while (count < cap && off + (count + 1) * entryLen <= bytes.length) {
    const o = off + count * entryLen
    const term = bytes.subarray(o, o + entryLen).indexOf(0xff)
    if (term < 1) break
    let ok = true
    for (let i = 0; i < term; i++) if (!nameByte(bytes[o + i])) ok = false
    if (!ok) break
    count++
  }
  return count
}

// HP,ATK,DEF,SPD,SAT,SDF, Grass(12), Poison(3), catch, base EXP — Bulbasaur.
const BULBASAUR = [45, 49, 49, 45, 65, 65, 12, 3, 45, 64]
const IVYSAUR = [60, 62, 63, 60, 80, 80, 12, 3, 45, 141]
// effect, power, type, accuracy, pp, effect chance, target, priority — Pound.
const POUND = [0, 40, 0, 100, 35, 0, 0, 0]
const KARATE_CHOP = [-1, 50, 1, 100, 25] // effect id varies; rest is fixed

const STAT_BYTES: Record<string, number> = {
  hp: 0,
  atk: 1,
  def: 2,
  spd: 3,
  sat: 4,
  sdf: 5,
  type1: 6,
  type2: 7,
  catchRate: 8,
  baseExp: 9,
  gender: 16,
  eggCycles: 17,
  friendship: 18,
  growthRate: 19,
  eggGroup1: 20,
  eggGroup2: 21,
  ability1: 22,
  ability2: 23,
}
const EV_STATS: [string, number][] = [
  ['evHp', 0],
  ['evAtk', 1],
  ['evDef', 2],
  ['evSpd', 3],
  ['evSat', 4],
  ['evSdf', 5],
]

export function tryBuildGen3(rom: Rom, gameName: string, platform: string): GameAdapter | null {
  const bytes = rom.bytes
  const bulbaOff = findVerified(bytes, BULBASAUR, [{ delta: STATS_ENTRY, pattern: IVYSAUR }])
  if (bulbaOff === null) return null
  const statsOff = bulbaOff - STATS_ENTRY // entry 0 is a dummy

  const warnings: string[] = []
  const regions: TableRegion[] = []

  const bulbaName = findVerified(bytes, [...gen3Bytes('BULBASAUR'), 0xff], [
    { delta: NAME_LEN, pattern: [...gen3Bytes('IVYSAUR'), 0xff] },
  ])
  const namesOff = bulbaName === null ? null : bulbaName - NAME_LEN
  // Table sizes come from the ROM itself, so expanded hacks (1000+
  // species) get their full rosters instead of the vanilla counts. The
  // name scan can overshoot into neighbouring text, so trailing entries
  // must also have plausible base stats.
  const plausibleStats = (id: number) => {
    const o = statsOff + id * STATS_ENTRY
    if (o + STATS_ENTRY > bytes.length) return false
    return bytes[o + 19] <= 5 && bytes[o + 20] <= 15 && bytes[o + 21] <= 15 // growth, egg groups
  }
  let SPECIES_COUNT = namesOff === null ? 411 : Math.max(1, countNames(bytes, namesOff, NAME_LEN, 4096) - 1)
  while (SPECIES_COUNT > 1 && !plausibleStats(SPECIES_COUNT)) SPECIES_COUNT--
  regions.push({ name: 'Base stats', offset: statsOff, length: (SPECIES_COUNT + 1) * STATS_ENTRY })
  if (namesOff === null) {
    warnings.push("Couldn't locate the Pokémon name table — names are shown as numbers.")
  } else {
    regions.push({ name: 'Pokémon names', offset: namesOff, length: (SPECIES_COUNT + 1) * NAME_LEN })
  }

  const poundOff = findVerified(bytes, POUND, [{ delta: MOVE_ENTRY, pattern: KARATE_CHOP }])
  const moveOff = poundOff === null ? null : poundOff - MOVE_ENTRY

  const poundName = findVerified(bytes, [...gen3Bytes('POUND'), 0xff], [
    { delta: MOVE_NAME_LEN, pattern: [...gen3Bytes('KARATE CHOP'), 0xff] },
  ])
  const moveNamesOff = poundName === null ? null : poundName - MOVE_NAME_LEN
  const MOVE_COUNT =
    moveNamesOff === null ? 354 : Math.max(1, countNames(bytes, moveNamesOff, MOVE_NAME_LEN, 4096) - 1)

  if (moveOff === null) warnings.push("Couldn't locate the move data table — move editing disabled.")
  else regions.push({ name: 'Move data', offset: moveOff, length: (MOVE_COUNT + 1) * MOVE_ENTRY })
  if (moveNamesOff !== null) {
    regions.push({ name: 'Move names', offset: moveNamesOff, length: (MOVE_COUNT + 1) * MOVE_NAME_LEN })
  }

  // Map data: structural discovery (see gba/mapscan.ts). A failure here
  // never blocks the rest of the editor.
  let mapModule: MapModule | null = null
  try {
    const gameCode = String.fromCharCode(...bytes.subarray(0xac, 0xb0)).replace(/[^ -~]/g, '')
    const maps = buildGen3MapModule(rom, gameCode)
    if (maps) {
      mapModule = maps.module
      regions.push({
        name: `Map bank table (${maps.index.banks.length} banks, ${maps.module.entries.length} maps)`,
        offset: maps.index.bankTableOffset,
        length: maps.index.banks.length * 4,
      })
    }
  } catch {
    mapModule = null
  }
  if (!mapModule) {
    warnings.push("Couldn't verify the map data structures — map editing is disabled for this ROM.")
  }

  // Item names: 44-byte item entries starting with a 14-byte name.
  let itemOptions: SelectOption[] | null = null
  const masterBall = findVerified(bytes, [...gen3Bytes('MASTER BALL'), 0xff], [
    { delta: 44, pattern: [...gen3Bytes('ULTRA BALL'), 0xff] },
  ])
  if (masterBall !== null) {
    const itemsOff = masterBall - 44
    itemOptions = [{ value: 0, label: '— none —' }]
    for (let i = 1; i < 500; i++) {
      const name = gen3Codec.decode(bytes.subarray(itemsOff + i * 44, itemsOff + i * 44 + 14))
      if (name.length < 1 || name.length > 14 || /\?{3,}/.test(name)) {
        if (i > 300) break // past the real table
        itemOptions.push({ value: i, label: `Item #${i}` })
        continue
      }
      itemOptions.push({ value: i, label: name })
    }
    regions.push({ name: 'Item data', offset: itemsOff, length: itemOptions.length * 44 })
  }

  // Evolutions, learnsets and the type chart — each optional.
  const evoResult = buildEvolutions(rom, SPECIES_COUNT)
  if (evoResult) {
    regions.push({ name: 'Evolutions', offset: evoResult.offset, length: (SPECIES_COUNT + 1) * 40 })
  }
  const lsResult = buildLearnsets(rom, SPECIES_COUNT)
  if (lsResult) {
    regions.push({ name: 'Learnset pointers', offset: lsResult.offset, length: (SPECIES_COUNT + 1) * 4 })
  }
  const chartResult = buildTypeChart(rom)
  if (chartResult) {
    regions.push({ name: 'Type chart', offset: chartResult.offset, length: chartResult.module.entries().length * 3 + 6 })
  }

  // Trainers: structural discovery of the 40-byte trainer table.
  let trainerModule: TrainerModule | null = null
  try {
    const trainers = buildTrainerModule(rom)
    if (trainers) {
      trainerModule = trainers.module
      regions.push({
        name: `Trainers (${trainers.count})`,
        offset: trainers.offset,
        length: trainers.count * 40,
      })
    }
  } catch {
    trainerModule = null
  }
  if (!trainerModule) {
    warnings.push("Couldn't verify the trainer table — trainer editing is disabled for this ROM.")
  }

  // Wild encounters: cross-checked against the discovered map index.
  let wildModule: WildModule | null = null
  try {
    if (mapModule) {
      const mapKeys = new Set(mapModule.entries.map((e) => e.key))
      const wild = buildWildModule(rom, mapKeys)
      if (wild) {
        wildModule = wild.module
        regions.push({
          name: `Wild encounters (${wild.module.entries.length} maps)`,
          offset: wild.offset,
          length: wild.count * 20,
        })
      }
    }
  } catch {
    wildModule = null
  }
  if (!wildModule) {
    warnings.push("Couldn't verify wild encounter tables — wild editing is disabled for this ROM.")
  }

  const stenchOff = findVerified(bytes, [...gen3Bytes('STENCH'), 0xff], [
    { delta: ABILITY_NAME_LEN, pattern: [...gen3Bytes('DRIZZLE'), 0xff] },
  ])
  const abilityNamesOff = stenchOff === null ? null : stenchOff - ABILITY_NAME_LEN
  const ABILITY_COUNT =
    abilityNamesOff === null ? 78 : countNames(bytes, abilityNamesOff, ABILITY_NAME_LEN, 1024)

  const readSlice = (off: number, len: number) => gen3Codec.decode(bytes.subarray(off, off + len))
  const speciesName = (id: number): string =>
    namesOff === null ? `SPECIES #${id}` : readSlice(namesOff + id * NAME_LEN, NAME_LEN)
  const moveName = (id: number): string =>
    moveNamesOff === null ? `Move #${id}` : readSlice(moveNamesOff + id * MOVE_NAME_LEN, MOVE_NAME_LEN)

  const abilityOptions: SelectOption[] = []
  for (let i = 0; i < ABILITY_COUNT; i++) {
    abilityOptions.push({
      value: i,
      label:
        abilityNamesOff === null
          ? i === 0
            ? '— none —'
            : `Ability #${i}`
          : i === 0
            ? '— none —'
            : readSlice(abilityNamesOff + i * ABILITY_NAME_LEN, ABILITY_NAME_LEN),
    })
  }

  const evOptions: SelectOption[] = [0, 1, 2, 3].map((v) => ({ value: v, label: String(v) }))

  const speciesFields: FieldSpec[] = [
    { key: 'hp', label: 'HP', kind: 'number', min: 1, max: 255, group: 'stats' },
    { key: 'atk', label: 'Attack', kind: 'number', min: 1, max: 255, group: 'stats' },
    { key: 'def', label: 'Defense', kind: 'number', min: 1, max: 255, group: 'stats' },
    { key: 'spd', label: 'Speed', kind: 'number', min: 1, max: 255, group: 'stats' },
    { key: 'sat', label: 'Sp. Attack', kind: 'number', min: 1, max: 255, group: 'stats' },
    { key: 'sdf', label: 'Sp. Defense', kind: 'number', min: 1, max: 255, group: 'stats' },
    { key: 'type1', label: 'Type 1', kind: 'type', group: 'typing' },
    { key: 'type2', label: 'Type 2', kind: 'type', group: 'typing', help: 'Set both types the same for a mono-type Pokémon.' },
    { key: 'ability1', label: 'Ability 1', kind: 'select', options: abilityOptions, group: 'typing' },
    { key: 'ability2', label: 'Ability 2', kind: 'select', options: abilityOptions, group: 'typing' },
    { key: 'catchRate', label: 'Catch rate', kind: 'number', min: 1, max: 255, group: 'battle' },
    { key: 'baseExp', label: 'Base EXP yield', kind: 'number', min: 0, max: 255, group: 'battle' },
    { key: 'growthRate', label: 'Level curve', kind: 'select', options: GEN3_GROWTH, group: 'battle' },
    itemOptions
      ? { key: 'item1', label: 'Wild held item 1', kind: 'select', options: itemOptions, group: 'battle', help: '50% chance in the wild.' }
      : { key: 'item1', label: 'Wild held item 1', kind: 'number', min: 0, max: 65535, group: 'battle', help: 'Item ID (0 = none). 50% chance in the wild.' },
    itemOptions
      ? { key: 'item2', label: 'Wild held item 2', kind: 'select', options: itemOptions, group: 'battle', help: '5% chance in the wild.' }
      : { key: 'item2', label: 'Wild held item 2', kind: 'number', min: 0, max: 65535, group: 'battle', help: 'Item ID (0 = none). 5% chance in the wild.' },
    { key: 'evHp', label: 'EV yield: HP', kind: 'select', options: evOptions, group: 'evs' },
    { key: 'evAtk', label: 'EV yield: Attack', kind: 'select', options: evOptions, group: 'evs' },
    { key: 'evDef', label: 'EV yield: Defense', kind: 'select', options: evOptions, group: 'evs' },
    { key: 'evSpd', label: 'EV yield: Speed', kind: 'select', options: evOptions, group: 'evs' },
    { key: 'evSat', label: 'EV yield: Sp. Atk', kind: 'select', options: evOptions, group: 'evs' },
    { key: 'evSdf', label: 'EV yield: Sp. Def', kind: 'select', options: evOptions, group: 'evs' },
    { key: 'gender', label: 'Gender ratio', kind: 'select', options: GENDER_RATIOS, group: 'breeding' },
    { key: 'eggCycles', label: 'Egg cycles', kind: 'number', min: 1, max: 255, group: 'breeding', help: 'Steps to hatch = cycles × 256.' },
    { key: 'friendship', label: 'Base friendship', kind: 'number', min: 0, max: 255, group: 'breeding' },
    { key: 'eggGroup1', label: 'Egg group 1', kind: 'select', options: EGG_GROUPS, group: 'breeding' },
    { key: 'eggGroup2', label: 'Egg group 2', kind: 'select', options: EGG_GROUPS, group: 'breeding' },
  ]

  const moveFields: FieldSpec[] = [
    { key: 'power', label: 'Power', kind: 'number', min: 0, max: 255 },
    { key: 'type', label: 'Type', kind: 'type' },
    { key: 'accuracy', label: 'Accuracy', kind: 'number', min: 0, max: 100, help: 'Percentage (0 = never misses).' },
    { key: 'pp', label: 'PP', kind: 'number', min: 0, max: 63 },
    { key: 'effect', label: 'Effect ID', kind: 'number', min: 0, max: 255, help: 'Battle effect index (0 = plain damage).' },
    { key: 'effectChance', label: 'Effect chance %', kind: 'number', min: 0, max: 100 },
    { key: 'priority', label: 'Priority', kind: 'number', min: -8, max: 7, help: 'Higher acts first (Quick Attack = +1).' },
    {
      key: 'flags',
      label: 'Move flags',
      kind: 'flags',
      flagLabels: ['Makes contact', 'Blocked by Protect', 'Reflected by Magic Coat', 'Stolen by Snatch', 'Copied by Mirror Move', 'Boosted by King’s Rock'],
    },
  ]
  const MOVE_BYTES: Record<string, number> = {
    effect: 0,
    power: 1,
    type: 2,
    accuracy: 3,
    pp: 4,
    effectChance: 5,
  }

  const species: EntryHandle[] = []
  for (let id = 1; id <= SPECIES_COUNT; id++) {
    const name = speciesName(id)
    species.push({ id, label: `#${String(id).padStart(3, '0')} ${name || '(blank)'}`, name })
  }
  const moves: EntryHandle[] =
    moveOff === null
      ? []
      : Array.from({ length: MOVE_COUNT }, (_, i) => ({
          id: i + 1,
          label: `${String(i + 1).padStart(3, '0')} ${moveName(i + 1)}`,
          name: moveName(i + 1),
        }))

  const statsBase = (id: number) => statsOff + id * STATS_ENTRY
  const moveBase = (id: number) => moveOff! + id * MOVE_ENTRY

  const refreshHandle = (id: number) => {
    const handle = species[id - 1]
    handle.name = speciesName(id)
    handle.label = `#${String(id).padStart(3, '0')} ${handle.name || '(blank)'}`
  }

  return {
    gameName,
    platform,
    generation: 3,
    rom,
    regions,
    warnings,
    species,
    speciesFields,
    typeOptions: GEN3_TYPES,
    mapModule,
    trainerModule,
    wildModule,
    itemOptions,
    evolutions: evoResult?.module ?? null,
    learnsets: lsResult?.module ?? null,
    typeChart: chartResult?.module ?? null,
    speciesNameLength: namesOff !== null ? NAME_LEN - 1 : null,

    readSpecies(id) {
      const base = statsBase(id)
      const out: Record<string, FieldValue> = {}
      for (const [key, byte] of Object.entries(STAT_BYTES)) out[key] = bytes[base + byte]
      out.item1 = rom.readU16LE(base + 12)
      out.item2 = rom.readU16LE(base + 14)
      const ev = rom.readU16LE(base + 10)
      for (const [key, idx] of EV_STATS) out[key] = (ev >> (idx * 2)) & 3
      return out
    },

    writeSpeciesField(id, key, value) {
      if (typeof value !== 'number') return
      const base = statsBase(id)
      if (key === 'item1') return rom.writeU16LE(base + 12, value)
      if (key === 'item2') return rom.writeU16LE(base + 14, value)
      const ev = EV_STATS.find(([k]) => k === key)
      if (ev) {
        const idx = ev[1]
        const cur = rom.readU16LE(base + 10)
        rom.writeU16LE(base + 10, (cur & ~(3 << (idx * 2))) | ((value & 3) << (idx * 2)))
        return
      }
      const byte = STAT_BYTES[key]
      if (byte !== undefined) rom.writeU8(base + byte, value)
    },

    setSpeciesName(id, name) {
      if (namesOff === null) return false
      const encoded = gen3Codec.encode(name.toUpperCase(), NAME_LEN - 1)
      if (!encoded || name.length === 0) return false
      rom.writeBytes(namesOff + id * NAME_LEN, [...encoded, 0xff].slice(0, NAME_LEN))
      refreshHandle(id)
      return true
    },

    revertSpecies(id) {
      rom.revertRange(statsBase(id), STATS_ENTRY)
      if (namesOff !== null) rom.revertRange(namesOff + id * NAME_LEN, NAME_LEN)
      refreshHandle(id)
    },

    moves,
    moveFields,
    moveNameLength: moveNamesOff !== null ? MOVE_NAME_LEN - 1 : null,

    setMoveName(id, name) {
      if (moveNamesOff === null) return false
      const encoded = gen3Codec.encode(name.toUpperCase(), MOVE_NAME_LEN - 1)
      if (!encoded || name.length === 0) return false
      rom.writeBytes(moveNamesOff + id * MOVE_NAME_LEN, [...encoded, 0xff].slice(0, MOVE_NAME_LEN))
      const handle = moves[id - 1]
      handle.name = moveName(id)
      handle.label = `${String(id).padStart(3, '0')} ${handle.name}`
      return true
    },

    readMove(id) {
      const base = moveBase(id)
      const out: Record<string, FieldValue> = {}
      for (const [key, byte] of Object.entries(MOVE_BYTES)) out[key] = bytes[base + byte]
      const raw = bytes[base + 7]
      out.priority = raw >= 128 ? raw - 256 : raw
      const flagByte = bytes[base + 8]
      out.flags = [0, 1, 2, 3, 4, 5].map((i) => ((flagByte >> i) & 1) === 1)
      return out
    },

    writeMoveField(id, key, value) {
      const base = moveBase(id)
      if (key === 'flags' && Array.isArray(value)) {
        let v = bytes[base + 8]
        const flags = value as boolean[]
        for (let i = 0; i < 6; i++) v = flags[i] ? v | (1 << i) : v & ~(1 << i)
        rom.writeU8(base + 8, v)
        return
      }
      if (typeof value !== 'number') return
      if (key === 'priority') return rom.writeU8(base + 7, value < 0 ? value + 256 : value)
      const byte = MOVE_BYTES[key]
      if (byte !== undefined) rom.writeU8(base + byte, value)
    },

    revertMove(id) {
      rom.revertRange(moveBase(id), MOVE_ENTRY)
      if (moveNamesOff !== null) rom.revertRange(moveNamesOff + id * MOVE_NAME_LEN, MOVE_NAME_LEN)
      const handle = moves[id - 1]
      handle.name = moveName(id)
      handle.label = `${String(id).padStart(3, '0')} ${handle.name}`
    },
  }
}
