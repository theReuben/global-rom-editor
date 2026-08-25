/**
 * pokeemerald-expansion adapter.
 *
 * The fixture's species stride (0x120) and pointer-block offset are
 * deliberately not the ones the reference ROM used, so these tests fail
 * if discovery is ever replaced by an assumption.
 */
import { describe, expect, it } from 'vitest'
import { Rom } from '../src/core/rom'
import { buildAdapter } from '../src/core/games'
import { findSpeciesTable, findMoveTable, voteTable } from '../src/core/gba/expansion'
import { makeGen3ExpansionRom, makeGen3Rom } from './fixtures'

function adapter() {
  const rom = new Rom('expansion.gba', makeGen3ExpansionRom())
  const { adapter } = buildAdapter(rom)
  if (!adapter) throw new Error('no adapter built')
  return { rom, a: adapter }
}

describe('expansion discovery', () => {
  it('discovers the species table base, stride and count', () => {
    const table = findSpeciesTable(makeGen3ExpansionRom())
    expect(table).not.toBeNull()
    expect(table!.base).toBe(0x010000)
    expect(table!.stride).toBe(0x120)
    expect(table!.count).toBe(160)
    expect(table!.pointerBlock).toBe(160)
  })

  it('discovers the move table by its name pointers', () => {
    const table = findMoveTable(makeGen3ExpansionRom())
    expect(table).not.toBeNull()
    expect(table!.base).toBe(0x020000)
    expect(table!.stride).toBe(68)
    expect(table!.count).toBe(200)
  })

  it('does not mistake a vanilla Gen 3 ROM for an expansion one', () => {
    expect(findSpeciesTable(makeGen3Rom())).toBeNull()
  })

  it('still builds the vanilla adapter for a vanilla ROM', () => {
    const { adapter } = buildAdapter(new Rom('fire.gba', makeGen3Rom()))
    expect(adapter?.gameName).not.toContain('expansion')
  })

  it('needs two agreeing anchor pairs before trusting a table', () => {
    // A single anchor implies no pair at all, so nothing is returned.
    expect(voteTable([{ index: 1, offsets: [0x1000] }], { minStride: 4, maxStride: 0x400 })).toBeNull()
    // Two anchors agree on exactly one pair — still short of the bar.
    const two = voteTable(
      [
        { index: 1, offsets: [0x1000] },
        { index: 2, offsets: [0x1100] },
      ],
      { minStride: 4, maxStride: 0x400 },
    )
    expect(two).toBeNull()
    // Three collinear anchors give three agreeing pairs.
    const three = voteTable(
      [
        { index: 1, offsets: [0x1000] },
        { index: 2, offsets: [0x1100] },
        { index: 3, offsets: [0x1200] },
      ],
      { minStride: 4, maxStride: 0x400 },
    )
    expect(three).toEqual({ base: 0x0f00, stride: 0x100, votes: 3 })
  })
})

