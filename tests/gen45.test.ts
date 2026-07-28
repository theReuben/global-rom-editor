import { describe, expect, it } from 'vitest'
import { Rom } from '../src/core/rom'
import { buildAdapter } from '../src/core/games'
import { makeGen4Rom, makeGen5Rom } from './fixtures'

describe('Gen 4 adapter (Platinum-style)', () => {
  const load = () => buildAdapter(new Rom('platinum.nds', makeGen4Rom())).adapter!

  it('detects the game and lists species with national dex names', () => {
    const a = load()
    expect(a.gameName).toContain('Platinum')
    expect(a.platform).toBe('NDS')
    expect(a.generation).toBe(4)
    expect(a.species).toHaveLength(149)
    expect(a.species[0].label).toBe('#001 Bulbasaur')
    expect(a.species[24].name).toBe('Pikachu')
  })

  it('reads the full 44-byte personal entry', () => {
    const a = load()
    const b = a.readSpecies(1)
    expect(b.hp).toBe(45)
    expect(b.sat).toBe(65)
    expect(b.type1).toBe(12)
    expect(b.catchRate).toBe(45)
    expect(b.gender).toBe(31)
    expect(b.friendship).toBe(70)
    expect(b.growthRate).toBe(3)
    expect(b.ability1).toBe(65)
    expect(b.evSat).toBe(1)
    const flags = b.tmhm as boolean[]
    expect(flags[0]).toBe(true) // TM01
    expect(flags[1]).toBe(false)
    expect(flags[2]).toBe(true) // TM03
  })

  it('renames species in place and grows past the slot via NARC relocation', () => {
    const a = load()
    expect(a.species[0].name).toBe('Bulbasaur') // from the msg bank
    // Same-or-shorter goes in place.
    expect(a.setSpeciesName(1, 'Bulba')).toBe(true)
    // Longer than the slot triggers the growth path: rebuild the bank,
    // repack the msg NARC into end-of-ROM padding, retarget the FAT.
    expect(a.setSpeciesName(1, 'BulbasaurusMaximus')).toBe(true)
    expect(a.species[0].name).toBe('BulbasaurusMaximus')

    const re = buildAdapter(new Rom('platinum.nds', a.rom.bytes)).adapter!
    expect(re.species[0].name).toBe('BulbasaurusMaximus')
    expect(re.species[1].name).toBe('Ivysaur') // neighbours intact
    // The relocated bank still accepts follow-up renames.
    expect(re.setSpeciesName(2, 'Ivy')).toBe(true)
    expect(re.species[1].name).toBe('Ivy')
  })

  it('renames moves through the msg bank, including growth', () => {
    const a = load()
    expect(a.moves.find((m) => m.id === 1)!.name).toBe('Pound')
    expect(a.moveNameLength).toBe(16)
    expect(a.setMoveName(1, 'Bonk')).toBe(true) // shorter → in place
    expect(a.moves.find((m) => m.id === 1)!.name).toBe('Bonk')
    expect(a.setMoveName(2, 'KarateChopSupreme')).toBe(true) // growth
    const re = buildAdapter(new Rom('platinum.nds', a.rom.bytes)).adapter!
    expect(re.moves.find((m) => m.id === 1)!.name).toBe('Bonk')
    expect(re.moves.find((m) => m.id === 2)!.name).toBe('KarateChopSupreme')
    expect(re.species[0].name).toBe('Bulbasaur') // species bank untouched
  })

  it('edits evolutions and learnsets, growing via NARC relocation', () => {
    const a = load()
    const evo = a.evolutions!
    const ls = a.learnsets!
    expect(evo.read(1)[0]).toEqual({ method: 4, param: 16, target: 2 })
    expect(evo.read(1)).toHaveLength(7)
    expect(ls.read(1)).toEqual([
      { level: 1, move: 33 },
      { level: 4, move: 45 },
    ])
    evo.write(1, 0, 'param', 36)
    evo.write(1, 1, 'method', 7) // add a stone evolution in slot 1
    evo.write(1, 1, 'param', 95)
    evo.write(1, 1, 'target', 3)
    // Learnset grows past its 6-byte subfile → wotbl NARC relocates.
    expect(
      ls.write(1, [...ls.read(1), { level: 20, move: 75 }, { level: 32, move: 80 }]),
    ).toBe(true)
    const re = buildAdapter(new Rom('platinum.nds', a.rom.bytes)).adapter!
    expect(re.evolutions!.read(1)[0].param).toBe(36)
    expect(re.evolutions!.read(1)[1]).toEqual({ method: 7, param: 95, target: 3 })
    expect(re.learnsets!.read(1)).toHaveLength(4)
    expect(re.learnsets!.read(1)[3]).toEqual({ level: 32, move: 80 })
    expect(re.learnsets!.read(2)).toEqual([]) // neighbours untouched
    evo.revert(1)
    expect(evo.read(1)[0].param).toBe(16)
  })

  it('renders descrambled sprites with shiny palettes', () => {
    const a = load()
    expect(a.speciesSprite).not.toBeNull()
    expect(a.hasShinySprites).toBe(true)
    const front = a.speciesSprite!(1, false)!
    expect(front.width).toBe(80)
    expect(front.height).toBe(80)
    expect(front.pixels[0]).toBe(255) // color 1 = BGR555 0x001F = red
    expect(front.pixels[1]).toBe(0)
    const shiny = a.speciesSprite!(1, true)!
    expect(shiny.pixels[1]).toBe(255) // shiny color 1 = green
    expect(a.speciesSpriteBack!(1, false)).not.toBeNull()
    expect(a.speciesSprite!(2, false)).toBeNull() // empty slots
  })

  /**
   * 80×80 RGBA test art. Top-left is the background (palette slot 0, so
   * it renders as the viewer's transparent white), with a red and a
   * green block and one fully transparent pixel.
   */
  const makeArt = () => {
    const pixels = new Uint8ClampedArray(80 * 80 * 4)
    const set = (x: number, y: number, r: number, g: number, b: number, a = 255) => {
      const o = (y * 80 + x) * 4
      pixels[o] = r
      pixels[o + 1] = g
      pixels[o + 2] = b
      pixels[o + 3] = a
    }
    for (let y = 0; y < 80; y++) for (let x = 0; x < 80; x++) set(x, y, 0, 0, 255)
    for (let y = 30; y < 50; y++) for (let x = 30; x < 50; x++) set(x, y, 255, 0, 0)
    set(10, 70, 0, 255, 0)
    set(60, 20, 0, 0, 0, 0) // transparent → slot 0
    return { pixels, width: 80, height: 80 }
  }

  const pixelAt = (img: { pixels: Uint8ClampedArray; width: number }, x: number, y: number) => {
    const o = (y * img.width + x) * 4
    return [img.pixels[o], img.pixels[o + 1], img.pixels[o + 2]]
  }

  it('imports a front sprite and re-reads it from the edited ROM', () => {
    const a = load()
    expect(a.importSpeciesSprite).not.toBeNull()
    expect(a.importSpeciesSprite!(1, makeArt())).toBeNull()
    expect(a.rom.changedByteCount).toBeGreaterThan(0)

    // Reload the edited bytes — the acid test that the re-scramble is
    // shaped the way the loader expects.
    const re = buildAdapter(new Rom('platinum.nds', a.rom.bytes)).adapter!
    const front = re.speciesSprite!(1, false)!
    expect(front.width).toBe(80)
    expect(front.height).toBe(80)
    expect(pixelAt(front, 0, 0)).toEqual([255, 255, 255]) // slot 0
    expect(pixelAt(front, 60, 20)).toEqual([255, 255, 255]) // transparent → slot 0
    expect(pixelAt(front, 40, 40)).toEqual([255, 0, 0])
    expect(pixelAt(front, 10, 70)).toEqual([0, 255, 0])
    // Neighbouring species keep their own art.
    expect(pixelAt(re.speciesSprite!(4, false)!, 0, 0)).toEqual([255, 0, 0])
  })

  it('imports a back sprite without disturbing the front slot', () => {
    const a = load()
    expect(a.importSpeciesSpriteBack!(1, makeArt())).toBeNull()
    const re = buildAdapter(new Rom('platinum.nds', a.rom.bytes)).adapter!
    expect(pixelAt(re.speciesSpriteBack!(1, false)!, 40, 40)).toEqual([255, 0, 0])
    // The front NCGR is a different subfile — its pixels are still the
    // fixture's solid color-1 fill (the palette is shared, so color 1 is
    // now the imported red).
    expect(pixelAt(re.speciesSprite!(1, false)!, 40, 40)).toEqual([255, 0, 0])
  })

  it('reverts an imported sprite byte for byte', () => {
    const a = load()
    const before = a.speciesSprite!(1, false)!
    expect(a.importSpeciesSprite!(1, makeArt())).toBeNull()
    a.rom.revertAll()
    expect(a.rom.changedByteCount).toBe(0)
    const re = buildAdapter(new Rom('platinum.nds', a.rom.bytes)).adapter!
    expect([...re.speciesSprite!(1, false)!.pixels]).toEqual([...before.pixels])
  })

  it('rejects sprites of the wrong size, over-rich palettes and empty slots', () => {
    const a = load()
    const small = { pixels: new Uint8ClampedArray(64 * 64 * 4), width: 64, height: 64 }
    expect(a.importSpeciesSprite!(1, small)).toContain('80×80')

    const rich = makeArt()
    for (let i = 0; i < 20; i++) {
      const o = i * 4
      rich.pixels[o] = i * 8
      rich.pixels[o + 1] = 255 - i * 8
      rich.pixels[o + 2] = 128
      rich.pixels[o + 3] = 255
    }
    expect(a.importSpeciesSprite!(1, rich)).toContain('Too many colors')

    // Species 2 has no NCGR in the fixture.
    expect(a.importSpeciesSprite!(2, makeArt())).toContain('no sprite slot')
    expect(a.importSpeciesSprite!(999, makeArt())).toContain('Unknown species')
    expect(a.rom.changedByteCount).toBe(0) // nothing written on any failure
  })

  it('shows ability names from the generated constants', () => {
    const a = load()
    const field = a.speciesFields.find((f) => f.key === 'ability1')!
    expect(field.options!.find((o) => o.value === 65)!.label).toBe('Overgrow')
  })

  it('writes stats, EVs, items and TM flags', () => {
    const a = load()
    a.writeSpeciesField(1, 'hp', 200)
    a.writeSpeciesField(1, 'item1', 300)
    a.writeSpeciesField(1, 'evHp', 2)
    const flags = (a.readSpecies(1).tmhm as boolean[]).slice()
    flags[91] = true // TM92
    flags[92] = true // HM01
    a.writeSpeciesField(1, 'tmhm', flags)

    const b = a.readSpecies(1)
    expect(b.hp).toBe(200)
    expect(b.item1).toBe(300)
    expect(b.evHp).toBe(2)
    expect(b.evSat).toBe(1) // untouched
    expect((b.tmhm as boolean[])[91]).toBe(true)
    expect((b.tmhm as boolean[])[92]).toBe(true)

    a.revertSpecies(1)
    expect(a.readSpecies(1).hp).toBe(45)
  })
})

