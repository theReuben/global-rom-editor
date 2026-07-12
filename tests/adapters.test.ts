import { describe, expect, it } from 'vitest'
import { Rom } from '../src/core/rom'
import { buildAdapter } from '../src/core/games'
import { makeGen1Rom, makeGen2Rom, makeGen3Rom } from './fixtures'

describe('Gen 1 adapter', () => {
  const load = () => buildAdapter(new Rom('red.gb', makeGen1Rom())).adapter!

  it('detects the game and finds all tables', () => {
    const a = load()
    expect(a.generation).toBe(1)
    expect(a.gameName).toContain('Red')
    expect(a.species).toHaveLength(151)
    expect(a.species[0].name).toBe('BULBASAUR')
    expect(a.species[150].name).toBe('MEW')
    expect(a.moves[0].name).toBe('POUND')
    expect(a.moves[1].name).toBe('KARATE CHOP')
    expect(a.warnings).toHaveLength(0)
  })

  it('reads Bulbasaur correctly', () => {
    const a = load()
    const b = a.readSpecies(1)
    expect(b.hp).toBe(45)
    expect(b.spc).toBe(65)
    expect(b.type1).toBe(0x16)
    expect(b.catchRate).toBe(45)
    expect(b.growthRate).toBe(3)
    expect(b.startMove1).toBe(33)
    expect((b.tmhm as boolean[])[2]).toBe(true) // bit 2 of 0b10100100
    expect((b.tmhm as boolean[])[0]).toBe(false)
    expect((b.tmhm as boolean[])[54]).toBe(true) // HM05 ← 0x40 in byte 7
  })

  it('reads Mew from its out-of-table location', () => {
    const a = load()
    expect(a.readSpecies(151).hp).toBe(100)
    a.writeSpeciesField(151, 'hp', 111)
    expect(a.readSpecies(151).hp).toBe(111)
  })

  it('writes stats, flags and names', () => {
    const a = load()
    a.writeSpeciesField(1, 'hp', 200)
    expect(a.readSpecies(1).hp).toBe(200)

    const flags = (a.readSpecies(1).tmhm as boolean[]).slice()
    flags[0] = true
    a.writeSpeciesField(1, 'tmhm', flags)
    expect((a.readSpecies(1).tmhm as boolean[])[0]).toBe(true)

    expect(a.setSpeciesName(1, 'GRASSBOI')).toBe(true)
    expect(a.species[0].name).toBe('GRASSBOI')
    expect(a.setSpeciesName(1, '')).toBe(false)

    a.revertSpecies(1)
    expect(a.readSpecies(1).hp).toBe(45)
    expect(a.species[0].name).toBe('BULBASAUR')
  })

  it('edits moves', () => {
    const a = load()
    expect(a.readMove(1).power).toBe(40)
    a.writeMoveField(1, 'power', 90)
    expect(a.readMove(1).power).toBe(90)
    a.revertMove(1)
    expect(a.readMove(1).power).toBe(40)
  })

  it('renames moves within the original footprint', () => {
    const a = load()
    expect(a.moveNameLength).toBe(12)
    expect(a.setMoveName(1, 'BONK')).toBe(true) // "POUND" -> shorter
    expect(a.moves[0].name).toBe('BONK')
    expect(a.setMoveName(1, 'SUPERLONGNAME')).toBe(false) // > 5 chars
    expect(a.moves[0].name).toBe('BONK')
    // The next name is untouched and a fresh scan still parses the list.
    expect(a.moves[1].name).toBe('KARATE CHOP')
    const re = buildAdapter(new Rom('red.gb', a.rom.bytes)).adapter!
    expect(re.moves[0].name).toBe('BONK')
    expect(re.moves[1].name).toBe('KARATE CHOP')
  })

  it('labels TM flags with move names', () => {
    const a = load()
    const tmhm = a.speciesFields.find((f) => f.key === 'tmhm')!
    expect(tmhm.flagLabels![0]).toContain('TM01')
  })
})

