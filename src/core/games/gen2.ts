/**
 * Generation 2 adapter — Pokémon Gold / Silver / Crystal (and derived hacks).
 *
 * Gen 2 stores base stats and names both in Pokédex order (251 entries),
 * which makes life easier than Gen 1. Base stat entries are 32 bytes.
 */
import { Rom } from '../rom'
import { findVerified } from '../scan'
import { gen12Bytes, gen12Codec } from '../text'
import { EGG_GROUPS, GEN2_TYPES, GEN12_GROWTH, GENDER_RATIOS, padDex } from './data'
import { GEN2_MAP_NAMES } from './gen2-constants'
import type {
  EntryHandle,
  FieldSpec,
  FieldValue,
  GameAdapter,
  TableRegion,
  TrainerModule,
  WildModule,
} from './schema'

const STATS_ENTRY = 32
const NAME_LEN = 10
const MOVE_ENTRY = 7
const COUNT = 251

// dex#, HP, ATK, DEF, SPD, SAT, SDF, Grass, Poison, catch — Bulbasaur.
const BULBASAUR = [0x01, 45, 49, 49, 45, 65, 65, 0x16, 0x03, 45]
const IVYSAUR = [0x02, 60, 62, 63, 60, 80, 80, 0x16, 0x03, 45]
// animation, effect, power, type, accuracy(255=100%), pp, effect chance.
const POUND = [0x01, 0x00, 40, 0x00, 0xff, 35, 0x00]
const KARATE_CHOP = [0x02, 0x00, 50, 0x01, 0xff, 25, 0x00] // Fighting in Gen 2
// TM01..TM08: DynamicPunch, Headbutt, Curse, Rollout, Roar, Toxic,
// Zap Cannon, Rock Smash.
const TM_LIST_SIG = [223, 29, 174, 205, 46, 92, 192, 249]

const STAT_BYTES: Record<string, number> = {
  hp: 1,
  atk: 2,
  def: 3,
  spd: 4,
  sat: 5,
  sdf: 6,
  type1: 7,
  type2: 8,
  catchRate: 9,
  baseExp: 10,
  item1: 11,
  item2: 12,
  gender: 13,
  eggCycles: 15,
  growthRate: 22,
}


/* -------------------------------------------------------- wild (Crystal) */

const GRASS_BLOCK = 47 // group, map, 3 rates, 3 × 7 (level, species)
const WATER_BLOCK = 9 // group, map, rate, 3 × (level, species)
const TIME_NAMES = ['Grass (morning)', 'Grass (day)', 'Grass (night)']

// Sprout Tower 2F — the first Johto grass block, byte-identical in
// Gold, Silver and Crystal (verified against pokegold and pokecrystal).
const SPROUT_RATES_MORN_DAY = [
  5, 5, 5,
  3, 19, 4, 19, 5, 19, 3, 19, 6, 19, 5, 19, 5, 19,
  3, 19, 4, 19, 5, 19, 3, 19, 6, 19, 5, 19, 5, 19,
]
const SPROUT_NITE = [3, 92, 4, 92, 5, 92] // Gastly at night

interface Gen2WildArea {
  key: string
  grass: number | null // block offset
  water: number | null
}