describe('Gen 4 move data (waza_tbl)', () => {
  const load = () => buildAdapter(new Rom('platinum.nds', makeGen4Rom())).adapter!

  it('reads and edits 16-byte move entries', () => {
    const a = load()
    expect(a.moveFields.length).toBeGreaterThan(0)
    const pound = a.readMove(1)
    expect(pound.power).toBe(40)
    expect(pound.accuracy).toBe(100)
    expect(pound.pp).toBe(35)
    expect(pound.category).toBe(0)
    expect(a.readMove(98).priority).toBe(1)

    a.writeMoveField(1, 'power', 90)
    a.writeMoveField(1, 'category', 1)
    a.writeMoveField(1, 'priority', -3)
    expect(a.readMove(1)).toMatchObject({ power: 90, category: 1, priority: -3 })
    a.revertMove(1)
    expect(a.readMove(1)).toMatchObject({ power: 40, category: 0, priority: 0 })
  })
})

describe('Gen 5 adapter (full 0x3C layout per PKHeX)', () => {
  const load = () => buildAdapter(new Rom('black.nds', makeGen5Rom())).adapter!

  it('reads the full personal entry', () => {
    const a = load()
    expect(a.gameName).toContain('Black')
    expect(a.generation).toBe(5)
    expect(a.warnings.some((w) => w.includes('partially') || w.includes('Unrecognised'))).toBe(false)
    const b = a.readSpecies(1)
    expect(b.hp).toBe(45)
    expect(b.type1).toBe(11) // Grass in Gen 5 numbering
    expect(a.typeOptions.find((t) => t.value === 11)!.label).toBe('Grass')
    expect(b.evSat).toBe(1)
    expect(b.item1).toBe(17)
    expect(b.item3).toBe(44)
    expect(b.gender).toBe(31)
    expect(b.friendship).toBe(70)
    expect(b.growthRate).toBe(3)
    expect(b.ability1).toBe(65)
    expect(b.abilityH).toBe(34) // hidden abilities are new in Gen 5
    expect(b.baseExp).toBe(300) // u16 — can exceed 255
    const flags = b.tmhm as boolean[]
    expect(flags).toHaveLength(101)
    expect(flags[0]).toBe(true) // TM01
    expect(flags[2]).toBe(true) // TM03
    expect(flags[95]).toBe(true) // HM01
  })

  it('writes items, hidden ability, u16 base EXP and TM flags', () => {
    const a = load()
    a.writeSpeciesField(1, 'item3', 999)
    a.writeSpeciesField(1, 'abilityH', 151)
    a.writeSpeciesField(1, 'baseExp', 608)
    a.writeSpeciesField(1, 'evHp', 3)
    const flags = (a.readSpecies(1).tmhm as boolean[]).slice()
    flags[94] = true // TM95
    flags[100] = true // HM06
    a.writeSpeciesField(1, 'tmhm', flags)
    const b = a.readSpecies(1)
    expect(b.item3).toBe(999)
    expect(b.abilityH).toBe(151)
    expect(b.baseExp).toBe(608)
    expect(b.evHp).toBe(3)
    expect(b.evSat).toBe(1) // untouched
    expect((b.tmhm as boolean[])[94]).toBe(true)
    expect((b.tmhm as boolean[])[100]).toBe(true)
    a.revertSpecies(1)
    expect(a.readSpecies(1).baseExp).toBe(300)
  })
})

