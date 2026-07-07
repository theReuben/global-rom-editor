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
