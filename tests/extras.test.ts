import { describe, expect, it } from 'vitest'
import { Rom } from '../src/core/rom'
import { buildAdapter } from '../src/core/games'
import { buildGen3EggMoves } from '../src/core/gba/eggmoves'
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

describe('Gen 3 egg moves', () => {
  const SPECIES_COUNT = 411
  const MOVE_COUNT = 354
  const TABLE = 0x20000
  const POINTER = 0x1000

  /**
   * Minimal ROM-shaped buffer: an egg move array plus the code pointer
   * that discovery verifies against, and trailing padding to relocate
   * into. The synthetic fixture ROM only has 2 species / 2 moves, which
   * is too small to exercise a shared variable-length table.
   */
  const makeEggRom = (
    entries: { species: number; moves: number[] }[],
    opts: { pointer?: boolean; pad?: boolean } = {},
  ) => {
    const bytes = new Uint8Array(0x100000)
    if (opts.pad !== false) bytes.fill(0xff, 0xf0000)
    let o = TABLE
    const put16 = (v: number) => {
      bytes[o] = v & 0xff
      bytes[o + 1] = (v >> 8) & 0xff
      o += 2
    }
    for (const e of entries) {
      put16(e.species + 20000)
      for (const m of e.moves) put16(m)
    }
    put16(0xffff)
    if (opts.pointer !== false) {
      const v = 0x08000000 + TABLE
      bytes[POINTER] = v & 0xff
      bytes[POINTER + 1] = (v >> 8) & 0xff
      bytes[POINTER + 2] = (v >> 16) & 0xff
      bytes[POINTER + 3] = (v >>> 24) & 0xff
    }
    return bytes
  }

  /** 12 species, dex-ordered, 1-4 moves each. */
  const sample = () =>
    Array.from({ length: 12 }, (_, i) => ({
      species: (i + 1) * 7,
      moves: Array.from({ length: (i % 4) + 1 }, (_, j) => i * 4 + j + 1),
    }))

  const build = (bytes: Uint8Array) => {
    const rom = new Rom('egg.gba', bytes)
    return { rom, built: buildGen3EggMoves(rom, SPECIES_COUNT, MOVE_COUNT) }
  }

  it('discovers the table structurally and reads it back', () => {
    const { built } = build(makeEggRom(sample()))
    expect(built).not.toBeNull()
    expect(built!.offset).toBe(TABLE)
    const eggs = built!.module
    expect(eggs.species()).toEqual(sample().map((e) => e.species))
    expect(eggs.read(7)).toEqual([1])
    expect(eggs.read(28)).toEqual([13, 14, 15, 16])
    expect(eggs.read(9)).toEqual([]) // no entry for this species
  })

  it('refuses a table with no code pointer to it', () => {
    const { built } = build(makeEggRom(sample(), { pointer: false }))
    expect(built).toBeNull()
  })

  it('rewrites a species in place when the table does not grow', () => {
    const { rom, built } = build(makeEggRom(sample()))
    const eggs = built!.module
    // Species 14 already has two moves, so swapping both keeps the
    // table's total length and it must stay put.
    expect(eggs.read(14)).toEqual([5, 6])
    expect(eggs.write(14, [40, 41])).toBe(true)
    // Re-discovering from the edited bytes must find the same table.
    const again = buildGen3EggMoves(new Rom('re.gba', rom.bytes), SPECIES_COUNT, MOVE_COUNT)!
    expect(again.offset).toBe(TABLE)
    expect(again.module.read(14)).toEqual([40, 41])
    expect(again.module.read(7)).toEqual([1]) // neighbour untouched
    expect(again.module.species()).toEqual(sample().map((e) => e.species))
  })

  it('inserts a new species in dex order and drops one on an empty write', () => {
    const { rom, built } = build(makeEggRom(sample()))
    const eggs = built!.module
    expect(eggs.write(10, [99])).toBe(true)
    expect(eggs.write(14, [])).toBe(true)
    const again = buildGen3EggMoves(new Rom('re.gba', rom.bytes), SPECIES_COUNT, MOVE_COUNT)!
    const ids = again.module.species()
    expect(ids).toEqual([...ids].sort((a, b) => a - b)) // still ascending
    expect(ids).toContain(10)
    expect(ids).not.toContain(14)
    expect(again.module.read(10)).toEqual([99])
  })

  it('relocates and retargets the pointer when the table outgrows itself', () => {
    const { rom, built } = build(makeEggRom(sample()))
    const eggs = built!.module
    for (const e of sample()) {
      expect(eggs.write(e.species, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(true)
    }
    const again = buildGen3EggMoves(new Rom('re.gba', rom.bytes), SPECIES_COUNT, MOVE_COUNT)!
    expect(again.offset).not.toBe(TABLE) // moved into the trailing padding
    expect(again.offset).toBeGreaterThanOrEqual(0xf0000)
    // The pointer followed the data.
    const ptr =
      (rom.bytes[POINTER] |
        (rom.bytes[POINTER + 1] << 8) |
        (rom.bytes[POINTER + 2] << 16) |
        (rom.bytes[POINTER + 3] << 24)) >>>
      0
    expect(ptr).toBe(0x08000000 + again.offset)
    for (const e of sample()) {
      expect(again.module.read(e.species)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    }
  })

  it('reports failure instead of corrupting when there is no free space', () => {
    const { rom, built } = build(makeEggRom(sample(), { pad: false }))
    const eggs = built!.module
    const before = rom.bytes.slice(TABLE, TABLE + 200)
    let failed = false
    for (const e of sample()) {
      if (!eggs.write(e.species, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])) failed = true
    }
    expect(failed).toBe(true)
    // A refused write leaves the table readable.
    const again = buildGen3EggMoves(new Rom('re.gba', rom.bytes), SPECIES_COUNT, MOVE_COUNT)
    expect(again).not.toBeNull()
    expect(before.length).toBe(200)
  })

  it('rejects out-of-range moves and over-long lists', () => {
    const { built } = build(makeEggRom(sample()))
    const eggs = built!.module
    expect(eggs.write(7, [MOVE_COUNT + 1])).toBe(false)
    expect(eggs.write(7, [0])).toBe(false)
    expect(eggs.write(7, Array(eggs.maxMoves + 1).fill(1))).toBe(false)
    expect(eggs.write(0, [1])).toBe(false)
    expect(eggs.read(7)).toEqual([1]) // unchanged
  })

  it('reverts an edited table byte for byte', () => {
    const source = makeEggRom(sample())
    const { rom, built } = build(source)
    built!.module.write(7, [40, 41, 42])
    rom.revertAll()
    expect(rom.changedByteCount).toBe(0)
    expect([...rom.bytes]).toEqual([...source])
  })
})

describe('Gen 3 items', () => {
  const items = () => load().itemModule!

  it('discovers the table structurally and reads the 44-byte entry', () => {
    const a = load()
    expect(a.itemModule).not.toBeNull()
    const m = a.itemModule!
    expect(m.entries).toHaveLength(120)
    expect(m.entries[1].name).toBe('MASTER BALL')
    expect(m.entries[3].name).toBe('POTION')
    const potion = m.read(3)
    expect(potion.price).toBe(30)
    expect(potion.holdEffect).toBe(3)
    expect(potion.holdEffectParam).toBe(3)
    expect(potion.pocket).toBe(4)
    expect(potion.secondaryId).toBe(3)
    expect(a.regions.find((r) => r.name === 'Item data')!.offset).toBe(0x3a0000)
  })

  it('writes fields and reads them back from a reloaded ROM', () => {
    const a = load()
    const m = a.itemModule!
    m.write(2, 'price', 4321)
    m.write(2, 'pocket', 1)
    m.write(2, 'battleUsage', 2)
    const re = buildAdapter(new Rom('re.gba', a.rom.bytes)).adapter!
    const back = re.itemModule!.read(2)
    expect(back.price).toBe(4321)
    expect(back.pocket).toBe(1)
    expect(back.battleUsage).toBe(2)
    expect(re.itemModule!.read(3).price).toBe(30) // neighbour untouched
  })

  it('renames items and keeps the name in the dropdown options', () => {
    const a = load()
    expect(a.itemModule!.setName(1, 'CLAUDE BALL')).toBe(true)
    const re = buildAdapter(new Rom('re.gba', a.rom.bytes)).adapter!
    expect(re.itemModule!.entries[1].name).toBe('CLAUDE BALL')
    expect(re.itemOptions!.find((o) => o.value === 1)!.label).toBe('CLAUDE BALL')
  })

  it('re-discovers the table after the old name anchor is renamed', () => {
    const a = load()
    // MASTER BALL / ULTRA BALL used to be the discovery signature.
    a.itemModule!.setName(1, 'AAA')
    a.itemModule!.setName(2, 'BBB')
    const re = buildAdapter(new Rom('re.gba', a.rom.bytes)).adapter!
    expect(re.itemModule).not.toBeNull()
    expect(re.regions.find((r) => r.name === 'Item data')!.offset).toBe(0x3a0000)
    expect(re.itemModule!.entries[3].name).toBe('POTION')
  })

  it('rejects names it cannot encode and leaves the old one', () => {
    const m = items()
    expect(m.setName(1, '★★★')).toBe(false)
    expect(m.setName(1, '')).toBe(false)
    expect(m.entries[1].name).toBe('MASTER BALL')
  })

  it('reverts a single item without touching its neighbours', () => {
    const a = load()
    const m = a.itemModule!
    m.write(2, 'price', 999)
    m.setName(2, 'CHANGED')
    m.write(3, 'price', 111)
    m.revert(2)
    expect(m.read(2).price).toBe(20)
    expect(m.entries[2].name).toBe('ULTRA BALL')
    expect(m.read(3).price).toBe(111) // the other edit survives
  })

  it('keeps placeholder slots addressable so later indices stay aligned', () => {
    const m = items()
    // Entry 20 carries itemId 0 in the fixture, like the real unused ids.
    expect(m.entries[20]).toBeDefined()
    expect(m.entries[21].name).toBe('ITEM21')
    expect(m.read(21).price).toBe(210)
  })
})