function buildGen2Wild(rom: Rom): { module: WildModule; offset: number; count: number } | null {
  const bytes = rom.bytes
  const anchor = findVerified(bytes, SPROUT_RATES_MORN_DAY, [{ delta: 31, pattern: SPROUT_NITE }])
  if (anchor === null) return null
  const start = anchor - 2 // group/map bytes precede the rates

  const plausible = (p: number, block: number): boolean => {
    if (bytes[p] === 0xff || bytes[p] < 1 || bytes[p] > 26 || bytes[p + 1] < 1 || bytes[p + 1] > 120) return false
    const pairsOff = block === GRASS_BLOCK ? p + 5 : p + 3
    for (let i = pairsOff; i < p + block; i += 2) {
      if (bytes[i] < 1 || bytes[i] > 100 || bytes[i + 1] < 1 || bytes[i + 1] > 251) return false
    }
    return true
  }

  const areas = new Map<string, Gen2WildArea>()
  const area = (key: string): Gen2WildArea => {
    if (!areas.has(key)) areas.set(key, { key, grass: null, water: null })
    return areas.get(key)!
  }

  // Johto grass → Johto water → Kanto grass → Kanto water are laid out
  // back to back, each list 0xFF-terminated. Every block is validated;
  // an implausible block ends the walk safely.
  let p = start
  let end = start
  for (const kind of ['grass', 'water', 'grass', 'water'] as const) {
    const size = kind === 'grass' ? GRASS_BLOCK : WATER_BLOCK
    let n = 0
    while (n < 200 && bytes[p] !== 0xff && plausible(p, size)) {
      const key = `${bytes[p]}.${bytes[p + 1]}`
      area(key)[kind] = p
      p += size
      n++
    }
    if (bytes[p] !== 0xff) break // unexpected layout: keep what validated
    p++
    end = p
  }
  if (areas.size < 5) return null

  const entries = [...areas.values()].map((a) => ({
    key: a.key,
    label: GEN2_MAP_NAMES[a.key] ?? `Map ${a.key}`,
  }))

  const groupDefs = (key: string) => {
    const a = areas.get(key)
    const out: { name: string; rateOff: number; monsOff: number; slots: number }[] = []
    if (!a) return out
    if (a.grass !== null) {
      for (let t = 0; t < 3; t++) {
        out.push({ name: TIME_NAMES[t], rateOff: a.grass + 2 + t, monsOff: a.grass + 5 + t * 14, slots: 7 })
      }
    }
    if (a.water !== null) out.push({ name: 'Water', rateOff: a.water + 2, monsOff: a.water + 3, slots: 3 })
    return out
  }

  const module: WildModule = {
    entries,
    groups(key) {
      return groupDefs(key).map((g) => ({
        name: g.name,
        rate: bytes[g.rateOff],
        slots: Array.from({ length: g.slots }, (_, i) => ({
          minLevel: bytes[g.monsOff + i * 2],
          maxLevel: bytes[g.monsOff + i * 2],
          species: bytes[g.monsOff + i * 2 + 1], // Gen 2 uses dex ids directly
        })),
      }))
    },
    setRate(key, group, rate) {
      const g = groupDefs(key)[group]
      if (g) rom.writeU8(g.rateOff, rate)
    },
    setSlot(key, group, slot, field, value) {
      const g = groupDefs(key)[group]
      if (!g || slot < 0 || slot >= g.slots) return
      if (field === 'minLevel' || field === 'maxLevel') rom.writeU8(g.monsOff + slot * 2, value)
      else if (field === 'species' && value >= 1 && value <= 251) rom.writeU8(g.monsOff + slot * 2 + 1, value)
    },
    revert(key) {
      const a = areas.get(key)
      if (!a) return
      if (a.grass !== null) rom.revertRange(a.grass, GRASS_BLOCK)
      if (a.water !== null) rom.revertRange(a.water, WATER_BLOCK)
    },
  }
  return { module, offset: start, count: end - start }
}

/* ------------------------------------------------------ trainers (G/S/C) */

// FalknerGroup — byte-identical in Gold, Silver and Crystal (pokegold /
// pokecrystal data/trainers/parties.asm): "FALKNER@", TRAINERTYPE_MOVES,
// then Pidgey lv7 / Pidgeotto lv9 with Tackle + Mud-Slap (+ Gust).
const FALKNER_GROUP = [
  ...gen12Bytes('FALKNER'), 0x50, 1,
  7, 16, 33, 189, 0, 0,
  9, 17, 33, 189, 16, 0,
  0xff,
]
// WhitneyGroup follows immediately: Clefairy lv18 / Miltank lv20.
const WHITNEY_GROUP = [
  ...gen12Bytes('WHITNEY'), 0x50, 1,
  18, 35, 3, 102, 227, 118,
  20, 241, 205, 213, 23, 208,
  0xff,
]
const MIN_CLASSES = 30
const MAX_CLASSES = 100
const TRAINER_NAME_MAX = 12
const GEN2_MAX_LEVEL = 100

