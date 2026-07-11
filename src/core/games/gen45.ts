/**
 * Generation 4/5 adapter — Nintendo DS games (Diamond/Pearl/Platinum,
 * HeartGold/SoulSilver, Black/White/B2W2) and hacks built on them,
 * e.g. Platinum Kaizo.
 *
 * DS data lives in the NitroFS file system, so tables are opened by
 * path instead of signature-scanned. The Gen 4 personal entry (44 bytes,
 * one NARC subfile per species) is byte-verified against the
 * pret/pokeplatinum struct and is a superset of Gen 3's layout. Gen 5
 * changed the layout past the catch rate, so only the stable prefix is
 * editable there until verified further (see docs/HANDOFF.md).
 */
import { Rom } from '../rom'
import { isNdsRom, parseNdsHeader, listNdsFiles, findNdsFile, parseNarc, type NarcSubfile } from '../nds/nds'
import { EGG_GROUPS, GEN3_GROWTH, GEN3_TYPES, GENDER_RATIOS } from './data'
import { NATDEX_NAMES, NATDEX_ABILITIES } from './natdex-names'
import type {
  EntryHandle,
  FieldSpec,
  FieldValue,
  GameAdapter,
  SelectOption,
  TrainerModule,
  WildModule,
} from './schema'

const GEN4_ENTRY = 44

/** Gen 5 dropped the ??? type; everything after Ghost/Steel shifts down. */
const GEN5_TYPES: SelectOption[] = GEN3_TYPES.filter((t) => t.value !== 9).map((t) => ({
  value: t.value > 9 ? t.value - 1 : t.value,
  label: t.label,
}))

const GAMES: { prefix: string; name: string; gen: 4 | 5; paths: string[] }[] = [
  { prefix: 'ADA', name: 'Pokémon Diamond', gen: 4, paths: ['/poketool/personal/personal.narc'] },
  { prefix: 'APA', name: 'Pokémon Pearl', gen: 4, paths: ['/poketool/personal/personal.narc'] },
  { prefix: 'CPU', name: 'Pokémon Platinum', gen: 4, paths: ['/poketool/personal/pl_personal.narc'] },
  { prefix: 'IPK', name: 'Pokémon HeartGold', gen: 4, paths: ['/a/0/0/2'] },
  { prefix: 'IPG', name: 'Pokémon SoulSilver', gen: 4, paths: ['/a/0/0/2'] },
  { prefix: 'IRB', name: 'Pokémon Black', gen: 5, paths: ['/a/0/1/6'] },
  { prefix: 'IRA', name: 'Pokémon White', gen: 5, paths: ['/a/0/1/6'] },
  { prefix: 'IRE', name: 'Pokémon Black 2', gen: 5, paths: ['/a/0/1/6'] },
  { prefix: 'IRD', name: 'Pokémon White 2', gen: 5, paths: ['/a/0/1/6'] },
]
const ALL_PATHS = [...new Set(GAMES.flatMap((g) => g.paths))]

// Same byte offsets as Gen 3 for the first 28 bytes — verified against
// pret/pokeplatinum include/struct_defs/species.h.
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


/* --------------------------------------------------- trainers (Gen 4) */

// TrainerHeader (trdata.narc, one subfile per trainer), verified against
// pret/pokeplatinum struct_defs/trainer_data.h:
//   monDataType u8, class u8, sprite u8, partySize u8,
//   items u16[4], aiMask u32, battleType u32   (20 bytes)
// Party entries (trpoke.narc): ivScale u16, level u16, species u16
// [, item u16][, moves u16[4]], cbSeal u16 — 8/10/16/18 bytes by type.
const TR_ENTRY_SIZES = [8, 16, 10, 18]