describe('expansion adapter', () => {
  it('reads the widened species fields', () => {
    const { a } = adapter()
    expect(a.species[0].name).toBe('Bulbasaur')
    expect(a.species.length).toBe(160)
    const s = a.readSpecies(1)
    expect(s.hp).toBe(45)
    expect(s.type1).toBe(13) // the expansion's Type enum is 1-based
    expect(s.expYield).toBe(64) // u16, not vanilla's u8
    expect(s.abilityHidden).toBe(34) // third ability slot
    expect(s.evSat).toBe(1)
  })

  it('labels types and abilities with names read from the ROM', () => {
    const { a } = adapter()
    expect(a.typeOptions[13].label).toBe('Grass')
    expect(a.typeOptions[1].label).toBe('Normal')
    const ability = a.speciesFields.find((f) => f.key === 'ability1')
    expect(ability?.options?.[65].label).toBe('Overgrow')
    expect(a.itemOptions?.[4].label).toBe('Master Ball')
  })

  it('writes 16-bit species fields and reverts them', () => {
    const { a } = adapter()
    a.writeSpeciesField(1, 'expYield', 1234)
    a.writeSpeciesField(1, 'abilityHidden', 300)
    expect(a.readSpecies(1).expYield).toBe(1234)
    expect(a.readSpecies(1).abilityHidden).toBe(300)
    a.revertSpecies(1)
    expect(a.readSpecies(1).expYield).toBe(64)
    expect(a.readSpecies(1).abilityHidden).toBe(34)
  })

  it('sets one EV yield without disturbing the others', () => {
    const { a } = adapter()
    a.writeSpeciesField(1, 'evSdf', 3)
    expect(a.readSpecies(1).evSdf).toBe(3)
    expect(a.readSpecies(1).evSat).toBe(1)
  })

  it('renames a species in its inline name field', () => {
    const { a } = adapter()
    expect(a.setSpeciesName(1, 'Testmon')).toBe(true)
    expect(a.species[0].name).toBe('Testmon')
    a.revertSpecies(1)
    expect(a.species[0].name).toBe('Bulbasaur')
  })

  it('reads move names through their pointers', () => {
    const { a } = adapter()
    expect(a.moves[0].name).toBe('Pound')
    expect(a.moves[1].name).toBe('Karate Chop')
    expect(a.moves[84].name).toBe('Thunderbolt')
  })

  it('packs move bitfields without corrupting their neighbours', () => {
    const { a } = adapter()
    const before = a.readMove(85)
    expect(before).toMatchObject({ type: 14, category: 1, power: 90, accuracy: 100, target: 1 })
    a.writeMoveField(85, 'power', 511) // 9 bits, more than vanilla could hold
    expect(a.readMove(85)).toMatchObject({ power: 511, type: 14, category: 1 })
    a.writeMoveField(85, 'accuracy', 55)
    expect(a.readMove(85)).toMatchObject({ accuracy: 55, target: 1 })
    a.writeMoveField(85, 'priority', -6) // 4-bit signed
    expect(a.readMove(85).priority).toBe(-6)
    a.revertMove(85)
    expect(a.readMove(85)).toEqual(before)
  })

  it('reads per-species learnsets, egg moves and evolutions', () => {
    const { a } = adapter()
    expect(a.learnsets?.read(1)).toEqual([
      { level: 1, move: 33 },
      { level: 1, move: 45 },
      { level: 3, move: 22 },
    ])
    expect(a.eggMoves?.read(1)).toEqual([34, 35])
    expect(a.evolutions?.read(1)).toEqual([{ method: 1, param: 16, target: 2 }])
  })

  it('rewrites a learnset in place when it shrinks', () => {
    const { rom, a } = adapter()
    const before = rom.changedByteCount
    expect(a.learnsets?.write(1, [{ level: 5, move: 99 }])).toBe(true)
    expect(a.learnsets?.read(1)).toEqual([{ level: 5, move: 99 }])
    expect(rom.changedByteCount).toBeGreaterThan(before)
  })

  it('relocates a grown learnset and repoints only that species', () => {
    const { a } = adapter()
    const other = a.learnsets!.read(2)
    const grown = [...a.learnsets!.read(1), { level: 40, move: 7 }, { level: 50, move: 8 }]
    expect(a.learnsets?.write(1, grown)).toBe(true)
    expect(a.learnsets?.read(1)).toEqual(grown)
    // Species 2 shares the original blob in this fixture; it must be
    // left pointing at the untouched original.
    expect(a.learnsets?.read(2)).toEqual(other)
  })

  it('grows an egg move list without clobbering the learnset it follows', () => {
    const { a } = adapter()
    const grownLearnset = [...a.learnsets!.read(1), { level: 40, move: 7 }]
    expect(a.learnsets?.write(1, grownLearnset)).toBe(true)
    expect(a.eggMoves?.write(1, [34, 35, 36, 37])).toBe(true)
    expect(a.eggMoves?.read(1)).toEqual([34, 35, 36, 37])
    expect(a.learnsets?.read(1)).toEqual(grownLearnset)
  })

  it('edits an existing evolution entry and reverts it', () => {
    const { a } = adapter()
    a.evolutions?.write(1, 0, 'param', 22)
    a.evolutions?.write(1, 0, 'target', 3)
    expect(a.evolutions?.read(1)).toEqual([{ method: 1, param: 22, target: 3 }])
    a.evolutions?.revert(1)
    expect(a.evolutions?.read(1)).toEqual([{ method: 1, param: 16, target: 2 }])
  })

  it('reads time-of-day wild encounters and writes them back', () => {
    const { a } = adapter()
    const w = a.wildModule
    expect(w).not.toBeNull()
    const key = w!.entries[0].key
    const groups = w!.groups(key)
    expect(groups.map((g) => g.name)).toEqual([
      'Morning — Land',
      'Day — Land',
      'Evening — Land',
      'Night — Land',
    ])
    expect(groups[0].rate).toBe(20)
    expect(groups[0].slots).toHaveLength(12)
    w!.setSlot(key, 0, 0, 'species', 25)
    w!.setRate(key, 0, 42)
    expect(w!.groups(key)[0].slots[0].species).toBe(25)
    expect(w!.groups(key)[0].rate).toBe(42)
    w!.revert(key)
    expect(w!.groups(key)[0]).toEqual(groups[0])
  })

  it('disables the editors whose expansion formats are not decoded', () => {
    const { a } = adapter()
    expect(a.trainerModule).toBeNull()
    expect(a.itemModule).toBeNull()
    expect(a.warnings.join(' ')).toContain('Trainer and item editing are not available')
  })
})