interface Gen2TrainerRec {
  classId: number
  indexInClass: number
  off: number
  len: number
  /** TRAINERTYPE_*: bit 0 = custom moves, bit 1 = held item. */
  type: number
  nameLen: number
}

/**
 * Gen 2 trainer parties: one bank-local pointer per trainer class, each
 * leading to consecutive trainers of "NAME@", type byte, 1-6 mons whose
 * entry size depends on the type, terminated by 0xFF. Scripts reference
 * trainers by class + number, so edits are strictly in place.
 */
function buildGen2Trainers(rom: Rom): { module: TrainerModule; offset: number; classCount: number; trainerCount: number } | null {
  const bytes = rom.bytes
  const toLocal = (off: number) => 0x4000 + (off % 0x4000)

  // Validates "offset starts a trainer": short name of displayable
  // characters, terminator, known type byte, plausible first mon.
  const validTrainerStart = (p: number): boolean => {
    let n = 0
    while (n < TRAINER_NAME_MAX && bytes[p + n] !== 0x50) {
      if (bytes[p + n] < 0x60) return false
      n++
    }
    if (n === 0 || n >= TRAINER_NAME_MAX) return false
    const type = bytes[p + n + 1]
    const level = bytes[p + n + 2]
    const species = bytes[p + n + 3]
    return type <= 3 && level >= 1 && level <= GEN2_MAX_LEVEL && species >= 1 && species <= COUNT
  }

  const validTableAt = (start: number, classes: number): boolean => {
    const bank = Math.floor(start / 0x4000)
    let prev = 0x4000
    for (let c = 0; c < classes; c++) {
      const v = rom.readU16LE(start + c * 2)
      if (v < prev || v >= 0x8000) return false
      if (!validTrainerStart(bank * 0x4000 + (v - 0x4000))) return false
      prev = v
    }
    return true
  }

  // Primary: the Falkner anchor with the pointer table right before the
  // first group, its length recovered from entry 0 (66 in G/S, 67 in
  // Crystal — never assumed).
  let tableOff: number | null = null
  let classCount = 0
  const anchor = findVerified(bytes, FALKNER_GROUP, [{ delta: FALKNER_GROUP.length, pattern: WHITNEY_GROUP }])
  if (anchor !== null) {
    for (let k = MIN_CLASSES; k <= MAX_CLASSES; k++) {
      const t = anchor - k * 2
      if (t < 0) break
      if (rom.readU16LE(t) !== toLocal(anchor)) continue
      if (Math.floor(t / 0x4000) !== Math.floor(anchor / 0x4000)) break
      if (validTableAt(t, k)) {
        tableOff = t
        classCount = k
      }
      break
    }
  }
  // Fallback (survives edits to Falkner, who is a real editable
  // trainer): the table is self-referencing — entry 0 points exactly
  // 2 × classCount bytes past the table start.
  if (tableOff === null) {
    for (let o = 0; o + MIN_CLASSES * 2 <= bytes.length; o++) {
      const span = rom.readU16LE(o) - toLocal(o)
      if (span % 2 !== 0) continue
      const k = span / 2
      if (k < MIN_CLASSES || k > MAX_CLASSES) continue
      if (validTableAt(o, k)) {
        tableOff = o
        classCount = k
        break
      }
    }
  }
  if (tableOff === null) return null
  const bank = Math.floor(tableOff / 0x4000)
  const toFile = (local: number) => bank * 0x4000 + (local - 0x4000)

  const ptrs: number[] = []
  for (let c = 0; c < classCount; c++) ptrs.push(rom.readU16LE(tableOff + c * 2))

  const monSize = (type: number) => 2 + (type & 1 ? 4 : 0) + (type & 2 ? 1 : 0)

  // Parse one trainer; returns null when the bytes don't fit the format.
  const parseTrainer = (c: number, index: number, p: number): Gen2TrainerRec | null => {
    if (!validTrainerStart(p)) return null
    let nameLen = 0
    while (bytes[p + nameLen] !== 0x50) nameLen++
    const type = bytes[p + nameLen + 1]
    let q = p + nameLen + 2
    let mons = 0
    while (bytes[q] !== 0xff) {
      const level = bytes[q]
      const species = bytes[q + 1]
      if (level < 1 || level > GEN2_MAX_LEVEL || species < 1 || species > COUNT || mons >= 6) return null
      q += monSize(type)
      mons++
    }
    if (mons === 0) return null
    return { classId: c, indexInClass: index, off: p, len: q + 1 - p, type, nameLen }
  }

  const parseClass = (c: number): Gen2TrainerRec[] => {
    // Duplicate pointers = unused alias class; the later one owns the data.
    for (let d = c + 1; d < classCount; d++) if (ptrs[d] === ptrs[c]) return []
    let end = (bank + 1) * 0x4000
    let nextLocal = Infinity
    for (const p of ptrs) if (p > ptrs[c] && p < nextLocal) nextLocal = p
    if (nextLocal !== Infinity) end = toFile(nextLocal)

    const out: Gen2TrainerRec[] = []
    let p = toFile(ptrs[c])
    while (p < end && out.length < 200) {
      const rec = parseTrainer(c, out.length, p)
      if (!rec) break
      out.push(rec)
      p += rec.len
    }
    return out
  }

  const trainers: Gen2TrainerRec[] = []
  for (let c = 0; c < classCount; c++) trainers.push(...parseClass(c))
  if (trainers.length === 0) return null

  // Class names ("LEADER", "YOUNGSTER", ...): 0x50-terminated strings.
  // The table opens with eight LEADERs then RIVAL; the unique
  // LEADER→RIVAL transition anchors it (a LEADER-only pattern would hit
  // ambiguously inside the run), backed up by the run itself.
  const classNames: string[] = []
  const leader = [...gen12Bytes('LEADER'), 0x50]
  const transition = findVerified(
    bytes,
    [...leader, ...gen12Bytes('RIVAL'), 0x50],
    [{ delta: -14, pattern: [...leader, ...leader] }],
  )
  if (transition !== null) {
    let p = transition - 7 * leader.length // rewind to the first LEADER
    for (let c = 0; c < classCount; c++) {
      let end = p
      while (end < bytes.length && bytes[end] !== 0x50) end++
      const name = gen12Codec.decode(bytes.subarray(p, end))
      classNames.push(name.length >= 1 && name.length <= 13 ? name : `Class ${c + 1}`)
      p = end + 1
    }
  }
  const className = (c: number) => classNames[c] ?? `Class ${c + 1}`

  const readTrainerName = (t: Gen2TrainerRec) => gen12Codec.decode(bytes.subarray(t.off, t.off + t.nameLen)).trimEnd()

  const entries: EntryHandle[] = trainers.map((t, i) => ({
    id: i,
    label: `${readTrainerName(t)} (${className(t.classId)} #${t.indexInClass + 1})`,
    name: readTrainerName(t),
  }))
  const refreshEntry = (id: number) => {
    const t = trainers[id]
    entries[id].name = readTrainerName(t)
    entries[id].label = `${entries[id].name} (${className(t.classId)} #${t.indexInClass + 1})`
  }

  const monOffsets = (t: Gen2TrainerRec) => {
    const size = monSize(t.type)
    const out: number[] = []
    for (let q = t.off + t.nameLen + 2; bytes[q] !== 0xff; q += size) out.push(q)
    return out
  }

  const module: TrainerModule = {
    entries,
    nameLength: 10,
    features: { identity: false, ai: false, items: false, partySize: false },
    classOptions:
      classNames.length > 0 ? classNames.map((label, i) => ({ value: i, label: `${label} (#${i + 1})` })) : null,
    read(id) {
      const t = trainers[id]
      const size = monOffsets(t).length
      return {
        name: readTrainerName(t),
        trainerClass: t.classId,
        pic: 0,
        music: 0,
        gender: 0,
        doubleBattle: 0,
        aiFlags: 0,
        items: [],
        partySize: size,
        maxPartySize: size,
      }
    },
    write() {},
    setName(id, name) {
      const t = trainers[id]
      // Same-footprint rename: shorter names pad with spaces before the
      // terminator so the byte layout never shifts.
      const encoded = gen12Codec.encode(name.toUpperCase(), t.nameLen)
      if (!encoded || name.length === 0) return false
      rom.writeBytes(t.off, encoded.map((b) => (b === 0x50 ? 0x7f : b)))
      refreshEntry(id)
      return true
    },
    setItem() {},
    party(id) {
      const t = trainers[id]
      return monOffsets(t).map((q) => ({
        level: bytes[q],
        species: bytes[q + 1], // Gen 2 species ids are dex numbers
        iv: null,
        item: t.type & 2 ? bytes[q + 2] : null,
        moves: t.type & 1
          ? Array.from({ length: 4 }, (_, m) => bytes[q + 2 + (t.type & 2 ? 1 : 0) + m])
          : null,
      }))
    },
    writePartyField(id, slot, field, value) {
      const t = trainers[id]
      const q = monOffsets(t)[slot]
      if (q === undefined) return
      // Level 0xFF would read as the party terminator; stay in 1-100.
      if (field === 'level') rom.writeU8(q, Math.max(1, Math.min(GEN2_MAX_LEVEL, value)))
      else if (field === 'species' && value >= 1 && value <= COUNT) rom.writeU8(q + 1, value)
      else if (field === 'item' && t.type & 2 && value >= 0 && value <= 255) rom.writeU8(q + 2, value)
      else if (field.startsWith('move') && t.type & 1) {
        const m = Number(field.slice(4))
        if (m >= 0 && m < 4 && value >= 0 && value <= 255)
          rom.writeU8(q + 2 + (t.type & 2 ? 1 : 0) + m, value)
      }
    },
    revert(id) {
      const t = trainers[id]
      rom.revertRange(t.off, t.len)
      refreshEntry(id)
    },
  }
  return { module, offset: tableOff, classCount, trainerCount: trainers.length }
}

