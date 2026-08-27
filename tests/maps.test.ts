import { describe, expect, it } from 'vitest'
import { Rom } from '../src/core/rom'
import { buildAdapter } from '../src/core/games'
import { discoverMaps, scanBankTable } from '../src/core/gba/mapscan'
import { findOverworldSprites } from '../src/core/gba/overworld-sprites'
import { makeGen1Rom, makeGen3Rom } from './fixtures'

const loadModule = () => {
  const adapter = buildAdapter(new Rom('firered.gba', makeGen3Rom())).adapter!
  expect(adapter.mapModule).not.toBeNull()
  return adapter.mapModule!
}

const px = (img: { pixels: Uint8ClampedArray; width: number }, x: number, y: number) => {
  const o = (y * img.width + x) * 4
  return [img.pixels[o], img.pixels[o + 1], img.pixels[o + 2]]
}

describe('structural map discovery', () => {
  it('finds the bank table, groups and headers bottom-up', () => {
    const index = discoverMaps(makeGen3Rom())!
    expect(index).not.toBeNull()
    expect(index.banks).toHaveLength(2)
    expect(index.banks[0]).toHaveLength(1)
    expect(index.banks[1]).toHaveLength(1)
    expect(index.bankTableOffset).toBe(0x313100)
  })

  it('finds nothing in a ROM without map structures', () => {
    expect(discoverMaps(makeGen1Rom())).toBeNull()
  })
})

describe('Gen 3 map module', () => {
  it('lists maps with dimensions', () => {
    const m = loadModule()
    expect(m.entries).toHaveLength(2)
    expect(m.entries[0].label).toContain('4×3')
    expect(m.describe('0.0')).toEqual({ widthBlocks: 4, heightBlocks: 3, blockCount: 1024 })
  })

  it('renders blocks through both tilesets, palettes and LZ77', () => {
    const m = loadModule()
    const img = m.render('0.0')
    expect(img.width).toBe(64)
    expect(img.height).toBe(48)
    expect(px(img, 8, 8)).toEqual([255, 0, 0]) // block 0: primary tile, palette 0
    expect(px(img, 24, 8)).toEqual([0, 255, 0]) // block 1: primary tile, palette 1
    expect(px(img, 56, 8)).toEqual([0, 0, 255]) // block 640: secondary tileset, palette 7
  })

  it('renders the block picker', () => {
    const m = loadModule()
    const strip = m.renderBlocks('0.0', 8)
    expect(strip.count).toBe(1024)
    expect(strip.width).toBe(128)
    expect(px(strip, 24, 8)).toEqual([0, 255, 0]) // block 1 in slot (1,0)
  })

  it('paints blocks while preserving movement permissions', () => {
    const m = loadModule()
    expect(m.cell('0.0', 0, 1)).toEqual({ blockId: 0, permission: 1 })
    m.paint('0.0', 0, 1, 1)
    expect(m.cell('0.0', 0, 1)).toEqual({ blockId: 1, permission: 1 })
    const img = m.render('0.0')
    expect(px(img, 8, 24)).toEqual([0, 255, 0])
  })

  it('edits movement permissions while preserving the block', () => {
    const m = loadModule()
    m.setPermission('0.0', 1, 0, 5)
    expect(m.cell('0.0', 1, 0)).toEqual({ blockId: 1, permission: 5 })
  })

  it('reverts block-grid edits', () => {
    const m = loadModule()
    m.paint('0.0', 0, 0, 640)
    expect(m.cell('0.0', 0, 0).blockId).toBe(640)
    m.revertBlocks('0.0')
    expect(m.cell('0.0', 0, 0).blockId).toBe(0)
  })

  it('reads NPC, warp and sign events', () => {
    const m = loadModule()
    const ev = m.events('0.0')
    expect(ev.npcs).toEqual([{ x: 2, y: 1, elevation: 3, graphicsId: 5, movementType: 1 }])
    expect(ev.warps).toEqual([
      { x: 3, y: 2, elevation: 0, warpId: 1, targetMap: 0, targetBank: 1 },
    ])
    expect(ev.signs).toEqual([])
  })

  it('edits event fields in place', () => {
    const m = loadModule()
    m.updateEvent('0.0', 'npc', 0, 'x', 3)
    m.updateEvent('0.0', 'npc', 0, 'graphicsId', 12)
    m.updateEvent('0.0', 'warp', 0, 'targetBank', 0)
    const ev = m.events('0.0')
    expect(ev.npcs[0].x).toBe(3)
    expect(ev.npcs[0].graphicsId).toBe(12)
    expect(ev.warps[0].targetBank).toBe(0)
  })

})