import { buildGen4Trainers, buildGen4Wild, buildHgssWild } from '../src/core/games/gen45'
import { parseNarc } from '../src/core/nds/nds'
import { buildNarc } from './fixtures'

function u16pairs(...v: number[]): Uint8Array {
  return Uint8Array.from(v.flatMap((x) => [x & 0xff, (x >> 8) & 0xff]))
}

describe('Gen 4 trainers (trdata/trpoke)', () => {
  const make = () => {
    // Trainer 0: dummy; trainer 1: moves+item (type 3), 2 mons.
    const t1 = new Uint8Array(20)
    t1[0] = 3 // moves + item
    t1[1] = 7 // class
    t1[2] = 4 // sprite
    t1[3] = 2 // party size
    t1.set(u16pairs(17, 0, 0, 0), 4) // item 1 = 17
    t1[12] = 7 // aiMask
    t1[16] = 2 // battleType: double
    const trdata = buildNarc([new Uint8Array(20), t1])
    // Party: 2 × 18-byte entries (iv, level, species, item, moves×4, seal)
    const mon0 = u16pairs(120, 25, 25, 13, 84, 45, 0, 0, 0)
    const mon1 = u16pairs(50, 27, (1 << 10) | 26, 0, 85, 0, 0, 0, 0) // form 1 raichu
    const party = new Uint8Array(36)
    party.set(mon0, 0)
    party.set(mon1, 18)
    const trpoke = buildNarc([new Uint8Array(8), party])
    const buf = new Uint8Array(trdata.length + trpoke.length + 64)
    buf.set(trdata, 0)
    buf.set(trpoke, trdata.length + 32)
    const rom = new Rom('x.nds', buf)
    return buildGen4Trainers(rom, parseNarc(rom.bytes, 0)!, parseNarc(rom.bytes, trdata.length + 32)!)
  }

  it('reads headers and typed parties', () => {
    const t = make()
    expect(t.entries).toHaveLength(2)
    const d = t.read(1)
    expect(d.trainerClass).toBe(7)
    expect(d.pic).toBe(4)
    expect(d.doubleBattle).toBe(1)
    expect(d.aiFlags).toBe(7)
    expect(d.items[0]).toBe(17)
    expect(d.partySize).toBe(2)
    expect(d.maxPartySize).toBe(2) // 36 bytes / 18

    const party = t.party(1)
    expect(party[0]).toEqual({ iv: 120, level: 25, species: 25, item: 13, moves: [84, 45, 0, 0] })
    expect(party[1].species).toBe(26) // form bits masked for display
  })

  it('edits while preserving form bits, and reverts', () => {
    const t = make()
    t.writePartyField(1, 1, 'species', 100)
    expect(t.party(1)[1].species).toBe(100)
    t.write(1, 'trainerClass', 9)
    t.setItem(1, 1, 55)
    expect(t.read(1).trainerClass).toBe(9)
    expect(t.read(1).items[1]).toBe(55)
    t.revert(1)
    expect(t.read(1).trainerClass).toBe(7)
    expect(t.party(1)[1].species).toBe(26)
  })
})

