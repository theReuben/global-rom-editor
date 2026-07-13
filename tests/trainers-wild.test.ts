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

describe('Gen 1 trainer parties', () => {
  const loadGen1 = () => buildAdapter(new Rom('red.gb', makeGen1Rom())).adapter!

  it('discovers the class pointer table via the Youngster anchor', () => {
    const t = loadGen1().trainerModule!
    expect(t).not.toBeNull()
    // 3 Youngsters + 1 Bug Catcher + 1 Lass; classes 3+ are empty.
    expect(t.entries).toHaveLength(5)
    expect(t.entries[0].name).toBe('Youngster #1')
    expect(t.entries[3].name).toBe('Bug Catcher #1')
    expect(t.entries[4].name).toBe('Lass #1')
    expect(t.classOptions![24].label).toBe('Rival 1')
    expect(t.features).toMatchObject({ identity: false, items: false })
  })

  it('reads both party list formats with dex-translated species', () => {
    const t = loadGen1().trainerModule!
    // Special format: per-mon levels.
    const special = t.party(3)
    expect(special).toHaveLength(2)
    expect(special[0]).toMatchObject({ species: 1, level: 5, iv: null, item: null, moves: null })
    expect(special[1]).toMatchObject({ species: 2, level: 7 })
    // Fixed format: one shared level for the whole party.
    const fixed = t.party(4)
    expect(fixed).toHaveLength(2)
    expect(fixed[0]).toMatchObject({ species: 1, level: 20 })
    expect(fixed[1]).toMatchObject({ species: 1, level: 20 })
    expect(t.read(4).partySize).toBe(2)
    expect(t.read(4).maxPartySize).toBe(6) // growth relocates the class block
  })

  it('grows a party by relocating the class block to bank padding', () => {
    const a = loadGen1()
    const t = a.trainerModule!
    t.write(4, 'partySize', 4) // Lass #1: 2 -> 4 (block must relocate)
    const party = t.party(4)
    expect(party).toHaveLength(4)
    expect(party[2]).toMatchObject({ species: 1, level: 20 }) // duplicated last mon
    expect(party[3]).toMatchObject({ species: 1, level: 20 })
    // Edits still land after the move.
    t.writePartyField(4, 3, 'species', 2)
    expect(t.party(4)[3].species).toBe(2)

    // A fresh scan of the edited bytes must find the relocated class.
    const re = buildAdapter(new Rom('red.gb', a.rom.bytes)).adapter!
    const rt = re.trainerModule!
    expect(rt.entries).toHaveLength(5)
    expect(rt.party(4)).toHaveLength(4)
    expect(rt.party(4)[3].species).toBe(2)
    expect(rt.party(3)).toHaveLength(2) // other classes untouched

    // Shrink back in place and revert fully.
    t.write(4, 'partySize', 1)
    expect(t.party(4)).toHaveLength(1)
    t.revert(4)
    expect(t.party(4)).toHaveLength(2)
    expect(a.rom.changedByteCount).toBe(0)
  })

  it('edits species and levels in place and reverts', () => {
    const a = loadGen1()
    const t = a.trainerModule!
    t.writePartyField(3, 1, 'species', 1) // dex 1 -> internal 10
    t.writePartyField(3, 0, 'level', 9)
    expect(t.party(3)[1].species).toBe(1)
    expect(t.party(3)[0].level).toBe(9)
    // Fixed format: the level byte is shared by every slot.
    t.writePartyField(4, 1, 'level', 33)
    expect(t.party(4)[0].level).toBe(33)
    // Level 0 would terminate the list, so it clamps to 1.
    t.writePartyField(3, 0, 'level', 0)
    expect(t.party(3)[0].level).toBe(1)
    t.revert(3)
    t.revert(4)
    expect(t.party(3)[1].species).toBe(2)
    expect(t.party(3)[0].level).toBe(5)
    expect(t.party(4)[0].level).toBe(20)
    expect(a.rom.changedByteCount).toBe(0)
  })

  it('re-discovers the table after the anchor trainer itself is edited', () => {
    const a = loadGen1()
    const t = a.trainerModule!
    // Youngster #1 IS the discovery anchor — clobber its whole party.
    t.writePartyField(0, 0, 'species', 1)
    t.writePartyField(0, 1, 'species', 2)
    t.writePartyField(0, 0, 'level', 99)
    // Reload from the edited bytes: the self-referencing pointer-table
    // fallback must still find everything.
    const re = buildAdapter(new Rom('red.gb', a.rom.bytes)).adapter!
    const rt = re.trainerModule!
    expect(rt).not.toBeNull()
    expect(rt.entries).toHaveLength(5)
    expect(rt.party(0)[0]).toMatchObject({ species: 1, level: 99 })
    expect(rt.party(3)[0]).toMatchObject({ species: 1, level: 5 })
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

describe('Gen 2 trainer parties', () => {
  const loadGen2 = async () => {
    const { makeGen2Rom } = await import('./fixtures')
    return buildAdapter(new Rom('crystal.gbc', makeGen2Rom())).adapter!
  }

  it('discovers the class table via the Falkner anchor and derives the count', async () => {
    const t = (await loadGen2()).trainerModule!
    expect(t).not.toBeNull()
    expect(t.entries).toHaveLength(67) // 1+1+2+1 + 62 filler classes
    expect(t.entries[0].name).toBe('FALKNER')
    expect(t.entries[0].label).toBe('FALKNER (LEADER #1)')
    expect(t.entries[2].name).toBe('JOEY')
    expect(t.entries[2].label).toBe('JOEY (LEADER #1)') // class 3 is a LEADER in the fixture names
    expect(t.entries[3].name).toBe('MIKEY')
    expect(t.read(3).partySize).toBe(2)
  })

  it('reads all party formats: moves, plain, item+moves', async () => {
    const t = (await loadGen2()).trainerModule!
    // TRAINERTYPE_MOVES (Falkner): moves array, no item.
    const falkner = t.party(0)
    expect(falkner).toHaveLength(2)
    expect(falkner[0]).toEqual({ species: 16, level: 7, iv: null, item: null, moves: [33, 189, 0, 0] })
    expect(falkner[1].moves).toEqual([33, 189, 16, 0])
    // TRAINERTYPE_NORMAL (Mikey): neither.
    expect(t.party(3)[1]).toEqual({ species: 19, level: 4, iv: null, item: null, moves: null })
    // TRAINERTYPE_ITEM_MOVES (Red): both.
    expect(t.party(4)[0]).toEqual({ species: 25, level: 30, iv: null, item: 3, moves: [33, 45, 85, 87] })
  })

  it('edits levels, species, items, moves and names in place', async () => {
    const a = await loadGen2()
    const t = a.trainerModule!
    t.writePartyField(4, 0, 'species', 250)
    t.writePartyField(4, 0, 'level', 88)
    t.writePartyField(4, 0, 'item', 12)
    t.writePartyField(4, 0, 'move2', 200)
    expect(t.party(4)[0]).toMatchObject({ species: 250, level: 88, item: 12, moves: [33, 45, 200, 87] })
    // NORMAL trainers reject item/move writes (no such bytes).
    t.writePartyField(2, 0, 'item', 5)
    t.writePartyField(2, 0, 'move0', 5)
    expect(t.party(2)[0]).toMatchObject({ item: null, moves: null })
    // Same-footprint rename: shorter name pads with spaces.
    expect(t.setName(0, 'ZAP')).toBe(true)
    expect(t.entries[0].name).toBe('ZAP')
    expect(t.setName(0, 'TOOLONGNAME')).toBe(false) // 11 > FALKNER's 7 bytes
    t.revert(4)
    t.revert(0)
    expect(t.party(4)[0].species).toBe(25)
    expect(t.entries[0].name).toBe('FALKNER')
    expect(a.rom.changedByteCount).toBe(0)
  })

  it('grows and shrinks parties by rebuilding the class group', async () => {
    const a = await loadGen2()
    const t = a.trainerModule!
    expect(t.read(0).maxPartySize).toBe(6)
    t.write(0, 'partySize', 5) // Falkner 2 -> 5: group must relocate
    const party = t.party(0)
    expect(party).toHaveLength(5)
    expect(party[4].species).toBe(17) // duplicated Pidgeotto
    expect(party[4].moves).toEqual([33, 189, 16, 0])
    t.writePartyField(0, 4, 'species', 251)
    expect(t.party(0)[4].species).toBe(251)
    expect(t.entries[0].name).toBe('FALKNER') // name survived the rebuild

    const re = buildAdapter(new Rom('crystal.gbc', a.rom.bytes)).adapter!
    expect(re.trainerModule!.entries).toHaveLength(67)
    expect(re.trainerModule!.party(0)).toHaveLength(5)
    expect(re.trainerModule!.party(1)).toHaveLength(2) // Whitney untouched

    t.write(0, 'partySize', 1)
    expect(t.party(0)).toHaveLength(1)
    t.revert(0)
    expect(t.party(0)).toHaveLength(2)
    expect(a.rom.changedByteCount).toBe(0)
  })

  it('re-discovers the table after the anchor trainer itself is edited', async () => {
    const a = await loadGen2()
    const t = a.trainerModule!
    t.writePartyField(0, 0, 'species', 130)
    t.writePartyField(0, 0, 'level', 62)
    t.setName(0, 'MAX')
    const re = buildAdapter(new Rom('crystal.gbc', a.rom.bytes)).adapter!
    const rt = re.trainerModule!
    expect(rt).not.toBeNull()
    expect(rt.entries).toHaveLength(67)
    expect(rt.entries[0].name).toBe('MAX')
    expect(rt.party(0)[0]).toMatchObject({ species: 130, level: 62 })
  })
})

describe('Gen 2 wild encounters (Crystal)', () => {
  const loadGen2 = async () => {
    const { makeGen2Rom } = await import('./fixtures')
    return buildAdapter(new Rom('crystal.gbc', makeGen2Rom())).adapter!
  }

  it('discovers areas via the Sprout Tower anchor', async () => {
    const w = (await loadGen2()).wildModule!
    expect(w).not.toBeNull()
    expect(w.entries).toHaveLength(5)
    expect(w.entries.map((e) => e.key)).toContain('3.2')
    expect(w.entries.map((e) => e.key)).toContain('11.1')
  })

  it('exposes morning/day/night grass and water groups', async () => {
    const w = (await loadGen2()).wildModule!
    const sprout = w.groups('3.2')
    expect(sprout.map((g) => g.name)).toEqual(['Grass (morning)', 'Grass (day)', 'Grass (night)'])
    expect(sprout[0].rate).toBe(5)
    expect(sprout[0].slots).toHaveLength(7)
    expect(sprout[0].slots[0]).toEqual({ minLevel: 3, maxLevel: 3, species: 19 })
    expect(sprout[2].slots[0].species).toBe(92) // Gastly at night

    const water = w.groups('11.1')
    expect(water).toHaveLength(1)
    expect(water[0].name).toBe('Water')
    expect(water[0].slots).toHaveLength(3)
    expect(water[0].slots[1]).toEqual({ minLevel: 20, maxLevel: 20, species: 195 })
  })

  it('edits and reverts per time-of-day', async () => {
    const w = (await loadGen2()).wildModule!
    w.setSlot('3.2', 2, 0, 'species', 200)
    w.setRate('3.2', 1, 40)
    expect(w.groups('3.2')[2].slots[0].species).toBe(200)
    expect(w.groups('3.2')[1].rate).toBe(40)
    expect(w.groups('3.2')[0].rate).toBe(5) // morning untouched
    w.revert('3.2')
    expect(w.groups('3.2')[2].slots[0].species).toBe(92)
  })
})