describe('Gen 1 maps', () => {
  const loadGen1 = async () => {
    const { makeGen1Rom } = await import('./fixtures')
    return buildAdapter(new Rom('red.gb', makeGen1Rom())).adapter!
  }

  it('discovers headers, banks and tilesets structurally', async () => {
    const a = await loadGen1()
    const m = a.mapModule!
    expect(m).not.toBeNull()
    expect(m.entries).toHaveLength(160)
    expect(m.entries[0].label).toBe('Pallet Town')
    expect(m.describe(m.entries[0].key)).toMatchObject({ widthBlocks: 5, heightBlocks: 4 })
  })

  it('renders 2bpp blocks and paints in place', async () => {
    const a = await loadGen1()
    const m = a.mapModule!
    const key = m.entries[0].key
    const img = m.render(key)
    expect(img.width).toBe(5 * 32)
    expect(img.height).toBe(4 * 32)
    // Block (0,0) is block 0 (lightest); block (1,0) is block 1 (darkest).
    expect(img.pixels[0]).toBe(232)
    expect(img.pixels[(0 * img.width + 32) * 4]).toBe(28)
    expect(m.cell(key, 1, 0).blockId).toBe(1)

    m.paint(key, 0, 1, 1)
    expect(m.cell(key, 0, 1).blockId).toBe(1)
    const re = buildAdapter(new Rom('red.gb', a.rom.bytes)).adapter!
    expect(re.mapModule!.cell(key, 0, 1).blockId).toBe(1)
    m.revertBlocks(key)
    expect(m.cell(key, 0, 1).blockId).toBe(0)
    expect(a.rom.changedByteCount).toBe(0)

    const strip = m.renderBlocks(key, 8)
    expect(strip.count).toBeGreaterThanOrEqual(2)
    expect(strip.perRow).toBe(8)
  })

  it('reads and edits warps, signs and NPCs', async () => {
    const a = await loadGen1()
    const m = a.mapModule!
    const key = m.entries[0].key
    const ev = m.events(key)
    expect(ev.warps).toHaveLength(1)
    expect(ev.warps[0]).toMatchObject({ x: 5, y: 5, warpId: 1, targetMap: 40 })
    expect(ev.signs[0]).toMatchObject({ x: 13, y: 13, kind: 4 })
    expect(ev.npcs).toHaveLength(2) // trainer extras must not desync the walk
    expect(ev.npcs[0]).toMatchObject({ x: 8, y: 5, graphicsId: 7, movementType: 1 })
    expect(ev.npcs[1]).toMatchObject({ x: 3, y: 6, graphicsId: 9 })

    m.updateEvent(key, 'npc', 0, 'x', 12)
    m.updateEvent(key, 'warp', 0, 'targetMap', 7)
    m.updateEvent(key, 'sign', 0, 'kind', 9)
    const re = buildAdapter(new Rom('red.gb', a.rom.bytes)).adapter!
    const rev = re.mapModule!.events(key)
    expect(rev.npcs[0].x).toBe(12)
    expect(rev.warps[0].targetMap).toBe(7)
    expect(rev.signs[0].kind).toBe(9)
  })

  it('adds and removes events, relocating the object data on growth', () => {
    return loadGen1().then((a) => {
      const m = a.mapModule!
      const key = m.entries[0].key
      for (const kind of ['warp', 'sign', 'npc'] as const) {
        expect(m.addEvent(key, kind)).toBe(true)
      }
      const ev = m.events(key)
      expect(ev.warps).toHaveLength(2)
      expect(ev.signs).toHaveLength(2)
      expect(ev.npcs).toHaveLength(3)
      // Copies of the last entries — including the trainer NPC extras.
      expect(ev.warps[1]).toMatchObject({ x: 5, y: 5, targetMap: 40 })
      expect(ev.npcs[2]).toMatchObject({ x: 3, y: 6, graphicsId: 9 })
      // A fresh scan parses the relocated blob identically.
      const re = buildAdapter(new Rom('red.gb', a.rom.bytes)).adapter!
      const rev = re.mapModule!.events(key)
      expect(rev.warps).toHaveLength(2)
      expect(rev.npcs).toHaveLength(3)
      // Remove takes them back out (in place).
      m.removeEvent(key, 'warp', 1)
      m.removeEvent(key, 'sign', 1)
      m.removeEvent(key, 'npc', 2)
      const back = m.events(key)
      expect(back.warps).toHaveLength(1)
      expect(back.signs).toHaveLength(1)
      expect(back.npcs).toHaveLength(2)
      expect(back.npcs[1].graphicsId).toBe(9)
    })
  })
})