describe('Gen 2 adapter', () => {
  const load = () => buildAdapter(new Rom('crystal.gbc', makeGen2Rom())).adapter!

  it('detects the game and reads Bulbasaur', () => {
    const a = load()
    expect(a.generation).toBe(2)
    expect(a.gameName).toContain('Crystal')
    expect(a.species[0].name).toBe('BULBASAUR')
    const b = a.readSpecies(1)
    expect(b.sat).toBe(65)
    expect(b.gender).toBe(31)
    expect(b.eggCycles).toBe(20)
    expect(b.growthRate).toBe(3)
    expect(b.eggGroup1).toBe(1)
    expect(b.eggGroup2).toBe(7)
    expect((b.tmhm as boolean[])[0]).toBe(true)
    expect((b.tmhm as boolean[])[48]).toBe(true)
    expect((b.tmhm as boolean[])[49]).toBe(true)
  })

  it('writes packed egg groups without clobbering the other nibble', () => {
    const a = load()
    a.writeSpeciesField(1, 'eggGroup1', 5)
    expect(a.readSpecies(1).eggGroup1).toBe(5)
    expect(a.readSpecies(1).eggGroup2).toBe(7)
    a.writeSpeciesField(1, 'eggGroup2', 12)
    expect(a.readSpecies(1).eggGroup1).toBe(5)
    expect(a.readSpecies(1).eggGroup2).toBe(12)
  })

  it('reads item names for held-item dropdowns', () => {
    const a = load()
    expect(a.itemOptions).not.toBeNull()
    expect(a.itemOptions![1].label).toBe('MASTER BALL')
    expect(a.itemOptions![78].label).toBe('PRZCUREBERRY')
    const item1 = a.speciesFields.find((f) => f.key === 'item1')!
    expect(item1.kind).toBe('select')
  })

  it('edits Gen 2 moves (7-byte entries)', () => {
    const a = load()
    expect(a.readMove(2).type).toBe(1)
    a.writeMoveField(2, 'effectChance', 30)
    expect(a.readMove(2).effectChance).toBe(30)
  })
})

describe('Gen 3 adapter', () => {
  const load = () => buildAdapter(new Rom('firered.gba', makeGen3Rom())).adapter!

  it('re-discovers the stats table after every primary anchor is edited', () => {
    const a = load()
    // Clobber Bulbasaur AND Ivysaur — the old single-anchor discovery
    // would fail on reload; Pikachu + Chansey votes must still agree.
    for (const dex of [1, 2]) {
      a.writeSpeciesField(dex, 'hp', 200)
      a.writeSpeciesField(dex, 'atk', 201)
      a.writeSpeciesField(dex, 'def', 202)
      a.writeSpeciesField(dex, 'spd', 203)
    }
    const re = buildAdapter(new Rom('firered.gba', a.rom.bytes)).adapter!
    expect(re).not.toBeNull()
    expect(re.readSpecies(1).hp).toBe(200)
    expect(re.readSpecies(25).hp).toBe(35) // Pikachu anchor intact
  })

  it('detects the game and reads Bulbasaur', () => {
    const a = load()
    expect(a.generation).toBe(3)
    expect(a.gameName).toContain('FireRed')
    expect(a.species[0].name).toBe('BULBASAUR')
    const b = a.readSpecies(1)
    expect(b.hp).toBe(45)
    expect(b.sat).toBe(65)
    expect(b.type1).toBe(12)
    expect(b.gender).toBe(31)
    expect(b.friendship).toBe(70)
    expect(b.ability1).toBe(65)
    expect(b.evSat).toBe(1)
    expect(b.evHp).toBe(0)
  })

  it('writes EV yields without disturbing neighbours', () => {
    const a = load()
    a.writeSpeciesField(1, 'evHp', 2)
    expect(a.readSpecies(1).evHp).toBe(2)
    expect(a.readSpecies(1).evSat).toBe(1)
  })

  it('writes 16-bit held items', () => {
    const a = load()
    a.writeSpeciesField(1, 'item1', 300)
    expect(a.readSpecies(1).item1).toBe(300)
  })

  it('edits move data, priority and flags', () => {
    const a = load()
    const pound = a.readMove(1)
    expect(pound.power).toBe(40)
    expect(pound.accuracy).toBe(100)
    expect((pound.flags as boolean[])[0]).toBe(true) // makes contact (0x33)
    expect((pound.flags as boolean[])[2]).toBe(false)

    a.writeMoveField(1, 'priority', -1)
    expect(a.readMove(1).priority).toBe(-1)

    const flags = (a.readMove(1).flags as boolean[]).slice()
    flags[2] = true
    a.writeMoveField(1, 'flags', flags)
    expect((a.readMove(1).flags as boolean[])[2]).toBe(true)
  })

  it('renames moves (fixed-width Gen 3 names)', () => {
    const a = load()
    expect(a.moveNameLength).toBe(12)
    expect(a.setMoveName(1, 'MEGA POUND')).toBe(true)
    expect(a.moves[0].name).toBe('MEGA POUND')
    a.revertMove(1)
    expect(a.moves[0].name).toBe('POUND')
  })

  it('labels abilities read from the ROM', () => {
    const a = load()
    const ability = a.speciesFields.find((f) => f.key === 'ability1')!
    expect(ability.options![1].label).toBe('STENCH')
  })
})

describe('unsupported input', () => {
  it('explains when the file is not a ROM', () => {
    const result = buildAdapter(new Rom('cat.png', new Uint8Array(4096)))
    expect(result.adapter).toBeNull()
    expect(result.reason).toContain('does not look like')
  })

  it('explains when the ROM has no Pokémon tables', () => {
    const bytes = new Uint8Array(1024 * 1024)
    bytes[0xb2] = 0x96 // valid GBA header byte, but empty otherwise
    const result = buildAdapter(new Rom('other.gba', bytes))
    expect(result.adapter).toBeNull()
    expect(result.reason).toContain('no Pokémon data tables')
  })
})