describe('Gen 4 wild encounters (enc_data)', () => {
  const makeArea = () => {
    const a = new Uint8Array(424)
    a[0] = 30 // grass rate
    a[4] = 5 // grass slot 0: level 5
    a.set(u16pairs(396), 8) // species starly-ish
    a[204] = 10 // surf rate
    a[208] = 30 // surf slot 0: max level
    a[209] = 20 // min level
    a.set(u16pairs(54), 212) // psyduck
    return a
  }
  const make = () => {
    const subs = Array.from({ length: 12 }, () => makeArea())
    const narc = buildNarc(subs)
    const rom = new Rom('x.nds', narc)
    return buildGen4Wild(rom, parseNarc(rom.bytes, 0)!)!
  }

  it('exposes grass, surf and rod groups', () => {
    const w = make()
    expect(w).not.toBeNull()
    expect(w.entries).toHaveLength(12)
    const groups = w.groups('0')
    expect(groups.map((g) => g.name)).toEqual(['Grass', 'Surfing', 'Old Rod', 'Good Rod', 'Super Rod'])
    expect(groups[0].rate).toBe(30)
    expect(groups[0].slots[0]).toEqual({ minLevel: 5, maxLevel: 5, species: 396 })
    expect(groups[1].slots[0]).toEqual({ minLevel: 20, maxLevel: 30, species: 54 })
  })

  it('edits levels and species, and reverts', () => {
    const w = make()
    w.setSlot('0', 0, 0, 'species', 399)
    w.setSlot('0', 1, 0, 'minLevel', 25)
    w.setRate('0', 0, 40)
    expect(w.groups('0')[0].slots[0].species).toBe(399)
    expect(w.groups('0')[1].slots[0].minLevel).toBe(25)
    expect(w.groups('0')[0].rate).toBe(40)
    w.revert('0')
    expect(w.groups('0')[0].rate).toBe(30)
  })
})

