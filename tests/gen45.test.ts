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

describe('Gen 5 adapter (minimal until layout verified)', () => {
  it('loads with stats/types/catch only and says so', () => {
    const a = buildAdapter(new Rom('black.nds', makeGen5Rom())).adapter!
    expect(a.gameName).toContain('Black')
    expect(a.generation).toBe(5)
    expect(a.warnings.some((w) => w.includes('partially supported'))).toBe(true)
    expect(a.speciesFields.map((f) => f.key)).toEqual([
      'hp', 'atk', 'def', 'spd', 'sat', 'sdf', 'type1', 'type2', 'catchRate',
    ])
    const b = a.readSpecies(1)
    expect(b.hp).toBe(45)
    expect(b.type1).toBe(11) // Grass in Gen 5 numbering
    expect(a.typeOptions.find((t) => t.value === 11)!.label).toBe('Grass')
    a.writeSpeciesField(1, 'catchRate', 3)
    expect(a.readSpecies(1).catchRate).toBe(3)
  })
})

import { buildGen4Trainers, buildGen4Wild } from '../src/core/games/gen45'
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