describe('Gen 2 maps', () => {
  const loadGen2 = async () => {
    const { makeGen2Rom } = await import('./fixtures')
    return buildAdapter(new Rom('crystal.gbc', makeGen2Rom())).adapter!
  }

  it('discovers groups, attributes and tilesets structurally', async () => {
    const a = await loadGen2()
    const m = a.mapModule!
    expect(m).not.toBeNull()
    expect(m.entries).toHaveLength(26 * 4) // 26 groups sharing a 4-map array
    expect(m.entries.some((e) => e.key === '3.2')).toBe(true)
    expect(m.describe('1.1')).toMatchObject({ widthBlocks: 4, heightBlocks: 3 })
  })

  it('renders lz3 tilesets in CGB colors and paints in place', async () => {
    const a = await loadGen2()
    const m = a.mapModule!
    const img = m.render('1.1')
    expect(img.width).toBe(4 * 32)
    expect(img.height).toBe(3 * 32)
    // Palette map says tile 0 = GRAY, tile 1 = BROWN; the fixture maps
    // are TOWN so the outdoor day palettes apply.
    expect(img.pixels[0]).toBe(222) // GRAY color 0 = RGB5 27,31,27
    expect(img.pixels[32 * 4]).toBe(57) // block (1,0) → tile 1 color 3 = BROWN dark
    m.paint('1.1', 0, 1, 1)
    expect(m.cell('1.1', 0, 1).blockId).toBe(1)
    const re = buildAdapter(new Rom('crystal.gbc', a.rom.bytes)).adapter!
    expect(re.mapModule!.cell('1.1', 0, 1).blockId).toBe(1)
    m.revertBlocks('1.1')
    expect(a.rom.changedByteCount).toBe(0)
  })

  it('reads and edits warps, signs and NPCs', async () => {
    const a = await loadGen2()
    const m = a.mapModule!
    const ev = m.events('1.1')
    expect(ev.warps).toHaveLength(2)
    expect(ev.warps[0]).toMatchObject({ x: 5, y: 5, warpId: 1, targetBank: 13, targetMap: 2 })
    expect(ev.warps[1]).toMatchObject({ x: 12, y: 11, targetBank: 1, targetMap: 3 })
    expect(ev.signs).toHaveLength(1)
    expect(ev.signs[0]).toMatchObject({ x: 7, y: 9, kind: 0 })
    expect(ev.npcs).toHaveLength(2)
    expect(ev.npcs[0]).toMatchObject({ x: 3, y: 8, graphicsId: 2, movementType: 0 })
    expect(ev.npcs[1]).toMatchObject({ x: 12, y: 14, graphicsId: 5, movementType: 6 })

    m.updateEvent('1.1', 'npc', 0, 'x', 9)
    m.updateEvent('1.1', 'warp', 1, 'targetMap', 4)
    m.updateEvent('1.1', 'sign', 0, 'kind', 2)
    const re = buildAdapter(new Rom('crystal.gbc', a.rom.bytes)).adapter!
    const rev = re.mapModule!.events('1.1')
    expect(rev.npcs[0].x).toBe(9)
    expect(rev.warps[1].targetMap).toBe(4)
    expect(rev.signs[0].kind).toBe(2)
  })

  it('adds and removes events, relocating the MapEvents blob on growth', async () => {
    const a = await loadGen2()
    const m = a.mapModule!
    for (const kind of ['warp', 'sign', 'npc'] as const) {
      expect(m.addEvent('1.1', kind)).toBe(true)
    }
    const ev = m.events('1.1')
    expect(ev.warps).toHaveLength(3)
    expect(ev.signs).toHaveLength(2)
    expect(ev.npcs).toHaveLength(3)
    expect(ev.warps[2]).toMatchObject({ x: 12, y: 11, targetBank: 1, targetMap: 3 })
    expect(ev.npcs[2]).toMatchObject({ x: 12, y: 14, graphicsId: 5, movementType: 6 })
    const re = buildAdapter(new Rom('crystal.gbc', a.rom.bytes)).adapter!
    expect(re.mapModule!.events('1.1').npcs).toHaveLength(3)
    m.removeEvent('1.1', 'warp', 2)
    m.removeEvent('1.1', 'sign', 1)
    m.removeEvent('1.1', 'npc', 2)
    const back = m.events('1.1')
    expect(back.warps).toHaveLength(2)
    expect(back.signs).toHaveLength(1)
    expect(back.npcs).toHaveLength(2)
  })

  it('counts the maps a bank stopped short of', () => {
    // scanBankTable only needs the verified header set, so the pointers
    // can be laid out by hand: two banks, the first holding two map
    // slots of which the second header is not verified.
    const bytes = new Uint8Array(0x400)
    const ptr = (at: number, target: number) => {
      bytes[at] = target & 0xff
      bytes[at + 1] = (target >> 8) & 0xff
      bytes[at + 2] = (target >> 16) & 0xff
      bytes[at + 3] = 0x08
    }
    ptr(0x200, 0x100) // bank 0, map 0 - verified
    ptr(0x204, 0x110) // bank 0, map 1 - not in the header set
    ptr(0x208, 0x120) // bank 1, map 0 - verified
    ptr(0x300, 0x200) // the bank table
    ptr(0x304, 0x208)

    const index = scanBankTable(bytes, new Set([0x100, 0x120]))!
    expect(index).not.toBeNull()
    expect(index.banks.map((b) => b.length)).toEqual([1, 1])
    // The gap between where bank 0 stopped and where bank 1 starts is
    // the map the editor cannot show.
    expect(index.skippedMaps).toBe(1)

    ptr(0x204, 0x110)
    expect(scanBankTable(bytes, new Set([0x100, 0x110, 0x120]))!.skippedMaps).toBe(0)
  })
})

