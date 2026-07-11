import { describe, expect, it } from 'vitest'
import { Rom } from '../src/core/rom'
import { buildAdapter } from '../src/core/games'
import { makeGen3Rom } from './fixtures'

const load = () => buildAdapter(new Rom('firered.gba', makeGen3Rom())).adapter!

describe('Gen 3 evolutions', () => {
  it('discovers and reads the evolution table', () => {
    const evo = load().evolutions!
    expect(evo).not.toBeNull()
    expect(evo.read(1)[0]).toEqual({ method: 4, param: 16, target: 2 })
    expect(evo.read(1)[1]).toEqual({ method: 0, param: 0, target: 0 })
    expect(evo.read(2)[0]).toEqual({ method: 4, param: 32, target: 3 })
  })

  it('edits and reverts evolutions', () => {
    const evo = load().evolutions!
    evo.write(1, 0, 'param', 20)
    evo.write(1, 1, 'method', 7) // use item
    evo.write(1, 1, 'target', 2)
    expect(evo.read(1)[0].param).toBe(20)
    expect(evo.read(1)[1]).toEqual({ method: 7, param: 0, target: 2 })
    evo.revert(1)
    expect(evo.read(1)[0].param).toBe(16)
  })
})

describe('Gen 3 learnsets', () => {
  it('discovers and reads learnsets', () => {
    const ls = load().learnsets!
    expect(ls).not.toBeNull()
    expect(ls.read(1)).toEqual([
      { level: 1, move: 33 },
      { level: 4, move: 45 },
    ])
    expect(ls.read(4)).toEqual([
      { level: 1, move: 10 },
      { level: 1, move: 45 },
    ])
  })

  it('writes in place when the list shrinks or stays', () => {
    const ls = load().learnsets!
    expect(ls.write(1, [{ level: 5, move: 22 }])).toBe(true)
    expect(ls.read(1)).toEqual([{ level: 5, move: 22 }])
  })

  it('relocates when the list grows', () => {
    const a = load()
    const ls = a.learnsets!
    const grown = [
      { level: 1, move: 33 },
      { level: 4, move: 45 },
      { level: 7, move: 73 },
      { level: 10, move: 22 },
    ]
    expect(ls.write(1, grown)).toBe(true)
    expect(ls.read(1)).toEqual(grown)
    expect(ls.read(2)).toEqual([
      { level: 1, move: 33 },
      { level: 4, move: 45 },
    ]) // ivysaur untouched
  })
})

describe('Gen 3 TM/HM compatibility', () => {
  it('discovers the table and reads flags', () => {
    const a = load()
    const field = a.speciesFields.find((f) => f.key === 'tmhm')
    expect(field).toBeDefined()
    expect(field!.flagLabels![0]).toContain('TM01')
    const flags = a.readSpecies(1).tmhm as boolean[]
    expect(flags).toHaveLength(58)
    expect(flags[5]).toBe(true) // TM06 Toxic
    expect(flags[0]).toBe(false) // TM01 Focus Punch
    expect(flags[50]).toBe(true) // HM01 Cut
    expect(flags[51]).toBe(false) // HM02 Fly
  })

  it('writes and reverts flags', () => {
    const a = load()
    const flags = (a.readSpecies(1).tmhm as boolean[]).slice()
    flags[0] = true
    flags[5] = false
    a.writeSpeciesField(1, 'tmhm', flags)
    const after = a.readSpecies(1).tmhm as boolean[]
    expect(after[0]).toBe(true)
    expect(after[5]).toBe(false)
    a.revertSpecies(1)
    expect((a.readSpecies(1).tmhm as boolean[])[5]).toBe(true)
  })
})

describe('Gen 3 sprites', () => {
  it('discovers the self-tagged sprite tables and renders', () => {
    const a = load()
    expect(a.speciesSprite).not.toBeNull()
    const img = a.speciesSprite!(1)!
    expect(img.width).toBe(64)
    expect(img.height).toBe(64)
    expect([img.pixels[0], img.pixels[1], img.pixels[2], img.pixels[3]]).toEqual([255, 0, 0, 255])
  })
})

describe('Gen 3 type chart', () => {
  it('discovers and reads matchups', () => {
    const chart = load().typeChart!
    expect(chart).not.toBeNull()
    const entries = chart.entries()
    expect(entries).toHaveLength(5)
    expect(entries[0]).toMatchObject({ attacker: 0, defender: 5, multiplier: 5 })
    expect(entries[3]).toMatchObject({ attacker: 10, defender: 12, multiplier: 20 })
    expect(entries[4]).toMatchObject({ attacker: 0, defender: 7, multiplier: 0 }) // after separator
  })

  it('edits multipliers in place', () => {
    const chart = load().typeChart!
    chart.setMultiplier(3, 5)
    expect(chart.entries()[3].multiplier).toBe(5)
  })

  it('adds a matchup before the separator (relocates)', () => {
    const chart = load().typeChart!
    expect(chart.addEntry(12, 11, 20)).toBe(true) // Grass → Water 2×
    const entries = chart.entries()
    expect(entries).toHaveLength(6)
    expect(entries[4]).toMatchObject({ attacker: 12, defender: 11, multiplier: 20 })
    expect(entries[5]).toMatchObject({ attacker: 0, defender: 7 }) // still after separator
  })

  it('removes a matchup', () => {
    const chart = load().typeChart!
    expect(chart.removeEntry(0)).toBe(true)
    const entries = chart.entries()
    expect(entries).toHaveLength(4)
    expect(entries[0]).toMatchObject({ attacker: 0, defender: 8 })
  })
})
