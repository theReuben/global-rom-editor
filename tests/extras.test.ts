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

describe('anchor self-edit resilience (extras)', () => {
  it('re-discovers evolutions, learnsets and TM bits after Bulbasaur edits', () => {
    const a = load()
    // The documented caveat scenario: change the anchor species' own
    // evolution, learnset and TM flags, then reload.
    a.evolutions!.write(1, 0, 'param', 40)
    a.evolutions!.write(1, 0, 'target', 6)
    a.learnsets!.write(1, [{ level: 5, move: 20 }])
    const flags = a.readSpecies(1).tmhm as boolean[]
    ;(flags as boolean[])[0] = !flags[0]
    a.writeSpeciesField(1, 'tmhm', flags)

    const re = buildAdapter(new Rom('firered.gba', a.rom.bytes)).adapter!
    expect(re.evolutions).not.toBeNull()
    expect(re.learnsets).not.toBeNull()
    expect(re.evolutions!.read(1)[0]).toMatchObject({ param: 40, target: 6 })
    expect(re.learnsets!.read(1)).toEqual([{ level: 5, move: 20 }])
    expect(re.readSpecies(1).tmhm).toBeDefined()
  })
})

describe('Gen 3 sprites', () => {
  it('discovers the self-tagged sprite tables and renders front + back', () => {
    const a = load()
    expect(a.speciesSprite).not.toBeNull()
    const img = a.speciesSprite!(1)!
    expect(img.width).toBe(64)
    expect(img.height).toBe(64)
    expect([img.pixels[0], img.pixels[1], img.pixels[2], img.pixels[3]]).toEqual([255, 0, 0, 255])
    // Both tables are single-frame here, so ROM order decides: the
    // second table is the back (green in the fixture).
    expect(a.speciesSpriteBack).not.toBeNull()
    const back = a.speciesSpriteBack!(1)!
    expect([back.pixels[0], back.pixels[1], back.pixels[2]]).toEqual([0, 255, 0])
    // Shiny palette: same pixels, blue instead of red.
    expect(a.hasShinySprites).toBe(true)
    const shiny = a.speciesSprite!(1, true)!
    expect([shiny.pixels[0], shiny.pixels[1], shiny.pixels[2]]).toEqual([0, 0, 255])
  })

  it('imports a back sprite independently of the front', () => {
    const a = load()
    expect(a.importSpeciesSpriteBack).not.toBeNull()
    const pixels = new Uint8ClampedArray(64 * 64 * 4)
    for (let p = 0; p < 64 * 64; p++) {
      pixels[p * 4 + 2] = 255 // solid blue
      pixels[p * 4 + 3] = 255
    }
    // Solid color: every pixel maps to the transparent background slot.
    expect(a.importSpeciesSpriteBack!(1, { pixels, width: 64, height: 64 })).toBeNull()
    const back = a.speciesSpriteBack!(1)!
    expect(back.pixels[3]).toBe(0) // slot 0 renders transparent
    // A fresh scan still classifies both tables.
    const re = buildAdapter(new Rom('firered.gba', a.rom.bytes)).adapter!
    expect(re.speciesSpriteBack).not.toBeNull()
  })

  const testImage = () => {
    // Transparent border, red left half, green right half.
    const pixels = new Uint8ClampedArray(64 * 64 * 4)
    for (let y = 8; y < 56; y++) {
      for (let x = 8; x < 56; x++) {
        const o = (y * 64 + x) * 4
        if (x < 32) pixels[o] = 255
        else pixels[o + 1] = 255
        pixels[o + 3] = 255
      }
    }
    return { pixels, width: 64, height: 64 }
  }

  it('rejects wrong sizes and too many colors', () => {
    const a = load()
    expect(a.importSpeciesSprite).not.toBeNull()
    expect(a.importSpeciesSprite!(1, { pixels: new Uint8ClampedArray(32 * 32 * 4), width: 32, height: 32 }))
      .toMatch(/64×64/)
    const noisy = new Uint8ClampedArray(64 * 64 * 4)
    for (let p = 0; p < 64 * 64; p++) {
      noisy[p * 4] = (p * 8) & 0xff // ~32 distinct red levels
      noisy[p * 4 + 3] = 255
    }
    expect(a.importSpeciesSprite!(1, { pixels: noisy, width: 64, height: 64 })).toMatch(/colors/)
  })

  it('imports a sprite, relocating the compressed data when it grows', () => {
    const a = load()
    expect(a.importSpeciesSprite!(1, testImage())).toBeNull()
    const at = (img: { pixels: Uint8ClampedArray }, x: number, y: number) => {
      const o = (y * 64 + x) * 4
      return [img.pixels[o], img.pixels[o + 1], img.pixels[o + 2], img.pixels[o + 3]]
    }
    const img = a.speciesSprite!(1)!
    expect(at(img, 0, 0)[3]).toBe(0) // border transparent
    expect(at(img, 16, 16)).toEqual([255, 0, 0, 255]) // red half
    expect(at(img, 48, 16)).toEqual([0, 255, 0, 255]) // green half
    expect(a.rom.changedByteCount).toBeGreaterThan(0)

    // Acid test: a fresh scan of the edited bytes must still find the
    // sprite tables and decode the imported image.
    const re = buildAdapter(new Rom('firered.gba', a.rom.bytes)).adapter!
    expect(re.speciesSprite).not.toBeNull()
    const reImg = re.speciesSprite!(1)!
    expect(at(reImg, 16, 16)).toEqual([255, 0, 0, 255])
    expect(at(reImg, 48, 16)).toEqual([0, 255, 0, 255])
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
