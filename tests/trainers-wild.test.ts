import { describe, expect, it } from 'vitest'
import { Rom } from '../src/core/rom'
import { buildAdapter } from '../src/core/games'
import { makeGen1Rom, makeGen3Rom } from './fixtures'

const load = () => buildAdapter(new Rom('firered.gba', makeGen3Rom())).adapter!

describe('Gen 3 item names', () => {
  it('reads item names from the ROM', () => {
    const a = load()
    expect(a.itemOptions).not.toBeNull()
    expect(a.itemOptions![1].label).toBe('MASTER BALL')
    expect(a.itemOptions![3].label).toBe('POTION')
    const item1 = a.speciesFields.find((f) => f.key === 'item1')!
    expect(item1.kind).toBe('select')
  })
})

describe('Gen 3 trainers', () => {
  it('discovers the trainer table structurally', () => {
    const a = load()
    const t = a.trainerModule!
    expect(t).not.toBeNull()
    expect(t.entries).toHaveLength(61)
    expect(t.entries[1].name.trim()).toBe('BRENDAN')
    expect(t.entries[2].name.trim()).toBe('YOUNGSTER')
  })

  it('reads trainer class names from the ROM', () => {
    const t = load().trainerModule!
    expect(t.classOptions).not.toBeNull()
    expect(t.classOptions![0].label).toBe('PKMN TRAINER')
    expect(t.classOptions![2].label).toBe('BUG CATCHER')
    expect(t.classOptions!.length).toBe(20)
  })

  it('splits the music/gender byte', () => {
    const t = load().trainerModule!
    expect(t.read(1).music).toBe(1)
    expect(t.read(1).gender).toBe(0)
    t.write(1, 'gender', 1)
    expect(t.read(1).gender).toBe(1)
    expect(t.read(1).music).toBe(1) // untouched
    t.write(1, 'music', 42)
    expect(t.read(1).music).toBe(42)
    expect(t.read(1).gender).toBe(1) // untouched
  })

  it('reads trainer data and parties (items + custom moves)', () => {
    const t = load().trainerModule!
    const d = t.read(1)
    expect(d.trainerClass).toBe(2)
    expect(d.pic).toBe(4)
    expect(d.aiFlags).toBe(1)
    expect(d.items[0]).toBe(3)
    expect(d.partySize).toBe(2)

    const party = t.party(1)
    expect(party).toHaveLength(2)
    expect(party[0]).toEqual({ iv: 100, level: 20, species: 1, item: 3, moves: [1, 2, 0, 0] })
    expect(party[1].level).toBe(22)

    // Simple trainers: no item / move slots.
    const simple = t.party(2)
    expect(simple[0].item).toBeNull()
    expect(simple[0].moves).toBeNull()
  })

  it('edits trainers and parties in place', () => {
    const t = load().trainerModule!
    t.write(1, 'trainerClass', 9)
    t.setItem(1, 1, 2)
    t.writePartyField(1, 0, 'species', 2)
    t.writePartyField(1, 0, 'level', 50)
    t.writePartyField(1, 0, 'move1', 2)
    expect(t.read(1).trainerClass).toBe(9)
    expect(t.read(1).items[1]).toBe(2)
    expect(t.party(1)[0].species).toBe(2)
    expect(t.party(1)[0].level).toBe(50)
    expect(t.party(1)[0].moves).toEqual([1, 2, 0, 0])

    expect(t.setName(1, 'MAY')).toBe(true)
    expect(t.entries[1].name).toBe('MAY')

    t.revert(1)
    expect(t.read(1).trainerClass).toBe(2)
    expect(t.entries[1].name.trim()).toBe('BRENDAN')
  })

  it('caps party size at the original allocation', () => {
    const t = load().trainerModule!
    expect(t.read(1).maxPartySize).toBe(2)
    t.write(1, 'partySize', 1)
    expect(t.read(1).partySize).toBe(1)
    t.write(1, 'partySize', 6)
    expect(t.read(1).partySize).toBe(2) // clamped to the original 2
  })
})

describe('Gen 1 wild encounters', () => {
  const loadGen1 = () => buildAdapter(new Rom('red.gb', makeGen1Rom())).adapter!

  it('discovers the wild pointer table via the Route 1 anchor', () => {
    const w = loadGen1().wildModule!
    expect(w).not.toBeNull()
    expect(w.entries.map((e) => e.key)).toEqual(['12', '13'])
    expect(w.entries[0].label).toBe('Route 1')
  })

  it('reads grass and water groups with dex-translated species', () => {
    const w = loadGen1().wildModule!
    const groups = w.groups('13')
    expect(groups).toHaveLength(2)
    expect(groups[0]).toMatchObject({ name: 'Grass', rate: 10 })
    expect(groups[0].slots[0]).toEqual({ minLevel: 5, maxLevel: 5, species: 1 })
    expect(groups[1]).toMatchObject({ name: 'Water', rate: 20 })
    expect(groups[1].slots[0].species).toBe(2)
  })

  it('edits slots in internal ids while the UI speaks dex numbers', () => {
    const w = loadGen1().wildModule!
    w.setSlot('13', 0, 0, 'species', 2) // dex 2 -> internal 9
    w.setSlot('13', 0, 0, 'minLevel', 7)
    w.setRate('13', 0, 30)
    const g = w.groups('13')[0]
    expect(g.rate).toBe(30)
    expect(g.slots[0]).toEqual({ minLevel: 7, maxLevel: 7, species: 2 })
    w.revert('13')
    expect(w.groups('13')[0].slots[0].species).toBe(1)
  })
})

describe('Gen 3 wild encounters', () => {
  it('discovers encounter tables cross-checked against maps', () => {
    const w = load().wildModule!
    expect(w).not.toBeNull()
    expect(w.entries.map((e) => e.key)).toEqual(['0.0', '1.0'])
  })

  it('reads groups and slots', () => {
    const w = load().wildModule!
    const groups = w.groups('0.0')
    expect(groups).toHaveLength(2)
    expect(groups[0].name).toBe('Grass / cave')
    expect(groups[0].rate).toBe(20)
    expect(groups[0].slots).toHaveLength(12)
    expect(groups[0].slots[0]).toEqual({ minLevel: 3, maxLevel: 5, species: 1 })
    expect(groups[1].name).toBe('Fishing')
    expect(groups[1].slots).toHaveLength(10)
    expect(w.groups('1.0')).toHaveLength(1)
  })

  it('edits rates and slots, and reverts', () => {
    const w = load().wildModule!
    w.setRate('0.0', 0, 99)
    w.setSlot('0.0', 0, 0, 'species', 2)
    w.setSlot('0.0', 1, 3, 'minLevel', 25)
    expect(w.groups('0.0')[0].rate).toBe(99)
    expect(w.groups('0.0')[0].slots[0].species).toBe(2)
    expect(w.groups('0.0')[1].slots[3].minLevel).toBe(25)
    w.revert('0.0')
    expect(w.groups('0.0')[0].rate).toBe(20)
    expect(w.groups('0.0')[0].slots[0].species).toBe(1)
  })
})