export function buildGen4Trainers(
  rom: Rom,
  trdata: NarcSubfile[],
  trpoke: NarcSubfile[],
): TrainerModule {
  const bytes = rom.bytes
  const count = Math.min(trdata.length, trpoke.length)
  const entries: EntryHandle[] = []
  for (let i = 0; i < count; i++) {
    const name = `Trainer #${i}`
    entries.push({ id: i, label: `#${String(i).padStart(3, '0')} ${name} · class ${bytes[trdata[i].offset + 1]}`, name })
  }

  const header = (id: number) => trdata[id].offset
  const partyInfo = (id: number) => {
    const type = bytes[header(id)] & 3
    return {
      type,
      entSize: TR_ENTRY_SIZES[type],
      size: bytes[header(id) + 3],
      off: trpoke[id].offset,
      capacity: trpoke[id].length,
    }
  }

  return {
    entries,
    nameLength: 0, // trainer names live in the encrypted text banks
    classOptions: null,
    setName: () => false,

    read(id) {
      const o = header(id)
      const { size, entSize, capacity } = partyInfo(id)
      return {
        name: entries[id].name,
        trainerClass: bytes[o + 1],
        pic: bytes[o + 2],
        music: 0,
        gender: 0,
        doubleBattle: rom.readU16LE(o + 16) !== 0 ? 1 : 0,
        aiFlags: (rom.readU16LE(o + 12) | (rom.readU16LE(o + 14) << 16)) >>> 0,
        items: [0, 1, 2, 3].map((i) => rom.readU16LE(o + 4 + i * 2)),
        partySize: size,
        maxPartySize: Math.min(6, Math.floor(capacity / entSize)),
      }
    },

    write(id, field, value) {
      const o = header(id)
      if (field === 'trainerClass') rom.writeU8(o + 1, value)
      else if (field === 'pic') rom.writeU8(o + 2, value)
      else if (field === 'doubleBattle') {
        rom.writeU16LE(o + 16, value ? 2 : 0)
        rom.writeU16LE(o + 18, 0)
      } else if (field === 'aiFlags') {
        rom.writeU16LE(o + 12, value & 0xffff)
        rom.writeU16LE(o + 14, (value >>> 16) & 0xffff)
      } else if (field === 'partySize') {
        const max = Math.min(6, Math.floor(partyInfo(id).capacity / partyInfo(id).entSize))
        rom.writeU8(o + 3, Math.max(1, Math.min(max, value)))
      }
    },

    setItem(id, slot, item) {
      if (slot >= 0 && slot < 4) rom.writeU16LE(header(id) + 4 + slot * 2, item)
    },

    party(id) {
      const { type, entSize, size, off } = partyInfo(id)
      const out = []
      for (let i = 0; i < size; i++) {
        const o = off + i * entSize
        const hasItem = (type & 2) === 2
        const hasMoves = (type & 1) === 1
        out.push({
          iv: rom.readU16LE(o),
          level: rom.readU16LE(o + 2),
          species: rom.readU16LE(o + 4) & 0x3ff, // upper bits = form
          item: hasItem ? rom.readU16LE(o + 6) : null,
          moves: hasMoves ? [0, 1, 2, 3].map((m) => rom.readU16LE(o + (hasItem ? 8 : 6) + m * 2)) : null,
        })
      }
      return out
    },

    writePartyField(id, slot, field, value) {
      const { type, entSize, size, off } = partyInfo(id)
      if (slot < 0 || slot >= size) return
      const o = off + slot * entSize
      if (field === 'iv') rom.writeU16LE(o, Math.min(255, value))
      else if (field === 'level') rom.writeU16LE(o + 2, value)
      else if (field === 'species') {
        const form = rom.readU16LE(o + 4) & 0xfc00
        rom.writeU16LE(o + 4, form | (value & 0x3ff))
      } else if (field === 'item' && (type & 2) === 2) rom.writeU16LE(o + 6, value)
      else if (field.startsWith('move') && (type & 1) === 1) {
        const m = Number(field.slice(4))
        if (m >= 0 && m < 4) rom.writeU16LE(o + ((type & 2) === 2 ? 8 : 6) + m * 2, value)
      }
    },

    revert(id) {
      rom.revertRange(header(id), trdata[id].length)
      rom.revertRange(trpoke[id].offset, trpoke[id].length)
    },
  }
}

/* ---------------------------------------------- wild encounters (Gen 4) */

// WildEncounters (d/p/pl_enc_data.narc, 424 bytes per area), verified
// against pret/pokeplatinum overlay006/wild_encounters.h. All ints LE.
const ENC_FILE_SIZE = 424
const ENC_GROUPS = [
  { name: 'Grass', rateOff: 0, slotsOff: 4, slots: 12, grass: true },
  { name: 'Surfing', rateOff: 204, slotsOff: 208, slots: 5, grass: false },
  { name: 'Old Rod', rateOff: 292, slotsOff: 296, slots: 5, grass: false },
  { name: 'Good Rod', rateOff: 336, slotsOff: 340, slots: 5, grass: false },
  { name: 'Super Rod', rateOff: 380, slotsOff: 384, slots: 5, grass: false },
]