export function tryBuildGen2(rom: Rom, gameName: string, platform: string): GameAdapter | null {
  const bytes = rom.bytes
  const statsOff = findVerified(bytes, BULBASAUR, [{ delta: STATS_ENTRY, pattern: IVYSAUR }])
  if (statsOff === null) return null

  const warnings: string[] = []
  const regions: TableRegion[] = [
    { name: 'Base stats', offset: statsOff, length: COUNT * STATS_ENTRY },
  ]

  const namesOff = findVerified(bytes, [...gen12Bytes('BULBASAUR'), 0x50], [
    { delta: NAME_LEN, pattern: [...gen12Bytes('IVYSAUR'), 0x50] },
  ])
  if (namesOff === null) {
    warnings.push("Couldn't locate the Pokémon name table — names are shown as numbers.")
  } else {
    regions.push({ name: 'Pokémon names', offset: namesOff, length: COUNT * NAME_LEN })
  }

  const moveOff = findVerified(bytes, POUND, [{ delta: MOVE_ENTRY, pattern: KARATE_CHOP }])
  if (moveOff === null) warnings.push("Couldn't locate the move data table — move editing disabled.")
  else regions.push({ name: 'Move data', offset: moveOff, length: COUNT * MOVE_ENTRY })

  // Move names: variable-length strings, located and read for display only.
  const moveNames: string[] = []
  const moveNamesOff = findVerified(
    bytes,
    [...gen12Bytes('POUND'), 0x50, ...gen12Bytes('KARATE CHOP'), 0x50],
    [],
  )
  if (moveNamesOff !== null) {
    let p = moveNamesOff
    for (let i = 0; i < COUNT && p < bytes.length; i++) {
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
  if (tmOff !== null) {
    tmMoves = Array.from(bytes.subarray(tmOff, tmOff + 57))
    regions.push({ name: 'TM/HM move list', offset: tmOff, length: 57 })
  }

  const tmFlagLabels: string[] = []
  for (let i = 0; i < 64; i++) {
    const label =
      i < 50
        ? `TM${String(i + 1).padStart(2, '0')}`
        : i < 57
          ? `HM${String(i - 49).padStart(2, '0')}`
          : `Tutor/extra ${i - 56}`
    const mv = tmMoves && i < 57 ? ` ${moveName(tmMoves[i])}` : ''
    tmFlagLabels.push(label + mv)
  }

  // Wild encounters (Gold / Silver / Crystal share the anchor block).
  const wild = buildGen2Wild(rom)
  if (wild) {
    regions.push({ name: `Wild encounters (${wild.module.entries.length} areas)`, offset: wild.offset, length: wild.count })
  } else {
    warnings.push("Couldn't locate wild encounter data — wild editing disabled for this ROM.")
  }

  // Trainer parties.
  const trainers = buildGen2Trainers(rom)
  if (trainers) {
    regions.push({
      name: `Trainer parties (${trainers.trainerCount} trainers, ${trainers.classCount} classes)`,
      offset: trainers.offset,
      length: trainers.classCount * 2,
    })
  } else {
    warnings.push("Couldn't locate trainer party data — trainer editing disabled for this ROM.")
  }

  const readName = (dex: number): string =>
    namesOff === null
      ? `POKÉMON #${dex}`
      : gen12Codec.decode(bytes.subarray(namesOff + (dex - 1) * NAME_LEN, namesOff + dex * NAME_LEN))

  const speciesFields: FieldSpec[] = [
    { key: 'hp', label: 'HP', kind: 'number', min: 1, max: 255, group: 'stats' },
    { key: 'atk', label: 'Attack', kind: 'number', min: 1, max: 255, group: 'stats' },
    { key: 'def', label: 'Defense', kind: 'number', min: 1, max: 255, group: 'stats' },
    { key: 'spd', label: 'Speed', kind: 'number', min: 1, max: 255, group: 'stats' },
    { key: 'sat', label: 'Sp. Attack', kind: 'number', min: 1, max: 255, group: 'stats' },
    { key: 'sdf', label: 'Sp. Defense', kind: 'number', min: 1, max: 255, group: 'stats' },
    { key: 'type1', label: 'Type 1', kind: 'type', group: 'typing' },
    { key: 'type2', label: 'Type 2', kind: 'type', group: 'typing', help: 'Set both types the same for a mono-type Pokémon.' },
    { key: 'catchRate', label: 'Catch rate', kind: 'number', min: 1, max: 255, group: 'battle' },
    { key: 'baseExp', label: 'Base EXP yield', kind: 'number', min: 0, max: 255, group: 'battle' },
    { key: 'growthRate', label: 'Level curve', kind: 'select', options: GEN12_GROWTH, group: 'battle' },
    { key: 'item1', label: 'Wild held item 1', kind: 'number', min: 0, max: 255, group: 'battle', help: 'Item ID (0 = none).' },
    { key: 'item2', label: 'Wild held item 2', kind: 'number', min: 0, max: 255, group: 'battle', help: 'Item ID (0 = none).' },
    { key: 'gender', label: 'Gender ratio', kind: 'select', options: GENDER_RATIOS, group: 'breeding' },
    { key: 'eggCycles', label: 'Egg cycles', kind: 'number', min: 1, max: 255, group: 'breeding', help: 'Steps to hatch = cycles × 256.' },
    { key: 'eggGroup1', label: 'Egg group 1', kind: 'select', options: EGG_GROUPS, group: 'breeding' },
    { key: 'eggGroup2', label: 'Egg group 2', kind: 'select', options: EGG_GROUPS, group: 'breeding' },
    { key: 'tmhm', label: 'TM / HM compatibility', kind: 'flags', flagLabels: tmFlagLabels, group: 'tmhm' },
  ]

  const moveFields: FieldSpec[] = [
    { key: 'power', label: 'Power', kind: 'number', min: 0, max: 255 },
    { key: 'type', label: 'Type', kind: 'type' },
    { key: 'accuracy', label: 'Accuracy', kind: 'number', min: 0, max: 255, help: 'Out of 255 — e.g. 255 = 100%, 216 = 85%.' },
    { key: 'pp', label: 'PP', kind: 'number', min: 0, max: 63 },
    { key: 'effect', label: 'Effect ID', kind: 'number', min: 0, max: 255, help: 'Battle effect index (0 = plain damage).' },
    { key: 'effectChance', label: 'Effect chance', kind: 'number', min: 0, max: 255, help: 'Out of 255 — e.g. 25 ≈ 10%.' },
  ]
  const MOVE_BYTES: Record<string, number> = {
    effect: 1,
    power: 2,
    type: 3,
    accuracy: 4,
    pp: 5,
    effectChance: 6,
  }

  const species: EntryHandle[] = []
  for (let dex = 1; dex <= COUNT; dex++) {
    species.push({ id: dex, label: `${padDex(dex)} ${readName(dex)}`, name: readName(dex) })
  }
  const moves: EntryHandle[] =
    moveOff === null
      ? []
      : Array.from({ length: COUNT }, (_, i) => ({
          id: i + 1,
          label: `${String(i + 1).padStart(3, '0')} ${moveName(i + 1)}`,
          name: moveName(i + 1),
        }))

  const statsBase = (dex: number) => statsOff + (dex - 1) * STATS_ENTRY

  return {
    gameName,
    platform,
    generation: 2,
    rom,
    regions,
    warnings,
    species,
    speciesFields,
    typeOptions: GEN2_TYPES,
    mapModule: null, // Gen 2 map editing: on the roadmap
    trainerModule: trainers?.module ?? null,
    wildModule: wild?.module ?? null,
    itemOptions: null,
    speciesSprite: null,
    speciesSpriteBack: null,
    importSpeciesSprite: null,
    importSpeciesSpriteBack: null,
    evolutions: null,
    learnsets: null,
    typeChart: null,
    speciesNameLength: namesOff !== null ? NAME_LEN : null,

    readSpecies(dex) {
      const base = statsBase(dex)
      const out: Record<string, FieldValue> = {}
      for (const [key, byte] of Object.entries(STAT_BYTES)) out[key] = bytes[base + byte]
      out.eggGroup1 = bytes[base + 23] >> 4
      out.eggGroup2 = bytes[base + 23] & 0x0f
      const flags: boolean[] = []
      for (let i = 0; i < 64; i++) flags.push(((bytes[base + 24 + (i >> 3)] >> (i & 7)) & 1) === 1)
      out.tmhm = flags
      return out
    },

    writeSpeciesField(dex, key, value) {
      const base = statsBase(dex)
      if (key === 'tmhm' && Array.isArray(value)) {
        const flags = value as boolean[]
        for (let b = 0; b < 8; b++) {
          let v = 0
          for (let bit = 0; bit < 8; bit++) if (flags[b * 8 + bit]) v |= 1 << bit
          rom.writeU8(base + 24 + b, v)
        }
        return
      }
      if (typeof value !== 'number') return
      if (key === 'eggGroup1') {
        rom.writeU8(base + 23, ((value & 0x0f) << 4) | (bytes[base + 23] & 0x0f))
        return
      }
      if (key === 'eggGroup2') {
        rom.writeU8(base + 23, (bytes[base + 23] & 0xf0) | (value & 0x0f))
        return
      }
      const byte = STAT_BYTES[key]
      if (byte !== undefined) rom.writeU8(base + byte, value)
    },

    setSpeciesName(dex, name) {
      if (namesOff === null) return false
      const encoded = gen12Codec.encode(name.toUpperCase(), NAME_LEN)
      if (!encoded || name.length === 0) return false
      rom.writeBytes(namesOff + (dex - 1) * NAME_LEN, encoded)
      const handle = species[dex - 1]
      handle.name = readName(dex)
      handle.label = `${padDex(dex)} ${handle.name}`
      return true
    },

    revertSpecies(dex) {
      rom.revertRange(statsBase(dex), STATS_ENTRY)
      if (namesOff !== null) rom.revertRange(namesOff + (dex - 1) * NAME_LEN, NAME_LEN)
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