describe('overworld sprites', () => {
  it('finds the table across the hole a partial build leaves', () => {
    // Graphics infos, a pointer table that uses them, and a run of
    // nulls in the middle - the shape left behind when a build compiles
    // some of the object events out.
    const bytes = new Uint8Array(0x8000)
    const write = (at: number, values: number[] | Uint8Array) => bytes.set(values, at)
    const ptr = (target: number) => [target & 0xff, (target >> 8) & 0xff, (target >> 16) & 0xff, 0x08]
    const u16 = (v: number) => [v & 0xff, v >> 8]

    // One 16x32 frame of solid colour 1, and a palette whose colour 1
    // is pure red.
    write(0x1000, new Uint8Array(256).fill(0x11))
    write(0x1400, [...ptr(0x1000), ...u16(256), 0, 0]) // SpriteFrameImage
    write(0x1500, [...u16(0), ...u16(0x001f)]) // transparent, then red
    write(0x1600, [...ptr(0x1500), ...u16(0x1103), 0, 0]) // {palette, tag}
    write(0x1608, [...ptr(0x1500), ...u16(0x1104), 0, 0])
    write(0x1610, [...ptr(0x1500), ...u16(0x1105), 0, 0])

    const COUNT = 40
    for (let i = 0; i < COUNT; i++) {
      const at = 0x2000 + i * 0x40
      write(at, [...u16(0xffff), ...u16(0x1103), ...u16(0xffff), ...u16(256)])
      write(at + 8, [...u16(16), ...u16(32), 0, 0])
      write(at + 0x1c, ptr(0x1400))
    }

    const table = 0x6000
    for (let i = 0; i < COUNT; i++) write(table + i * 4, ptr(0x2000 + i * 0x40))
    // 100 empty ids, then one more real entry on the far side of them.
    const far = table + (COUNT + 100) * 4
    write(far, ptr(0x2000))

    const sprites = findOverworldSprites(bytes)!
    expect(sprites).not.toBeNull()
    expect(sprites.tableOffset).toBe(table)
    expect(sprites.count).toBe(COUNT + 101)
    expect(sprites.paletteFor(0x1103)).toBe(0x1500)

    const img = sprites.render(0)!
    expect([img.width, img.height]).toEqual([16, 32])
    // Every pixel is colour 1, which the palette makes opaque red.
    expect([...img.pixels.slice(0, 4)]).toEqual([255, 0, 0, 255])
    // An id inside the hole has no sprite rather than a wrong one.
    expect(sprites.render(COUNT + 5)).toBeNull()
  })
})