export function buildGen4Wild(rom: Rom, subs: NarcSubfile[]): WildModule | null {
  const bytes = rom.bytes
  const areas = subs.filter((s) => s.length === ENC_FILE_SIZE)
  if (areas.length < 10) return null

  const entries = areas.map((a) => ({ key: String(a.index), label: `Area #${a.index}` }))
  const byKey = new Map(areas.map((a) => [String(a.index), a]))

  const readI32 = (o: number) => (rom.readU16LE(o) | (rom.readU16LE(o + 2) << 16)) >>> 0
  const groupList = (key: string) => {
    const a = byKey.get(key)
    if (!a) return []
    return ENC_GROUPS.map((g) => ({ ...g, base: a.offset }))
  }

  return {
    entries,
    groups(key) {
      return groupList(key).map((g) => ({
        name: g.name,
        rate: readI32(g.base + g.rateOff),
        slots: Array.from({ length: g.slots }, (_, i) => {
          const o = g.base + g.slotsOff + i * 8
          return g.grass
            ? { minLevel: bytes[o], maxLevel: bytes[o], species: readI32(o + 4) & 0xffff }
            : { minLevel: bytes[o + 1], maxLevel: bytes[o], species: readI32(o + 4) & 0xffff }
        }),
      }))
    },
    setRate(key, group, rate) {
      const g = groupList(key)[group]
      if (!g) return
      rom.writeU16LE(g.base + g.rateOff, rate & 0xffff)
      rom.writeU16LE(g.base + g.rateOff + 2, 0)
    },
    setSlot(key, group, slot, field, value) {
      const g = groupList(key)[group]
      if (!g || slot < 0 || slot >= g.slots) return
      const o = g.base + g.slotsOff + slot * 8
      if (field === 'species') {
        rom.writeU16LE(o + 4, value & 0xffff)
        rom.writeU16LE(o + 6, 0)
      } else if (g.grass) {
        rom.writeU8(o, value) // single level
      } else if (field === 'minLevel') rom.writeU8(o + 1, value)
      else if (field === 'maxLevel') rom.writeU8(o, value)
    },
    revert(key) {
      const a = byKey.get(key)
      if (a) rom.revertRange(a.offset, a.length)
    },
  }
}