describe('HGSS wild encounters (0xC4 EncounterData files)', () => {
  const makeArea = () => {
    const f = new Uint8Array(0xc4)
    f.set([20, 8, 5, 25, 35, 45], 0) // walking/surf/rocksmash/rod rates
    f[8] = 4 // land level slot 0
    f[9] = 6 // land level slot 1
    put16(f, 0x14, 179) // morning slot 0: Mareep
    put16(f, 0x2c, 19) // day slot 0: Rattata
    put16(f, 0x44, 163) // night slot 0: Hoothoot
    put16(f, 0x5c, 333) // Hoenn radio
    put16(f, 0x60, 433) // Sinnoh radio
    f.set([10, 20], 0x64) // surf slot 0: lv 10-20
    put16(f, 0x66, 129) // Magikarp
    put16(f, 0xbc, 206) // land swarm: Dunsparce
    return f
  }
  const put16 = (b: Uint8Array, o: number, v: number) => {
    b[o] = v & 0xff
    b[o + 1] = v >> 8
  }
  const make = () => {
    const narc = buildNarc(Array.from({ length: 12 }, () => makeArea()))
    const rom = new Rom('hg.nds', narc)
    return buildHgssWild(rom, parseNarc(rom.bytes, 0)!)!
  }

  it('exposes time-of-day grass, surf/rods and radio/swarm groups', () => {
    const w = make()
    expect(w).not.toBeNull()
    const groups = w.groups('0')
    expect(groups.map((g) => g.name)).toEqual([
      'Grass (morning)', 'Grass (day)', 'Grass (night)',
      'Surfing', 'Rock Smash', 'Old Rod', 'Good Rod', 'Super Rod',
      'Radio: Hoenn sound', 'Radio: Sinnoh sound', 'Swarm (land / surf / night fish / fish)',
    ])
    expect(groups[0].rate).toBe(20)
    expect(groups[0].slots[0]).toEqual({ minLevel: 4, maxLevel: 4, species: 179 })
    expect(groups[1].slots[0].species).toBe(19)
    expect(groups[2].slots[0].species).toBe(163)
    expect(groups[3].slots[0]).toEqual({ minLevel: 10, maxLevel: 20, species: 129 })
    expect(groups[8].slots[0].species).toBe(333)
    expect(groups[10].slots[0].species).toBe(206)
  })

  it('shares one level array across the three times of day', () => {
    const w = make()
    w.setSlot('0', 0, 1, 'minLevel', 9) // edit via the morning group
    expect(w.groups('0')[1].slots[1].minLevel).toBe(9) // day sees it
    expect(w.groups('0')[2].slots[1].maxLevel).toBe(9) // night too
    w.setSlot('0', 1, 0, 'species', 500) // day species stays per-time
    expect(w.groups('0')[1].slots[0].species).toBe(500)
    expect(w.groups('0')[0].slots[0].species).toBe(179)
  })

  it('edits ranged and species-only groups, and reverts', () => {
    const w = make()
    w.setSlot('0', 3, 0, 'maxLevel', 33)
    w.setSlot('0', 10, 0, 'species', 372)
    w.setSlot('0', 10, 0, 'minLevel', 50) // no level bytes → ignored
    w.setRate('0', 10, 77) // no rate byte → ignored
    expect(w.groups('0')[3].slots[0].maxLevel).toBe(33)
    expect(w.groups('0')[10].slots[0]).toEqual({ minLevel: 0, maxLevel: 0, species: 372 })
    w.revert('0')
    expect(w.groups('0')[3].slots[0].maxLevel).toBe(20)
    expect(w.groups('0')[10].slots[0].species).toBe(206)
  })
})