export function tryBuildGen45(rom: Rom): GameAdapter | null {
  const bytes = rom.bytes
  if (!isNdsRom(bytes)) return null
  const header = parseNdsHeader(bytes)!
  const game = GAMES.find((g) => header.gameCode.startsWith(g.prefix))

  const files = listNdsFiles(bytes, header)
  let personal: { offset: number; length: number }[] | null = null
  let personalPath = ''
  for (const path of game?.paths ?? ALL_PATHS) {
    const file = findNdsFile(files, path)
    if (!file) continue
    const subs = parseNarc(bytes, file.start)
    if (subs && subs.length > 100) {
      personal = subs
      personalPath = path
      break
    }
  }
  if (!personal) return null

  const entrySize = personal[1]?.length ?? 0
  const fullLayout = entrySize === GEN4_ENTRY
  const generation = game?.gen ?? (fullLayout ? 4 : 5)
  const gameName = `${game?.name ?? 'Pokémon (DS)'} (${header.gameCode})`
  const warnings: string[] = []
  if (!fullLayout) {
    warnings.push(
      `Gen 5 personal entries (${entrySize} bytes) are partially supported: stats, types and catch rate only until the full layout is verified.`,
    )
  }
  warnings.push('DS support is new — save a copy of your ROM before editing, and report anything odd.')

  const speciesCount = personal.length - 1
  const speciesName = (id: number) => NATDEX_NAMES[id - 1] ?? `Extra entry #${id}`
  const species: EntryHandle[] = []
  for (let id = 1; id <= speciesCount; id++) {
    species.push({
      id,
      label: `#${String(id).padStart(3, '0')} ${speciesName(id)}`,
      name: speciesName(id),
    })
  }

  const abilityOptions: SelectOption[] = [
    { value: 0, label: '— none —' },
    ...NATDEX_ABILITIES.map((label, i) => ({ value: i + 1, label })),
  ]
  const evOptions = [0, 1, 2, 3].map((v) => ({ value: v, label: String(v) }))
  const tmLabels: string[] = []
  for (let i = 0; i < 128; i++) {
    tmLabels.push(i < 92 ? `TM${String(i + 1).padStart(2, '0')}` : i < 100 ? `HM${String(i - 91).padStart(2, '0')}` : '(unused)')
  }

  const minimalFields: FieldSpec[] = [
    { key: 'hp', label: 'HP', kind: 'number', min: 1, max: 255, group: 'stats' },
    { key: 'atk', label: 'Attack', kind: 'number', min: 1, max: 255, group: 'stats' },
    { key: 'def', label: 'Defense', kind: 'number', min: 1, max: 255, group: 'stats' },
    { key: 'spd', label: 'Speed', kind: 'number', min: 1, max: 255, group: 'stats' },
    { key: 'sat', label: 'Sp. Attack', kind: 'number', min: 1, max: 255, group: 'stats' },
    { key: 'sdf', label: 'Sp. Defense', kind: 'number', min: 1, max: 255, group: 'stats' },
    { key: 'type1', label: 'Type 1', kind: 'type', group: 'typing' },
    { key: 'type2', label: 'Type 2', kind: 'type', group: 'typing' },
    { key: 'catchRate', label: 'Catch rate', kind: 'number', min: 1, max: 255, group: 'battle' },
  ]
  const speciesFields: FieldSpec[] = fullLayout
    ? [
        ...minimalFields,
        { key: 'baseExp', label: 'Base EXP yield', kind: 'number', min: 0, max: 255, group: 'battle' },
        { key: 'growthRate', label: 'Level curve', kind: 'select', options: GEN3_GROWTH, group: 'battle' },
        { key: 'item1', label: 'Wild held item (common)', kind: 'number', min: 0, max: 65535, group: 'battle', help: 'Item ID (0 = none).' },
        { key: 'item2', label: 'Wild held item (rare)', kind: 'number', min: 0, max: 65535, group: 'battle', help: 'Item ID (0 = none).' },
        { key: 'ability1', label: 'Ability 1', kind: 'select', options: abilityOptions, group: 'typing' },
        { key: 'ability2', label: 'Ability 2', kind: 'select', options: abilityOptions, group: 'typing' },
        { key: 'evHp', label: 'EV yield: HP', kind: 'select', options: evOptions, group: 'evs' },
        { key: 'evAtk', label: 'EV yield: Attack', kind: 'select', options: evOptions, group: 'evs' },
        { key: 'evDef', label: 'EV yield: Defense', kind: 'select', options: evOptions, group: 'evs' },
        { key: 'evSpd', label: 'EV yield: Speed', kind: 'select', options: evOptions, group: 'evs' },
        { key: 'evSat', label: 'EV yield: Sp. Atk', kind: 'select', options: evOptions, group: 'evs' },
        { key: 'evSdf', label: 'EV yield: Sp. Def', kind: 'select', options: evOptions, group: 'evs' },
        { key: 'gender', label: 'Gender ratio', kind: 'select', options: GENDER_RATIOS, group: 'breeding' },
        { key: 'eggCycles', label: 'Egg cycles', kind: 'number', min: 1, max: 255, group: 'breeding' },
        { key: 'friendship', label: 'Base friendship', kind: 'number', min: 0, max: 255, group: 'breeding' },
        { key: 'eggGroup1', label: 'Egg group 1', kind: 'select', options: EGG_GROUPS, group: 'breeding' },
        { key: 'eggGroup2', label: 'Egg group 2', kind: 'select', options: EGG_GROUPS, group: 'breeding' },
        { key: 'tmhm', label: 'TM / HM compatibility', kind: 'flags', flagLabels: tmLabels, group: 'tmhm' },
      ]
    : minimalFields
  const editableStatKeys = new Set(speciesFields.filter((f) => f.key in STAT_BYTES).map((f) => f.key))

  const base = (id: number) => personal![id].offset

  // Trainers and encounters (Gen 4 only; HGSS encounters differ).
  let trainerModule: TrainerModule | null = null
  let wildModule: WildModule | null = null
  const regions = [
    {
      name: `Personal data (${personalPath}, ${speciesCount} species)`,
      offset: personal[0].offset,
      length: personal.length * entrySize,
    },
  ]
  if (fullLayout) {
    const trd = findNdsFile(files, '/poketool/trainer/trdata.narc')
    const trp = findNdsFile(files, '/poketool/trainer/trpoke.narc')
    if (trd && trp) {
      const dSubs = parseNarc(bytes, trd.start)
      const pSubs = parseNarc(bytes, trp.start)
      if (dSubs && pSubs && dSubs.length > 50) {
        trainerModule = buildGen4Trainers(rom, dSubs, pSubs)
        regions.push({ name: `Trainers (${trainerModule.entries.length})`, offset: trd.start, length: trd.end - trd.start })
      }
    }
    const encPath = { CPU: '/fielddata/encountdata/pl_enc_data.narc', ADA: '/fielddata/encountdata/d_enc_data.narc', APA: '/fielddata/encountdata/p_enc_data.narc' }[header.gameCode.slice(0, 3)]
    if (encPath) {
      const enc = findNdsFile(files, encPath)
      const encSubs = enc ? parseNarc(bytes, enc.start) : null
      if (encSubs) {
        wildModule = buildGen4Wild(rom, encSubs)
        if (wildModule) {
          regions.push({ name: `Wild encounters (${wildModule.entries.length} areas)`, offset: enc!.start, length: enc!.end - enc!.start })
        }
      }
    }
  }
  if (!trainerModule) warnings.push('Trainer editing not available for this DS game yet.')
  if (!wildModule) warnings.push('Wild encounter editing not available for this DS game yet (D/P/Platinum only so far).')

  return {
    gameName,
    platform: 'NDS',
    generation,
    rom,
    regions,
    warnings,
    species,
    speciesFields,
    typeOptions: generation === 5 ? GEN5_TYPES : GEN3_TYPES,
    mapModule: null,
    trainerModule,
    wildModule,
    itemOptions: null,
    speciesSprite: null,
    evolutions: null,
    learnsets: null,
    typeChart: null,
    speciesNameLength: null,
    setSpeciesName: () => false,

    readSpecies(id) {
      const o = base(id)
      const out: Record<string, FieldValue> = {}
      for (const key of editableStatKeys) out[key] = bytes[o + STAT_BYTES[key]]
      if (fullLayout) {
        out.item1 = rom.readU16LE(o + 12)
        out.item2 = rom.readU16LE(o + 14)
        const ev = rom.readU16LE(o + 10)
        for (const [key, idx] of EV_STATS) out[key] = (ev >> (idx * 2)) & 3
        const flags: boolean[] = []
        for (let i = 0; i < 128; i++) {
          flags.push(((bytes[o + 28 + (i >> 3)] >> (i & 7)) & 1) === 1)
        }
        out.tmhm = flags
      }
      return out
    },

    writeSpeciesField(id, key, value) {
      const o = base(id)
      if (key === 'tmhm' && Array.isArray(value) && fullLayout) {
        const flags = value as boolean[]
        for (let b = 0; b < 16; b++) {
          let v = 0
          for (let bit = 0; bit < 8; bit++) if (flags[b * 8 + bit]) v |= 1 << bit
          rom.writeU8(o + 28 + b, v)
        }
        return
      }
      if (typeof value !== 'number') return
      if (fullLayout && key === 'item1') return rom.writeU16LE(o + 12, value)
      if (fullLayout && key === 'item2') return rom.writeU16LE(o + 14, value)
      const ev = EV_STATS.find(([k]) => k === key)
      if (ev && fullLayout) {
        const cur = rom.readU16LE(o + 10)
        rom.writeU16LE(o + 10, (cur & ~(3 << (ev[1] * 2))) | ((value & 3) << (ev[1] * 2)))
        return
      }
      if (editableStatKeys.has(key)) rom.writeU8(o + STAT_BYTES[key], value)
    },

    revertSpecies(id) {
      rom.revertRange(base(id), entrySize)
    },

    moves: [],
    moveFields: [],
    moveNameLength: null,
    setMoveName: () => false,
    readMove: () => ({}),
    writeMoveField: () => {},
    revertMove: () => {},
  }
}
